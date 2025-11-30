package main

import (
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"websocket-client/auth"
	"websocket-client/connection"
	"websocket-client/utils"

	"github.com/gorilla/websocket"
)

func main() {
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

	startReadLoop := func(conn *websocket.Conn) {
		conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		conn.SetPongHandler(func(string) error {
			conn.SetReadDeadline(time.Now().Add(90 * time.Second))
			return nil
		})
		go func(c *websocket.Conn) {
			for {
				_, message, err := c.ReadMessage()
				if err != nil {
					errorChan <- err
					return
				}
				messageChan <- message
			}
		}(conn)
	}

	startPingLoop := func(conn *websocket.Conn, stop <-chan struct{}) {
		go func(c *websocket.Conn, stopCh <-chan struct{}) {
			ticker := time.NewTicker(30 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-ticker.C:
					c.SetWriteDeadline(time.Now().Add(10 * time.Second))
					if err := c.WriteMessage(websocket.PingMessage, nil); err != nil {
						errorChan <- err
						return
					}
				case <-stopCh:
					return
				}
			}
		}(conn, stop)
	}

	pingStop := make(chan struct{})
	startReadLoop(currentConn)
	startPingLoop(currentConn, pingStop)

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

	// 重连逻辑：新建连接并重新鉴权，返回新连接
	reconnect := func() (*websocket.Conn, error) {
		fmt.Printf("\n%s[Reconnecting]%s Attempting to reconnect...%s\n", utils.ColorYellow, utils.ColorBold, utils.ColorReset)
		newConn, err := connection.ConnectToServer()
		if err != nil {
			return nil, err
		}

		if apiKey != "" {
			if err := connection.SendMessage(newConn, connection.Message{Type: "auth", APIKey: apiKey}); err != nil {
				newConn.Close()
				return nil, fmt.Errorf("failed to re-authenticate: %v", err)
			}
			fmt.Printf("%s[Reconnected]%s Re-authentication sent%s\n", utils.ColorGreen, utils.ColorBold, utils.ColorReset)
		}

		startReadLoop(newConn)
		return newConn, nil
	}

	// 退出前关闭连接
	defer func() {
		if currentConn != nil {
			currentConn.Close()
		}
	}()

	for {
		select {
		case message := <-messageChan:
			connection.HandleMessage(conn, message, messageHandler)
			if connection.IsAuthenticated() && savedKey == "" {
				if err := auth.SaveAPIKey(apiKey); err != nil {
					log.Printf("Failed to save API Key: %v", err)
				} else {
					savedKey = apiKey
					fmt.Println("[API Key saved]")
				}
			}

		case err := <-errorChan:
			fmt.Printf("%s[Connection issue]%s %v%s\n", utils.ColorYellow, utils.ColorBold, err, utils.ColorReset)

			select {
			case <-pingStop:
				// 已经关闭
			default:
				close(pingStop)
			}
			currentConn.Close()

			newConn, reconnectErr := reconnect()
			if reconnectErr != nil {
				log.Printf("Failed to reconnect: %v", reconnectErr)
				time.Sleep(5 * time.Second)
				continue
			}

			currentConn = newConn
			conn = newConn
			pingStop = make(chan struct{})
			startPingLoop(currentConn, pingStop)

			fmt.Printf("%s[Reconnected]%s Connection restored%s\n", utils.ColorGreen, utils.ColorBold, utils.ColorReset)
		}
	}
}
