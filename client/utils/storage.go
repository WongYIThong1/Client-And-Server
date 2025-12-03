package utils

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// TaskBaseDir returns the base directory for storing task files on Windows.
// Example: %AppData%\Local\SQLBots\tasks
func TaskBaseDir() (string, error) {
	appData := os.Getenv("APPDATA")
	if appData == "" {
		// Fallback to user home if APPDATA is not set.
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("cannot determine base directory: %w", err)
		}
		appData = filepath.Join(home, "AppData", "Local")
	}

	base := filepath.Join(appData, "SQLBots", "tasks")
	if err := os.MkdirAll(base, 0700); err != nil {
		return "", fmt.Errorf("failed to create task base dir: %w", err)
	}
	return base, nil
}

// TaskDirForID returns a per-task directory path and ensures it exists.
func TaskDirForID(taskID string) (string, error) {
	base, err := TaskBaseDir()
	if err != nil {
		return "", err
	}
	taskDir := filepath.Join(base, taskID)
	if err := os.MkdirAll(taskDir, 0700); err != nil {
		return "", fmt.Errorf("failed to create task dir: %w", err)
	}
	return taskDir, nil
}

// RandomFileName generates a random filename with the given extension.
func RandomFileName(ext string) (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("failed to generate random name: %w", err)
	}
	name := fmt.Sprintf("%x", buf)
	if ext != "" && ext[0] != '.' {
		ext = "." + ext
	}
	return name + ext, nil
}

// TaskConfig 描述任务运行时的关键参数
type TaskConfig struct {
	TaskID           string    `json:"taskId"`
	Name             string    `json:"name,omitempty"`
	Threads          int       `json:"threads,omitempty"`
	Worker           int       `json:"worker,omitempty"`
	Timeout          string    `json:"timeout,omitempty"`
	CompletedCount   int       `json:"completedCount,omitempty"`
	TotalCount       int       `json:"totalCount,omitempty"`
	RemainingDomains int       `json:"remainingDomains,omitempty"`
	ListFile         string    `json:"listFile,omitempty"`
	ProxyFile        string    `json:"proxyFile,omitempty"`
	SavedAt          time.Time `json:"savedAt"`
}

// SaveTaskConfig 将任务配置写入 task 目录下的 config.json
func SaveTaskConfig(taskID string, cfg TaskConfig) error {
	taskDir, err := TaskDirForID(taskID)
	if err != nil {
		return err
	}

	if cfg.TaskID == "" {
		cfg.TaskID = taskID
	}
	if cfg.SavedAt.IsZero() {
		cfg.SavedAt = time.Now().UTC()
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal task config: %w", err)
	}

	configPath := filepath.Join(taskDir, "config.json")
	if err := os.WriteFile(configPath, data, 0600); err != nil {
		return fmt.Errorf("write task config: %w", err)
	}
	return nil
}

// DeleteTaskDir 删除指定任务的本地目录（包括其中的加密文件和 config.json）。
// 如果目录不存在，则静默返回。
func DeleteTaskDir(taskID string) error {
	if taskID == "" {
		return fmt.Errorf("taskID is empty")
	}
	base, err := TaskBaseDir()
	if err != nil {
		return err
	}
	taskDir := filepath.Join(base, taskID)
	if _, err := os.Stat(taskDir); os.IsNotExist(err) {
		return nil
	}
	if err := os.RemoveAll(taskDir); err != nil {
		return fmt.Errorf("failed to delete task dir %s: %w", taskDir, err)
	}
	return nil
}
