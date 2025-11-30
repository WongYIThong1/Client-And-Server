package auth

import (
	"bufio"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// GetAPIKeyPath 获取 API Key 文件路径
func GetAPIKeyPath() (string, error) {
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

// SaveAPIKey 保存 API Key 到本地文件
func SaveAPIKey(apiKey string) error {
	path, err := GetAPIKeyPath()
	if err != nil {
		return err
	}
	return os.WriteFile(path, []byte(apiKey), 0600)
}

// LoadAPIKey 从本地文件加载 API Key
func LoadAPIKey() (string, error) {
	path, err := GetAPIKeyPath()
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

// DeleteAPIKey 删除本地保存的 API Key
func DeleteAPIKey() error {
	path, err := GetAPIKeyPath()
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// ReadAPIKey 从标准输入读取 API Key
func ReadAPIKey() string {
	reader := bufio.NewReader(os.Stdin)
	fmt.Print("APIKey : ")
	apiKey, err := reader.ReadString('\n')
	if err != nil {
		log.Fatalf("failed to read API Key: %v", err)
	}
	return strings.TrimSpace(apiKey)
}
