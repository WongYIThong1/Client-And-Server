package main

import (
	"bufio"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/shirou/gopsutil/v3/mem"
)

const (
	// 服务器地址：通过域名连接，nginx会代理到后端
	// 注意：不要使用IP地址或指定5000端口，应通过域名和标准端口（80/443）连接
	serverURL = "ws://api.sqlbots.online"
	// 如果使用WSS（HTTPS），取消注释下面这行并注释上面那行
	// serverURL = "wss://api.sqlbots.online"
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
	// System info fields
	IP          string `json:"ip,omitempty"`
	RAM         string `json:"ram,omitempty"`
	CPUCores    int    `json:"cpuCores,omitempty"`
	MachineName string `json:"machineName,omitempty"`
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

// 连接WebSocket服务器（单次尝试）
func connectToServerOnce() (*websocket.Conn, error) {
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

// 连接WebSocket服务器（带重试机制，最多尝试3次）
func connectToServer() (*websocket.Conn, error) {
	const maxRetries = 3
	var conn *websocket.Conn
	var err error

	for attempt := 1; attempt <= maxRetries; attempt++ {
		fmt.Printf("正在尝试连接服务器 (第 %d/%d 次)...\n", attempt, maxRetries)

		conn, err = connectToServerOnce()
		if err == nil {
			// 连接成功
			if attempt > 1 {
				fmt.Printf("连接成功！(第 %d 次尝试)\n", attempt)
			}
			return conn, nil
		}

		// 连接失败
		fmt.Printf("连接失败: %v\n", err)

		// 如果不是最后一次尝试，等待后重试
		if attempt < maxRetries {
			waitTime := time.Duration(attempt) * 2 * time.Second // 递增等待时间：2秒、4秒
			fmt.Printf("等待 %v 后重试...\n", waitTime)
			time.Sleep(waitTime)
		}
	}

	// 所有尝试都失败了
	return nil, fmt.Errorf("连接失败：已尝试 %d 次，均未成功连接到服务器 %s", maxRetries, serverURL)
}

// 获取API Key保存路径
func getAPIKeyPath() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	// 保存到用户目录下的隐藏文件
	configDir := filepath.Join(homeDir, ".websocket-client")
	// 确保目录存在
	if err := os.MkdirAll(configDir, 0700); err != nil {
		return "", err
	}
	return filepath.Join(configDir, "apikey.txt"), nil
}

// 保存API Key到文件
func saveAPIKey(apiKey string) error {
	filePath, err := getAPIKeyPath()
	if err != nil {
		return fmt.Errorf("获取保存路径失败: %v", err)
	}

	// 使用0600权限（仅所有者可读写）
	return os.WriteFile(filePath, []byte(apiKey), 0600)
}

// 读取保存的API Key
func loadAPIKey() (string, error) {
	filePath, err := getAPIKeyPath()
	if err != nil {
		return "", err
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil // 文件不存在，返回空字符串
		}
		return "", err
	}

	return strings.TrimSpace(string(data)), nil
}

// 删除保存的API Key
func deleteAPIKey() error {
	filePath, err := getAPIKeyPath()
	if err != nil {
		return err
	}

	if err := os.Remove(filePath); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
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

// 获取本地IP地址
func getLocalIP() string {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return "unknown"
	}
	defer conn.Close()

	localAddr := conn.LocalAddr().(*net.UDPAddr)
	return localAddr.IP.String()
}

// 获取系统内存信息（GB）
func getRAMInfo() string {
	vmStat, err := mem.VirtualMemory()
	if err != nil {
		// 如果获取失败，返回未知
		return "unknown"
	}
	// 返回总内存（转换为GB）
	totalGB := float64(vmStat.Total) / 1024 / 1024 / 1024
	return fmt.Sprintf("%.2f GB", totalGB)
}

// 获取CPU核心数
func getCPUCores() int {
	return runtime.NumCPU()
}

// 获取电脑名字
func getMachineName() string {
	hostname, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return hostname
}

// 获取系统信息
func getSystemInfo() (string, string, int, string) {
	ip := getLocalIP()
	ram := getRAMInfo()
	cores := getCPUCores()
	machineName := getMachineName()
	return ip, ram, cores, machineName
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

		// 立即发送系统信息心跳包
		ip, ram, cores, machineName := getSystemInfo()
		systemInfoMsg := Message{
			Type:        "system_info",
			IP:          ip,
			RAM:         ram,
			CPUCores:    cores,
			MachineName: machineName,
		}
		if err := sendMessage(conn, systemInfoMsg); err != nil {
			log.Printf("发送系统信息失败: %v", err)
		} else {
			fmt.Printf("\n[系统信息已发送] IP: %s, RAM: %s, CPU核心数: %d, 电脑名字: %s\n", ip, ram, cores, machineName)
		}

	case "system_info_received":
		fmt.Println("[服务器已接收系统信息]")

	case "heartbeat_received":
		// 静默处理，不显示消息（避免刷屏）

	case "disconnect_ack":
		fmt.Println("[服务器已确认断开连接]")

	case "auth_failed":
		fmt.Printf("\n✗ 认证失败: %s\n", msg.Message)
		fmt.Println("请检查您的API Key是否正确")
		// 认证失败时，删除保存的API Key
		if err := deleteAPIKey(); err != nil {
			log.Printf("删除保存的API Key失败: %v", err)
		} else {
			fmt.Println("[已清除保存的API Key]")
		}

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

	// 尝试连接服务器（带重试机制，最多3次）
	conn, err := connectToServer()
	if err != nil {
		log.Fatalf("\n无法连接到服务器: %v\n请确保服务器正在运行在 %s", err, serverURL)
	}
	defer conn.Close()

	fmt.Println("Connected To Server")
	fmt.Println()

	// 尝试加载保存的API Key
	var apiKey string
	savedAPIKey, err := loadAPIKey()
	if err != nil {
		log.Printf("读取保存的API Key失败: %v", err)
	}

	if savedAPIKey != "" {
		// 自动使用保存的API Key
		apiKey = savedAPIKey
		fmt.Println("使用保存的API Key进行自动登录...")
	} else {
		// 没有保存的API Key，提示用户输入
		apiKey = readAPIKey()
	}

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

	// 保存API Key（在发送认证请求后保存）
	// 如果认证失败，会在auth_failed处理中删除
	if err := saveAPIKey(apiKey); err != nil {
		log.Printf("保存API Key失败: %v", err)
	} else {
		fmt.Println("[API Key已保存，下次启动将自动使用]")
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

	// 设置信号处理，捕获中断信号（Ctrl+C）
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	// 主循环：处理消息和心跳
	// 每10分钟发送一次heartbeat
	heartbeatTicker := time.NewTicker(10 * time.Minute)
	defer heartbeatTicker.Stop()

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

		case <-sigChan:
			// 收到中断信号，优雅关闭
			fmt.Println("\n[收到关闭信号，正在优雅断开连接...]")
			if isAuthenticated {
				// 发送disconnect消息
				disconnectMsg := Message{
					Type: "disconnect",
				}
				if err := sendMessage(conn, disconnectMsg); err != nil {
					log.Printf("发送断开消息失败: %v", err)
				} else {
					fmt.Println("[断开消息已发送，等待服务器确认...]")
					// 等待一小段时间让服务器处理
					time.Sleep(500 * time.Millisecond)
				}
			}
			conn.Close()
			return

		case <-heartbeatTicker.C:
			// 每10分钟发送一次heartbeat
			if isAuthenticated {
				heartbeatMsg := Message{
					Type: "heartbeat",
				}
				if err := sendMessage(conn, heartbeatMsg); err != nil {
					log.Printf("发送心跳包失败: %v", err)
				} else {
					fmt.Println("\n[心跳包已发送]")
				}
			}
		}
	}
}
