package main

import (
	"bufio"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log"
	"math"
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

// Server URL (switch to wss://api.sqlbots.online for TLS)
const serverURL = "ws://api.sqlbots.online"

// ANSI colors for friendly CLI output
const (
	colorReset  = "\033[0m"
	colorRed    = "\033[31m"
	colorGreen  = "\033[32m"
	colorYellow = "\033[33m"
	colorBlue   = "\033[34m"
	colorCyan   = "\033[36m"
	colorBold   = "\033[1m"
)

var (
	accessToken     string
	refreshToken    string
	isAuthenticated bool
)

// Wire protocol payload
type Message struct {
	Type         string      `json:"type"`
	APIKey       string      `json:"apiKey,omitempty"`
	AccessToken  string      `json:"accessToken,omitempty"`
	RefreshToken string      `json:"refreshToken,omitempty"`
	Message      string      `json:"message,omitempty"`
	Data         interface{} `json:"data,omitempty"`
	IP           string      `json:"ip,omitempty"`
	RAM          string      `json:"ram,omitempty"`
	CPUCores     int         `json:"cpuCores,omitempty"`
	MachineName  string      `json:"machineName,omitempty"`
}

func displayBanner() {
	ascii := `
   _____  ____  _     ____        _        
  / ____|/ __ \| |   / __ \      | |       
 | (___ | |  | | | _| |  | |_   _| | ___   
  \___ \| |  | | |/ / |  | | | | | |/ _ \  
  ____) | |__| |   <| |__| | |_| | |  __/  
 |_____/ \____/|_|\_\\____/ \__,_|_|\___|  
`
	fmt.Printf("%s%s%s%s\n", colorCyan, colorBold, ascii, colorReset)
}

func connectToServerOnce() (*websocket.Conn, error) {
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	if strings.HasPrefix(serverURL, "wss://") {
		dialer.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}
	conn, _, err := dialer.Dial(serverURL, nil)
	if err != nil {
		return nil, fmt.Errorf("connection failed: %v", err)
	}
	return conn, nil
}

func connectToServer() (*websocket.Conn, error) {
	const maxRetries = 3
	var conn *websocket.Conn
	var err error
	for attempt := 1; attempt <= maxRetries; attempt++ {
		fmt.Printf("%s[%s]%s Connecting to server (%d/%d)...%s\n", colorYellow, colorBold, colorReset, attempt, maxRetries, colorReset)
		conn, err = connectToServerOnce()
		if err == nil {
			if attempt > 1 {
				fmt.Printf("%s[%s]%s Reconnected after %d attempts%s\n", colorGreen, colorBold, colorReset, attempt, colorReset)
			}
			return conn, nil
		}
		fmt.Printf("%s[%s]%s %v%s\n", colorRed, colorBold, colorReset, err, colorReset)
		if attempt < maxRetries {
			wait := time.Duration(attempt) * 2 * time.Second
			fmt.Printf("%s[%s]%s Retry in %v...%s\n", colorYellow, colorBold, colorReset, wait, colorReset)
			time.Sleep(wait)
		}
	}
	return nil, fmt.Errorf("failed to connect after %d attempts to %s", maxRetries, serverURL)
}

func getAPIKeyPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, ".websocket-client")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	return filepath.Join(dir, "apikey.txt"), nil
}

func saveAPIKey(apiKey string) error {
	path, err := getAPIKeyPath()
	if err != nil {
		return err
	}
	return os.WriteFile(path, []byte(apiKey), 0600)
}

func loadAPIKey() (string, error) {
	path, err := getAPIKeyPath()
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}

func deleteAPIKey() error {
	path, err := getAPIKeyPath()
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func readAPIKey() string {
	reader := bufio.NewReader(os.Stdin)
	fmt.Print("APIKey : ")
	apiKey, err := reader.ReadString('\n')
	if err != nil {
		log.Fatalf("failed to read API Key: %v", err)
	}
	return strings.TrimSpace(apiKey)
}

func getLocalIP() string {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return "unknown"
	}
	defer conn.Close()
	return conn.LocalAddr().(*net.UDPAddr).IP.String()
}

func getRAMInfo() string {
	vm, err := mem.VirtualMemory()
	if err != nil {
		return "unknown"
	}
	totalGiB := float64(vm.Total) / 1024 / 1024 / 1024
	roundedGB := int(math.Round(totalGiB))
	return fmt.Sprintf("%.2f GiB (~%d GB)", totalGiB, roundedGB)
}

func getCPUCores() int {
	return runtime.NumCPU()
}

func getMachineName() string {
	name, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return name
}

func getSystemInfo() (string, string, int, string) {
	return getLocalIP(), getRAMInfo(), getCPUCores(), getMachineName()
}

func sendMessage(conn *websocket.Conn, msg Message) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("encode message failed: %v", err)
	}
	return conn.WriteMessage(websocket.TextMessage, data)
}

// Handle messages from server
func handleMessage(conn *websocket.Conn, message []byte) {
	var msg Message
	if err := json.Unmarshal(message, &msg); err != nil {
		log.Printf("failed to parse message: %v", err)
		return
	}

	switch msg.Type {
	case "auth_success":
		accessToken = msg.AccessToken
		refreshToken = msg.RefreshToken
		isAuthenticated = true
		fmt.Printf("\n%s%sAuthenticated%s\n", colorGreen, colorBold, colorReset)
		preview := 20
		if len(accessToken) < preview {
			preview = len(accessToken)
		}
		fmt.Printf("Access Token (15m): %s...\n", accessToken[:preview])
		preview = 20
		if len(refreshToken) < preview {
			preview = len(refreshToken)
		}
		fmt.Printf("Refresh Token (7d): %s...\n", refreshToken[:preview])
		fmt.Println("Ready for data exchange...")

		ip, ram, cores, machineName := getSystemInfo()
		systemInfoMsg := Message{
			Type:        "system_info",
			IP:          ip,
			RAM:         ram,
			CPUCores:    cores,
			MachineName: machineName,
		}
		if err := sendMessage(conn, systemInfoMsg); err != nil {
			log.Printf("failed to send system info: %v", err)
		} else {
			fmt.Printf("\n[System info sent] IP: %s, RAM: %s, CPU cores: %d, Hostname: %s\n", ip, ram, cores, machineName)
		}

	case "system_info_received":
		fmt.Println("[Server acknowledged system info]")

	case "disconnect_ack":
		fmt.Println("[Server confirmed disconnect]")

	case "auth_failed":
		fmt.Printf("\nAuth failed: %s\n", msg.Message)
		fmt.Println("API Key invalid. Please re-enter.")
		if err := deleteAPIKey(); err != nil {
			log.Printf("Failed to delete local API Key: %v", err)
		} else {
			fmt.Println("[Local API Key removed]")
		}

	case "token_refreshed":
		accessToken = msg.AccessToken
		if msg.RefreshToken != "" {
			refreshToken = msg.RefreshToken
		}
		fmt.Println("\n[Tokens refreshed]")

	case "data":
		fmt.Printf("\n[Data received] %s\n", msg.Message)
		if msg.Data != nil {
			fmt.Printf("Payload: %v\n", msg.Data)
		}

	case "error":
		fmt.Printf("\n[Error] %s\n", msg.Message)

	default:
		fmt.Printf("\n[Unknown message type] %s\n", msg.Type)
	}
}

func main() {
	displayBanner()

	conn, err := connectToServer()
	if err != nil {
		log.Fatalf("Could not connect: %v", err)
	}
	defer conn.Close()

	// Graceful shutdown: send disconnect when possible
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-signals
		if isAuthenticated {
			_ = sendMessage(conn, Message{Type: "disconnect"})
		}
		conn.Close()
		os.Exit(0)
	}()

	fmt.Println("Connected To Server")

	var apiKey string
	savedKey, err := loadAPIKey()
	if err != nil {
		log.Printf("Failed to read saved API Key: %v", err)
	}
	if savedKey != "" {
		apiKey = savedKey
		fmt.Println("Loaded API Key from local storage")
	} else {
		apiKey = readAPIKey()
	}
	if apiKey == "" {
		log.Fatal("API Key cannot be empty")
	}

	// Send auth
	if err := sendMessage(conn, Message{Type: "auth", APIKey: apiKey}); err != nil {
		log.Fatalf("Failed to send auth message: %v", err)
	}

	// Defer saving until auth_success
	conn.SetReadDeadline(time.Now().Add(60 * time.Second))

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

	for {
		select {
		case message := <-messageChan:
			conn.SetReadDeadline(time.Now().Add(60 * time.Second))
			handleMessage(conn, message)
			if isAuthenticated && savedKey == "" {
				if err := saveAPIKey(apiKey); err != nil {
					log.Printf("Failed to save API Key: %v", err)
				} else {
					savedKey = apiKey
					fmt.Println("[API Key saved]")
				}
			}

		case err := <-errorChan:
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("WebSocket error: %v", err)
			}
			return
		}
	}
}
