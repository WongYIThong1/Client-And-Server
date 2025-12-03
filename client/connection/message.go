package connection

import (
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/gorilla/websocket"
)

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

// SendMessage 发送消息到服务器
func SendMessage(conn *websocket.Conn, msg Message) error {
	if conn == nil {
		return fmt.Errorf("connection is nil")
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("encode message failed: %v", err)
	}

	// 设置写超时
	conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	defer conn.SetWriteDeadline(time.Time{}) // 清除超时

	err = conn.WriteMessage(websocket.TextMessage, data)
	if err != nil {
		return fmt.Errorf("write message failed: %v", err)
	}

	return nil
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
