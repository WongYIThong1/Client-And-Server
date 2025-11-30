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
	defer conn.Close()

	// Graceful shutdown: send disconnect when possible
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-signals
		if connection.IsAuthenticated() {
			_ = connection.SendMessage(conn, connection.Message{Type: "disconnect"})
		}
		conn.Close()
		os.Exit(0)
	}()

	fmt.Println("Connected To Server")

	// 立即启动消息接收，保持连接活跃
	messageChan := make(chan []byte, 256)
	errorChan := make(chan error, 1)

	go func() {
		for {
			conn.SetReadDeadline(time.Now().Add(60 * time.Second))
			_, message, err := conn.ReadMessage()
			if err != nil {
				errorChan <- err
				return
			}
			messageChan <- message
		}
	}()

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

	// 检查连接是否仍然有效
	if conn != nil {
		// 设置写超时
		conn.SetWriteDeadline(time.Now().Add(10 * time.Second))

		// Send auth
		if err := connection.SendMessage(conn, connection.Message{Type: "auth", APIKey: apiKey}); err != nil {
			log.Fatalf("Failed to send auth message: %v", err)
		}

		// 清除写超时
		conn.SetWriteDeadline(time.Time{})
	} else {
		log.Fatal("Connection is nil")
	}

	messageHandler := connection.SetupMessageHandler()

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
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("WebSocket error: %v", err)
			}
			return
		}
	}
}
