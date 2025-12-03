package utils

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// DownloadAndEncryptFile downloads the content from the given URL, encrypts it
// with the provided key, and stores it under the task directory. It returns the
// final local path and how many non-empty lines the plaintext contained.
func DownloadAndEncryptFile(taskID, url, hwid string) (string, int, error) {
	if url == "" {
		return "", 0, fmt.Errorf("empty url")
	}

	resp, err := http.Get(url)
	if err != nil {
		return "", 0, fmt.Errorf("http get: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", 0, fmt.Errorf("unexpected status code: %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", 0, fmt.Errorf("read body: %w", err)
	}

	taskDir, err := TaskDirForID(taskID)
	if err != nil {
		return "", 0, err
	}

	filename, err := RandomFileName("bin")
	if err != nil {
		return "", 0, err
	}

	fullPath := filepath.Join(taskDir, filename)
	f, err := os.OpenFile(fullPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return "", 0, fmt.Errorf("open file: %w", err)
	}
	defer f.Close()

	key := DeriveKeyFromHWID(hwid)
	if err := EncryptToWriter(key, body, f); err != nil {
		return "", 0, fmt.Errorf("encrypt: %w", err)
	}

	return fullPath, countNonEmptyLines(body), nil
}

func countNonEmptyLines(content []byte) int {
	scanner := bufio.NewScanner(bytes.NewReader(content))
	count := 0
	for scanner.Scan() {
		if strings.TrimSpace(scanner.Text()) != "" {
			count++
		}
	}
	return count
}
