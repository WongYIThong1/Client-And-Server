package utils

import (
	"fmt"
	"math"
	"net"
	"os"
	"runtime"

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

// GetSystemInfo 获取系统信息
func GetSystemInfo() (ip, ram string, cores int, machineName string) {
	return GetLocalIP(), GetRAMInfo(), GetCPUCores(), GetMachineName()
}
