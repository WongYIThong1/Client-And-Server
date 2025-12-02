package utils

import (
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"
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


