package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"websocket-client/auth"
	"websocket-client/connection"
	"websocket-client/utils"

	"github.com/gorilla/websocket"
)

func main() {
	// 允许通过命令行或环境变量覆盖默认服务端地址（默认生产网关）
	serverFlag := flag.String("server", "", "WebSocket server URL (default wss://api.sqlbots.online)")
	flag.Parse()

	serverURL := strings.TrimSpace(*serverFlag)
	if envURL := strings.TrimSpace(os.Getenv("SERVER_URL")); serverURL == "" && envURL != "" {
		serverURL = envURL
	}
	if serverURL != "" {
		connection.ServerURL = serverURL
	}

	utils.DisplayBanner()

	conn, err := connection.ConnectToServer()
	if err != nil {
		log.Fatalf("Could not connect: %v", err)
	}

	// 当前活跃连接（会在重连后替换）
	var currentConn *websocket.Conn = conn

	// 优雅退出：已认证则先发 disconnect
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-signals
		if connection.IsAuthenticated() {
			_ = connection.SendMessage(currentConn, connection.Message{Type: "disconnect"})
		}
		currentConn.Close()
		os.Exit(0)
	}()

	fmt.Println("Connected To Server")

	// 单读协程 + 心跳
	messageChan := make(chan []byte, 256)
	errorChan := make(chan error, 1)

	// 用于控制 goroutine 的 stop channel
	type connControl struct {
		readStop  chan struct{}
		pingStop  chan struct{}
		cancelled bool
	}

	var currentControl *connControl

	startReadLoop := func(conn *websocket.Conn, control *connControl) {
		conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		conn.SetPongHandler(func(string) error {
			conn.SetReadDeadline(time.Now().Add(90 * time.Second))
			return nil
		})
		go func(c *websocket.Conn, stopCh chan struct{}) {
			for {
				select {
				case <-stopCh:
					return
				default:
					_, message, err := c.ReadMessage()
					if err != nil {
						select {
						case errorChan <- err:
						case <-stopCh:
							return
						}
						return
					}
					select {
					case messageChan <- message:
					case <-stopCh:
						return
					}
				}
			}
		}(conn, control.readStop)
	}

	startPingLoop := func(conn *websocket.Conn, control *connControl) {
		go func(c *websocket.Conn, stopCh chan struct{}) {
			ticker := time.NewTicker(30 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-ticker.C:
					c.SetWriteDeadline(time.Now().Add(10 * time.Second))
					if err := c.WriteMessage(websocket.PingMessage, nil); err != nil {
						select {
						case errorChan <- err:
						case <-stopCh:
							return
						}
						return
					}
				case <-stopCh:
					return
				}
			}
		}(conn, control.pingStop)
	}

	// 停止旧的连接控制
	stopOldConnection := func() {
		if currentControl != nil && !currentControl.cancelled {
			currentControl.cancelled = true
			close(currentControl.readStop)
			close(currentControl.pingStop)
		}
	}

	currentControl = &connControl{
		readStop: make(chan struct{}),
		pingStop: make(chan struct{}),
	}
	startReadLoop(currentConn, currentControl)
	startPingLoop(currentConn, currentControl)

	var apiKey string
	savedKey, err := auth.LoadAPIKey()
	if err != nil {
		log.Printf("Failed to read saved API Key: %v", err)
	}
	if savedKey != "" {
		apiKey = savedKey
		fmt.Println("Loaded API Key from local storage")
	} else {
		apiKey = auth.ReadAPIKey()
	}
	if apiKey == "" {
		log.Fatal("API Key cannot be empty")
	}

	// 首次发送鉴权
	if currentConn != nil {
		currentConn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if err := connection.SendMessage(currentConn, connection.Message{Type: "auth", APIKey: apiKey}); err != nil {
			log.Fatalf("Failed to send auth message: %v", err)
		}
		currentConn.SetWriteDeadline(time.Time{})
	} else {
		log.Fatal("Connection is nil")
	}

	messageHandler := connection.SetupMessageHandler()

	// 重连逻辑：新建连接并重新鉴权，返回新连接和控制结构
	reconnect := func() (*websocket.Conn, *connControl, error) {
		fmt.Printf("\n%s[Reconnecting]%s Attempting to reconnect...%s\n", utils.ColorYellow, utils.ColorBold, utils.ColorReset)
		newConn, err := connection.ConnectToServer()
		if err != nil {
			return nil, nil, err
		}

		// 创建新的控制结构
		newControl := &connControl{
			readStop: make(chan struct{}),
			pingStop: make(chan struct{}),
		}

		// 启动新的读取和心跳循环
		startReadLoop(newConn, newControl)
		startPingLoop(newConn, newControl)

		if apiKey != "" {
			if err := connection.SendMessage(newConn, connection.Message{Type: "auth", APIKey: apiKey}); err != nil {
				newControl.cancelled = true
				close(newControl.readStop)
				close(newControl.pingStop)
				newConn.Close()
				return nil, nil, fmt.Errorf("failed to re-authenticate: %v", err)
			}
			fmt.Printf("%s[Reconnected]%s Re-authentication sent%s\n", utils.ColorGreen, utils.ColorBold, utils.ColorReset)
		}

		return newConn, newControl, nil
	}

	// 退出前关闭连接
	defer func() {
		stopOldConnection()
		if currentConn != nil {
			currentConn.Close()
		}
	}()


	for {
		select {
		case message := <-messageChan:
			// 处理消息后检查是否应该退出（machine_deleted消息会设置shouldExit）
			connection.HandleMessage(currentConn, message, messageHandler)

			if connection.ShouldExit() {
				fmt.Println("Exiting due to machine deletion...")
				os.Exit(1)
			}

			// 如果在等待重连后的认证成功，并且认证成功，发送系统信息

			if connection.IsAuthenticated() && savedKey == "" {
				if err := auth.SaveAPIKey(apiKey); err != nil {
					log.Printf("Failed to save API Key: %v", err)
				} else {
					savedKey = apiKey
					fmt.Println("[API Key saved]")
				}
			}

		case err := <-errorChan:
			// 检查是否应该退出（例如收到machine_deleted消息）
			if connection.ShouldExit() {
				fmt.Println("Exiting due to machine deletion...")
				os.Exit(1)
			}

			fmt.Printf("%s[Connection issue]%s %v%s\n", utils.ColorYellow, utils.ColorBold, err, utils.ColorReset)

			// 停止旧的连接和控制结构
			stopOldConnection()
			if currentConn != nil {
				currentConn.Close()
			}

			newConn, newControl, reconnectErr := reconnect()
			if reconnectErr != nil {
				log.Printf("Failed to reconnect: %v", reconnectErr)
				time.Sleep(5 * time.Second)
				continue
			}

			currentConn = newConn
			currentControl = newControl
				
			// 更新连接管理器中的连接引用（用于运行中的任务）
			connection.SetCurrentConnection(newConn)

			fmt.Printf("%s[Reconnected]%s Connection restored%s\n", utils.ColorGreen, utils.ColorBold, utils.ColorReset)
		}
	}
}
