package utils

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"fmt"
	"io"
)

// DeriveKeyFromHWID derives a 32-byte key from the given HWID using SHA-256.
func DeriveKeyFromHWID(hwid string) []byte {
	const salt = "sqlbots-local-task-storage-salt"
	sum := sha256.Sum256([]byte(hwid + "|" + salt))
	return sum[:]
}

// EncryptToWriter encrypts plaintext from r and writes the ciphertext to w using AES-GCM.
// Layout: nonce (12 bytes) || ciphertext+tag.
func EncryptToWriter(key []byte, plaintext []byte, w io.Writer) error {
	block, err := aes.NewCipher(key)
	if err != nil {
		return fmt.Errorf("new cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return fmt.Errorf("new gcm: %w", err)
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return fmt.Errorf("nonce: %w", err)
	}

	ciphertext := gcm.Seal(nil, nonce, plaintext, nil)

	if _, err := w.Write(nonce); err != nil {
		return fmt.Errorf("write nonce: %w", err)
	}
	if _, err := w.Write(ciphertext); err != nil {
		return fmt.Errorf("write ciphertext: %w", err)
	}

	return nil
}


