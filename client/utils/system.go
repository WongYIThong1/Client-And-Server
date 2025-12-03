package utils

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"net"
	"os"
	"runtime"
	"strings"

	"github.com/shirou/gopsutil/v3/mem"
)

// GetLocalIP 获取本地 IP 地址
func GetLocalIP() string {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return "unknown"
	}
	defer conn.Close()
	return conn.LocalAddr().(*net.UDPAddr).IP.String()
}

// GetRAMInfo 获取内存信息
func GetRAMInfo() string {
	vm, err := mem.VirtualMemory()
	if err != nil {
		return "unknown"
	}
	totalGiB := float64(vm.Total) / 1024 / 1024 / 1024
	roundedGB := int(math.Round(totalGiB))
	return fmt.Sprintf("%.2f GiB (~%d GB)", totalGiB, roundedGB)
}

// GetCPUCores 获取 CPU 核心数
func GetCPUCores() int {
	return runtime.NumCPU()
}

// GetMachineName 获取机器名称
func GetMachineName() string {
	name, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return name
}

// GetHWID 生成硬件ID（基于MAC地址、CPU核心数、主机名）
func GetHWID() string {
	var components []string

	// 获取MAC地址
	interfaces, err := net.Interfaces()
	if err == nil {
		for _, iface := range interfaces {
			// 跳过回环接口和无效接口
			if iface.Flags&net.FlagLoopback == 0 && iface.Flags&net.FlagUp != 0 {
				if mac := iface.HardwareAddr.String(); mac != "" {
					components = append(components, mac)
					break // 使用第一个有效的MAC地址
				}
			}
		}
	}

	// 获取CPU核心数
	cores := runtime.NumCPU()
	components = append(components, fmt.Sprintf("cpu%d", cores))

	// 获取主机名
	hostname, err := os.Hostname()
	if err == nil && hostname != "" {
		components = append(components, hostname)
	}

	// 如果没有任何组件，返回空字符串
	if len(components) == 0 {
		return ""
	}

	// 组合所有组件并生成SHA256哈希
	combined := strings.Join(components, "|")
	hash := sha256.Sum256([]byte(combined))
	hwid := hex.EncodeToString(hash[:])[:32] // 取前32个字符

	return hwid
}

// GetSystemInfo 获取系统信息
func GetSystemInfo() (ip, ram string, cores int, machineName string) {
	return GetLocalIP(), GetRAMInfo(), GetCPUCores(), GetMachineName()
}
