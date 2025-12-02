package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"

	"websocket-client/utils"
)

// stateDir returns the client state directory (~/.websocket-client).
func stateDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, ".websocket-client")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	return dir, nil
}

// GetHWIDPath returns the path that stores the HWID.
func GetHWIDPath() (string, error) {
	dir, err := stateDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "hwid.txt"), nil
}

// SaveHWID writes HWID to disk.
func SaveHWID(hwid string) error {
	path, err := GetHWIDPath()
	if err != nil {
		return err
	}
	return os.WriteFile(path, []byte(hwid), 0600)
}

// LoadHWID loads stored HWID; returns empty string if not present.
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

// GetOrGenerateHWID returns saved HWID or generates and stores a new one.
func GetOrGenerateHWID() (string, error) {
	savedHWID, err := LoadHWID()
	if err != nil {
		return "", err
	}
	if savedHWID != "" {
		return savedHWID, nil
	}

	base := utils.GetHWID()
	if base == "" {
		return "", nil
	}

	salt, err := loadOrCreateSalt()
	if err != nil {
		return "", err
	}
	combined := base + "|" + salt
	sum := sha256.Sum256([]byte(combined))
	hwid := hex.EncodeToString(sum[:])[:32]

	if err := SaveHWID(hwid); err != nil {
		return "", err
	}
	return hwid, nil
}

// DeleteHWID removes stored HWID and its salt to force regeneration.
func DeleteHWID() error {
	hwidPath, err := GetHWIDPath()
	if err != nil {
		return err
	}
	_ = os.Remove(hwidPath)

	saltPath, err := getHWIDSaltPath()
	if err != nil {
		return err
	}
	if err := os.Remove(saltPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func getHWIDSaltPath() (string, error) {
	dir, err := stateDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "hwid_salt.txt"), nil
}

// loadOrCreateSalt returns a persistent random salt for HWID generation.
func loadOrCreateSalt() (string, error) {
	path, err := getHWIDSaltPath()
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(path)
	if err == nil {
		return strings.TrimSpace(string(data)), nil
	}
	if !os.IsNotExist(err) {
		return "", err
	}

	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	salt := hex.EncodeToString(buf)
	if err := os.WriteFile(path, []byte(salt), 0600); err != nil {
		return "", err
	}
	return salt, nil
}
