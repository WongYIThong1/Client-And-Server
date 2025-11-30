package connection

import (
	"crypto/tls"
	"fmt"
	"strings"
	"time"

	"websocket-client/utils"

	"github.com/gorilla/websocket"
)

// ServerURL 服务器地址
var ServerURL = "ws://api.sqlbots.online"

// ConnectToServerOnce 尝试连接服务器一次
func ConnectToServerOnce() (*websocket.Conn, error) {
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	if strings.HasPrefix(ServerURL, "wss://") {
		dialer.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}
	conn, _, err := dialer.Dial(ServerURL, nil)
	if err != nil {
		return nil, fmt.Errorf("connection failed: %v", err)
	}
	return conn, nil
}

// ConnectToServer 连接服务器，带重试机制
func ConnectToServer() (*websocket.Conn, error) {
	const maxRetries = 3
	var conn *websocket.Conn
	var err error
	for attempt := 1; attempt <= maxRetries; attempt++ {
		fmt.Printf("%s[%s]%s Connecting to server (%d/%d)...%s\n", utils.ColorYellow, utils.ColorBold, utils.ColorReset, attempt, maxRetries, utils.ColorReset)
		conn, err = ConnectToServerOnce()
		if err == nil {
			if attempt > 1 {
				fmt.Printf("%s[%s]%s Reconnected after %d attempts%s\n", utils.ColorGreen, utils.ColorBold, utils.ColorReset, attempt, utils.ColorReset)
			}
			return conn, nil
		}
		fmt.Printf("%s[%s]%s %v%s\n", utils.ColorRed, utils.ColorBold, utils.ColorReset, err, utils.ColorReset)
		if attempt < maxRetries {
			wait := time.Duration(attempt) * 2 * time.Second
			fmt.Printf("%s[%s]%s Retry in %v...%s\n", utils.ColorYellow, utils.ColorBold, utils.ColorReset, wait, utils.ColorReset)
			time.Sleep(wait)
		}
	}
	return nil, fmt.Errorf("failed to connect after %d attempts to %s", maxRetries, ServerURL)
}
