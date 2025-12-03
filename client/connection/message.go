package connection

import (
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// writeMutex 保护所有 WebSocket 写入操作的互斥锁
// WebSocket 连接不是线程安全的，所有写入操作（WriteMessage, WriteControl）都必须通过此锁保护
var writeMutex sync.Mutex

// Message WebSocket 消息结构
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
	HWID         string      `json:"hwid,omitempty"`

	// Task dispatch fields (from server)
	TaskID         string   `json:"taskId,omitempty"`
	TaskName       string   `json:"name,omitempty"`
	ListFile       string   `json:"listFile,omitempty"`
	ProxyFile      string   `json:"proxyFile,omitempty"`
	Domains        []string `json:"domains,omitempty"`
	CompletedCount int      `json:"completedCount,omitempty"`
	TotalCount     int      `json:"totalCount,omitempty"`
	Threads        int      `json:"threads,omitempty"`
	Worker         int      `json:"worker,omitempty"`
	Timeout        string   `json:"timeout,omitempty"`
	TotalLines     int      `json:"totalLines,omitempty"`

	// Task progress reporting (client -> server)
	Progress         int         `json:"progress,omitempty"`
	Status           string      `json:"status,omitempty"`
	Results          []URLResult `json:"results,omitempty"`
	IsPeriodicUpdate bool        `json:"isPeriodicUpdate,omitempty"` // 标记是否是30秒定期更新
}

// URLResult 表示单个 URL 的检测结果
type URLResult struct {
	Domain   string  `json:"domain"`
	WAF      string  `json:"waf"`
	Database string  `json:"database"`
	Rows     int64   `json:"rows"`
	Status   string  `json:"status"`
	Progress float64 `json:"progress"`
}

// SendMessage 发送消息到服务器（线程安全）
func SendMessage(conn *websocket.Conn, msg Message) error {
	if conn == nil {
		return fmt.Errorf("connection is nil")
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("encode message failed: %v", err)
	}

	// 使用互斥锁保护写入操作
	writeMutex.Lock()
	defer writeMutex.Unlock()

	// 设置写超时
	conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	defer conn.SetWriteDeadline(time.Time{}) // 清除超时

	err = conn.WriteMessage(websocket.TextMessage, data)
	if err != nil {
		return fmt.Errorf("write message failed: %v", err)
	}

	return nil
}

// CheckConnectionAlive 检查连接是否存活（线程安全）
// 返回 true 表示连接正常，false 表示连接已关闭
func CheckConnectionAlive(conn *websocket.Conn) bool {
	if conn == nil {
		return false
	}

	writeMutex.Lock()
	defer writeMutex.Unlock()

	conn.SetWriteDeadline(time.Now().Add(time.Second))
	defer conn.SetWriteDeadline(time.Time{})

	err := conn.WriteControl(websocket.PingMessage, []byte{}, time.Now().Add(time.Second))
	return err == nil
}

// SendPingMessage 发送 Ping 消息（线程安全）
func SendPingMessage(conn *websocket.Conn) error {
	if conn == nil {
		return fmt.Errorf("connection is nil")
	}

	writeMutex.Lock()
	defer writeMutex.Unlock()

	conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	defer conn.SetWriteDeadline(time.Time{})

	return conn.WriteMessage(websocket.PingMessage, nil)
}

// MessageHandler 消息处理函数类型
type MessageHandler func(conn *websocket.Conn, msg Message)

// HandleMessage 处理来自服务器的消息
func HandleMessage(conn *websocket.Conn, message []byte, handler MessageHandler) {
	var msg Message
	if err := json.Unmarshal(message, &msg); err != nil {
		log.Printf("failed to parse message: %v, raw: %s", err, string(message))
		return
	}

	// 如果消息类型为空，可能是解析失败
	if msg.Type == "" {
		log.Printf("warning: message type is empty, raw: %s", string(message))
		return
	}

	handler(conn, msg)
}
