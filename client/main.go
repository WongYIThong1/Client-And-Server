package main

import (
	"bufio"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

const (
	serverURL = "ws://localhost:5000"
	// 如果使用WSS，取消注释下面这行并注释上面那行
	// serverURL = "wss://localhost:5000"
)

var (
	accessToken     string
	refreshToken    string
	isAuthenticated bool
)

// 消息结构
type Message struct {
	Type         string      `json:"type"`
	APIKey       string      `json:"apiKey,omitempty"`
	AccessToken  string      `json:"accessToken,omitempty"`
	RefreshToken string      `json:"refreshToken,omitempty"`
	Message      string      `json:"message,omitempty"`
	Data         interface{} `json:"data,omitempty"`
}

// 显示ASCII艺术字
func displayBanner() {
	banner := `
░██████╗░██████╗░██╗░░░░░██████╗░░█████╗░████████╗░██████╗
██╔════╝██╔═══██╗██║░░░░░██╔══██╗██╔══██╗╚══██╔══╝██╔════╝
╚█████╗░██║██╗██║██║░░░░░██████╦╝██║░░██║░░░██║░░░╚█████╗░
░╚═══██╗╚██████╔╝██║░░░░░██╔══██╗██║░░██║░░░██║░░░░╚═══██╗
██████╔╝░╚═██╔═╝░███████╗██████╦╝╚█████╔╝░░░██║░░░██████╔╝
╚═════╝░░░░╚═╝░░░╚══════╝╚═════╝░░╚════╝░░░░╚═╝░░░╚═════╝░
 [1.0 Version]
`
	fmt.Print(banner)
}

// 连接WebSocket服务器
func connectToServer() (*websocket.Conn, error) {
	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
	}

	// 如果使用WSS，配置TLS（跳过证书验证仅用于开发）
	if strings.HasPrefix(serverURL, "wss://") {
		dialer.TLSClientConfig = &tls.Config{
			InsecureSkipVerify: true, // 仅用于开发，生产环境应验证证书
		}
	}

	conn, _, err := dialer.Dial(serverURL, nil)
	if err != nil {
		return nil, fmt.Errorf("连接失败: %v", err)
	}

	return conn, nil
}

// 读取用户输入的API Key
func readAPIKey() string {
	reader := bufio.NewReader(os.Stdin)
	fmt.Print("APIKey : ")
	apiKey, err := reader.ReadString('\n')
	if err != nil {
		log.Fatal("读取输入失败:", err)
	}
	return strings.TrimSpace(apiKey)
}

// 发送消息
func sendMessage(conn *websocket.Conn, msg Message) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("序列化消息失败: %v", err)
	}
	return conn.WriteMessage(websocket.TextMessage, data)
}

// 处理接收到的消息
func handleMessage(conn *websocket.Conn, message []byte) {
	var msg Message
	if err := json.Unmarshal(message, &msg); err != nil {
		log.Printf("解析消息失败: %v", err)
		return
	}

	switch msg.Type {
	case "auth_success":
		accessToken = msg.AccessToken
		refreshToken = msg.RefreshToken
		isAuthenticated = true
		fmt.Println("\n✓ 认证成功！")
		tokenPreviewLen := 20
		if len(accessToken) < tokenPreviewLen {
			tokenPreviewLen = len(accessToken)
		}
		fmt.Printf("Access Token (15分钟有效): %s...\n", accessToken[:tokenPreviewLen])
		if len(refreshToken) < tokenPreviewLen {
			tokenPreviewLen = len(refreshToken)
		} else {
			tokenPreviewLen = 20
		}
		fmt.Printf("Refresh Token (7天有效): %s...\n", refreshToken[:tokenPreviewLen])
		fmt.Println("已连接到服务器，等待实时数据更新...")

	case "auth_failed":
		fmt.Printf("\n✗ 认证失败: %s\n", msg.Message)
		fmt.Println("请检查您的API Key是否正确")

	case "token_refreshed":
		accessToken = msg.AccessToken
		if msg.RefreshToken != "" {
			refreshToken = msg.RefreshToken
		}
		fmt.Println("\n[Token已自动刷新]")

	case "ping":
		// 响应心跳
		pongMsg := Message{Type: "pong"}
		if err := sendMessage(conn, pongMsg); err != nil {
			log.Printf("发送pong失败: %v", err)
		}

	case "data":
		// 处理实时数据更新
		fmt.Printf("\n[实时数据] %s\n", msg.Message)
		if msg.Data != nil {
			fmt.Printf("数据内容: %v\n", msg.Data)
		}

	case "error":
		fmt.Printf("\n[错误] %s\n", msg.Message)

	default:
		fmt.Printf("\n[未知消息类型] %s\n", msg.Type)
	}
}

func main() {
	// 显示ASCII艺术字
	displayBanner()

	// 尝试连接服务器
	fmt.Println("正在连接到服务器...")
	conn, err := connectToServer()
	if err != nil {
		log.Fatalf("无法连接到服务器: %v\n请确保服务器正在运行在 %s", err, serverURL)
	}
	defer conn.Close()

	fmt.Println("Connected To Server")
	fmt.Println()

	// 读取API Key
	apiKey := readAPIKey()
	if apiKey == "" {
		log.Fatal("API Key不能为空")
	}

	// 发送认证请求
	authMsg := Message{
		Type:   "auth",
		APIKey: apiKey,
	}

	if err := sendMessage(conn, authMsg); err != nil {
		log.Fatalf("发送认证请求失败: %v", err)
	}

	// 设置读取超时
	conn.SetReadDeadline(time.Now().Add(60 * time.Second))

	// 启动消息接收goroutine
	messageChan := make(chan []byte, 256)
	errorChan := make(chan error, 1)

	go func() {
		for {
			_, message, err := conn.ReadMessage()
			if err != nil {
				errorChan <- err
				return
			}
			messageChan <- message
		}
	}()

	// 主循环：处理消息和心跳
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case message := <-messageChan:
			// 重置读取超时
			conn.SetReadDeadline(time.Now().Add(60 * time.Second))
			handleMessage(conn, message)

		case err := <-errorChan:
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("WebSocket错误: %v", err)
			}
			return

		case <-ticker.C:
			// 定期检查连接状态和token刷新
			if isAuthenticated && refreshToken != "" {
				// 可以在这里实现自动刷新token的逻辑
				// 当前由服务器端自动处理token过期
			}
		}
	}
}
