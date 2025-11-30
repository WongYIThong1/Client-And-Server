package connection

import (
	"fmt"
	"log"
	"os"

	"websocket-client/auth"
	"websocket-client/utils"

	"github.com/gorilla/websocket"
)

var (
	accessToken     string
	refreshToken    string
	isAuthenticated bool
)

// SetupMessageHandler 设置消息处理函数
func SetupMessageHandler() MessageHandler {
	return func(conn *websocket.Conn, msg Message) {
		switch msg.Type {
		case "auth_success":
			accessToken = msg.AccessToken
			refreshToken = msg.RefreshToken
			isAuthenticated = true
			fmt.Printf("\n%s%sAuthenticated%s\n", utils.ColorGreen, utils.ColorBold, utils.ColorReset)
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

			ip, ram, cores, machineName := utils.GetSystemInfo()
			systemInfoMsg := Message{
				Type:        "system_info",
				IP:          ip,
				RAM:         ram,
				CPUCores:    cores,
				MachineName: machineName,
			}
			if err := SendMessage(conn, systemInfoMsg); err != nil {
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
			if err := auth.DeleteAPIKey(); err != nil {
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

		case "plan_expired":
			fmt.Printf("\n%s%sPlan Expired%s\n", utils.ColorRed, utils.ColorBold, utils.ColorReset)
			fmt.Printf("%s\n", msg.Message)
			fmt.Println("Exiting...")
			conn.Close()
			os.Exit(1)

		case "error":
			fmt.Printf("\n[Error] %s\n", msg.Message)

		default:
			fmt.Printf("\n[Unknown message type] %s\n", msg.Type)
		}
	}
}

// IsAuthenticated 返回认证状态
func IsAuthenticated() bool {
	return isAuthenticated
}

// GetTokens 获取当前 token
func GetTokens() (string, string) {
	return accessToken, refreshToken
}
