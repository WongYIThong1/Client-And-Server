package auth

import (
	"os"
	"path/filepath"
	"strings"

	"websocket-client/utils"
)

// GetHWIDPath 获取 HWID 文件路径
func GetHWIDPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, ".websocket-client")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	return filepath.Join(dir, "hwid.txt"), nil
}

// SaveHWID 保存 HWID 到本地文件
func SaveHWID(hwid string) error {
	path, err := GetHWIDPath()
	if err != nil {
		return err
	}
	return os.WriteFile(path, []byte(hwid), 0600)
}

// LoadHWID 从本地文件加载 HWID
func LoadHWID() (string, error) {
	path, err := GetHWIDPath()
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

// GetOrGenerateHWID 获取或生成 HWID
// 如果本地有保存的 HWID，则返回保存的；否则生成新的并保存
func GetOrGenerateHWID() (string, error) {
	// 尝试加载已保存的 HWID
	savedHWID, err := LoadHWID()
	if err != nil {
		return "", err
	}

	// 如果已有保存的 HWID，直接返回
	if savedHWID != "" {
		return savedHWID, nil
	}

	// 生成新的 HWID
	hwid := utils.GetHWID()
	if hwid == "" {
		// 如果生成失败，返回错误
		return "", nil
	}

	// 保存新生成的 HWID
	if err := SaveHWID(hwid); err != nil {
		return "", err
	}

	return hwid, nil
}

