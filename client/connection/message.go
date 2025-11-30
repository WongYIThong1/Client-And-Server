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
		log.Printf("failed to parse message: %v", err)
		return
	}
	handler(conn, msg)
}
