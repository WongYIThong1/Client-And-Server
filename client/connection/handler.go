package connection

import (
	"context"
	"fmt"
	"log"
	"os"
	"sync"
	"time"

	"websocket-client/auth"
	"websocket-client/modules/wafdetect"
	"websocket-client/utils"

	"github.com/gorilla/websocket"
)

var (
	// 认证相关的全局变量（需要mutex保护）
	accessToken     string
	refreshToken    string
	isAuthenticated bool
	shouldExit      bool
	authMutex       = &sync.RWMutex{} // 保护认证相关变量
	// 存储正在运行的任务及其结果
	runningTaskResults = make(map[string][]wafdetect.Result)
	runningTaskMutex   = &sync.RWMutex{}
	// 存储任务运行状态，防止重复启动
	runningTasks      = make(map[string]bool)
	runningTasksMutex = &sync.Mutex{}
	// 存储每个任务的最后进度更新时间，用于限制发送频率
	lastProgressUpdate      = make(map[string]time.Time)
	lastProgressUpdateMutex = &sync.Mutex{}
	// 当前有效的 WebSocket 连接（用于在重连后更新）
	currentConnection      *websocket.Conn
	currentConnectionMutex = &sync.RWMutex{}
	// 存储每个任务的取消 context，用于停止正在运行的任务
	taskCancelFuncs      = make(map[string]context.CancelFunc)
	taskCancelFuncsMutex = &sync.Mutex{}
)

// SetCurrentConnection 设置当前有效的 WebSocket 连接（重连时调用）
func SetCurrentConnection(conn *websocket.Conn) {
	currentConnectionMutex.Lock()
	defer currentConnectionMutex.Unlock()
	currentConnection = conn
}

// GetCurrentConnection 获取当前有效的 WebSocket 连接
func GetCurrentConnection() *websocket.Conn {
	currentConnectionMutex.RLock()
	defer currentConnectionMutex.RUnlock()
	return currentConnection
}

// SetupMessageHandler builds a handler for inbound WebSocket messages.
func SetupMessageHandler() MessageHandler {
	return func(conn *websocket.Conn, msg Message) {
		switch msg.Type {
		case "auth_success":
			authMutex.Lock()
			accessToken = msg.AccessToken
			refreshToken = msg.RefreshToken
			isAuthenticated = true
			authMutex.Unlock()
			fmt.Printf("\n%s%sAuthenticated%s\n", utils.ColorGreen, utils.ColorBold, utils.ColorReset)

			preview := 20
			if len(accessToken) < preview {
				preview = len(accessToken)
			}
			fmt.Printf("Access Token (15m): %s...\n", accessToken[:preview])

			preview = 20
			if len(refreshToken) < preview {
				preview = len(refreshToken)
			}
			fmt.Printf("Refresh Token (7d): %s...\n", refreshToken[:preview])
			fmt.Println("Ready for data exchange...")

			go func(c *websocket.Conn) {
				// 重试发送 system_info，直到成功或连接关闭
				for attempts := 0; attempts < 3; attempts++ {
					if err := SendSystemInfo(c); err != nil {
						log.Printf("Failed to send system info (attempt %d): %v", attempts+1, err)
						time.Sleep(2 * time.Second)
						continue
					}
					break
				}
			}(conn)

		case "system_info_received":
			fmt.Println("[Server acknowledged system info]")

		case "disconnect_ack":
			fmt.Println("[Server confirmed disconnect]")

		case "auth_failed":
			fmt.Printf("\nAuth failed: %s\n", msg.Message)
			fmt.Println("API Key invalid. Please re-enter.")
			if err := auth.DeleteAPIKey(); err != nil {
				log.Printf("Failed to delete local API Key: %v", err)
			} else {
				fmt.Println("[Local API Key removed]")
			}
			if err := auth.DeleteHWID(); err != nil {
				log.Printf("Failed to delete local HWID: %v", err)
			}
			authMutex.Lock()
			accessToken, refreshToken, isAuthenticated = "", "", false
			shouldExit = true
			authMutex.Unlock()
			conn.Close()
			time.Sleep(100 * time.Millisecond)
			os.Exit(1)

		case "token_refreshed":
			authMutex.Lock()
			accessToken = msg.AccessToken
			if msg.RefreshToken != "" {
				refreshToken = msg.RefreshToken
			}
			authMutex.Unlock()
			fmt.Println("\n[Tokens refreshed]")

		case "data":
			fmt.Printf("\n[Data received] %s\n", msg.Message)
			if msg.Data != nil {
				fmt.Printf("Payload: %v\n", msg.Data)
			}

		case "plan_expired":
			fmt.Printf("\n%s%sPlan Expired%s\n", utils.ColorRed, utils.ColorBold, utils.ColorReset)
			fmt.Printf("%s\n", msg.Message)
			fmt.Println("Exiting...")
			conn.Close()
			os.Exit(1)

		case "machine_deleted":
			fmt.Printf("\n%s%sMachine Deleted%s\n", utils.ColorRed, utils.ColorBold, utils.ColorReset)
			fmt.Printf("%s\n", msg.Message)
			fmt.Println("Clearing saved API Key...")
			if err := auth.DeleteAPIKey(); err != nil {
				log.Printf("Failed to delete local API Key: %v", err)
			} else {
				fmt.Println("[Local API Key removed]")
			}
			if err := auth.DeleteHWID(); err != nil {
				log.Printf("Failed to delete local HWID: %v", err)
			} else {
				fmt.Println("[Local HWID removed]")
			}
			authMutex.Lock()
			accessToken, refreshToken, isAuthenticated = "", "", false
			shouldExit = true
			authMutex.Unlock()
			fmt.Println("Please restart the client; a new API Key and HWID will be required.")
			conn.Close()
			time.Sleep(100 * time.Millisecond)
			os.Exit(1)

		case "task_assigned":
			// New task assigned to this machine.
			// Only log minimal information to avoid leaking file paths.
			fmt.Printf(
				"\n[Task assigned] ID: %s, Name: %s\n",
				msg.TaskID,
				msg.TaskName,
			)
			if msg.ListFile != "" {
				fmt.Println(" - List file received (remote)")
			}
			if msg.ProxyFile != "" {
				fmt.Println(" - Proxy file received (remote)")
			}
			// Download and locally encrypt task files into the hidden tasks
			// directory. Best-effort: errors are logged but do not crash the
			// client.
			hwid, err := auth.GetOrGenerateHWID()
			if err != nil {
				log.Printf("Failed to obtain HWID for task storage: %v", err)
				return
			}

			if msg.ListFile != "" {
				if path, lineCount, err := utils.DownloadAndEncryptFile(msg.TaskID, msg.ListFile, hwid); err != nil {
					log.Printf("Failed to download/encrypt list file for task %s: %v", msg.TaskID, err)
				} else {
					log.Printf("List file for task %s stored at %s", msg.TaskID, path)
					if lineCount > 0 {
						if err := SendMessage(conn, Message{
							Type:       "task_list_info",
							TaskID:     msg.TaskID,
							TotalLines: lineCount,
						}); err != nil {
							log.Printf("Failed to send list line count for task %s: %v", msg.TaskID, err)
						}
					}
				}
			}

			if msg.ProxyFile != "" {
				if path, _, err := utils.DownloadAndEncryptFile(msg.TaskID, msg.ProxyFile, hwid); err != nil {
					log.Printf("Failed to download/encrypt proxy file for task %s: %v", msg.TaskID, err)
				} else {
					log.Printf("Proxy file for task %s stored at %s", msg.TaskID, path)
				}
			}

		case "task_start":
			// Task status changed to running, start WAF detection
			// 检查任务是否已经在运行，防止重复启动
			runningTasksMutex.Lock()
			if runningTasks[msg.TaskID] {
				runningTasksMutex.Unlock()
				// 任务已经在运行，忽略重复的启动消息
				return
			}
			runningTasks[msg.TaskID] = true
			runningTasksMutex.Unlock()
			// 清理可能存在的旧结果（任务重启时）
			runningTaskMutex.Lock()
			delete(runningTaskResults, msg.TaskID)
			runningTaskMutex.Unlock()

			// 检查是否是恢复暂停的任务
			if msg.CompletedCount > 0 && msg.TotalCount > 0 {
				fmt.Printf(
					"\n%s[Task Resuming]%s ID: %s, Name: %s (Resuming from %d/%d completed, %d remaining, threads=%d, workers=%d, timeout=%s)\n",
					utils.ColorYellow,
					utils.ColorReset,
					msg.TaskID,
					msg.TaskName,
					msg.CompletedCount,
					msg.TotalCount,
					len(msg.Domains),
					msg.Threads,
					msg.Worker,
					msg.Timeout,
				)
			} else {
				fmt.Printf(
					"\n%s[Task Running]%s ID: %s, Name: %s (threads=%d, workers=%d, timeout=%s)\n",
					utils.ColorYellow,
					utils.ColorReset,
					msg.TaskID,
					msg.TaskName,
					msg.Threads,
					msg.Worker,
					msg.Timeout,
				)
			}

			taskConfig := utils.TaskConfig{
				TaskID:           msg.TaskID,
				Name:             msg.TaskName,
				Threads:          msg.Threads,
				Worker:           msg.Worker,
				Timeout:          msg.Timeout,
				CompletedCount:   msg.CompletedCount,
				TotalCount:       msg.TotalCount,
				RemainingDomains: len(msg.Domains),
				ListFile:         msg.ListFile,
				ProxyFile:        msg.ProxyFile,
			}
			if err := utils.SaveTaskConfig(msg.TaskID, taskConfig); err != nil {
				log.Printf("Failed to save config for task %s: %v", msg.TaskID, err)
			}

			if len(msg.Domains) == 0 {
				if msg.CompletedCount > 0 && msg.CompletedCount >= msg.TotalCount {
					fmt.Printf("%s[Task Completed]%s All domains already processed (%d/%d)\n", utils.ColorGreen, utils.ColorReset, msg.CompletedCount, msg.TotalCount)
				} else {
					fmt.Println("[Warning] No domains provided for task")
				}
				runningTasksMutex.Lock()
				delete(runningTasks, msg.TaskID)
				runningTasksMutex.Unlock()
				// 清理可能存在的旧结果
				runningTaskMutex.Lock()
				delete(runningTaskResults, msg.TaskID)
				runningTaskMutex.Unlock()
				return
			}

			// 设置当前连接（用于重连后更新）
			SetCurrentConnection(conn)

			// 创建取消 context，用于停止任务
			ctx, cancel := context.WithCancel(context.Background())
			taskCancelFuncsMutex.Lock()
			taskCancelFuncs[msg.TaskID] = cancel
			taskCancelFuncsMutex.Unlock()

			// 跟踪已显示的结果，避免重复显示
			displayedResults := make(map[string]bool)
			displayedResultsMutex := &sync.Mutex{}

			// 启动 WAF 检测（在 goroutine 中运行，不阻塞消息处理）
			go func() {
				defer func() {
					// 任务完成后清理状态
					runningTasksMutex.Lock()
					delete(runningTasks, msg.TaskID)
					runningTasksMutex.Unlock()
					lastProgressUpdateMutex.Lock()
					delete(lastProgressUpdate, msg.TaskID)
					lastProgressUpdateMutex.Unlock()
					taskCancelFuncsMutex.Lock()
					delete(taskCancelFuncs, msg.TaskID)
					taskCancelFuncsMutex.Unlock()
					// 清理任务结果，防止内存泄漏
					runningTaskMutex.Lock()
					delete(runningTaskResults, msg.TaskID)
					runningTaskMutex.Unlock()
				}()

				// 完全按照服务器设置的配置运行
				if msg.Threads <= 0 {
					log.Printf("[Warning] Invalid threads value: %d, using default 1", msg.Threads)
					msg.Threads = 1
				}
				if msg.Worker <= 0 {
					log.Printf("[Warning] Invalid worker value: %d, using default 1", msg.Worker)
					msg.Worker = 1
				}
				if msg.Timeout == "" {
					log.Printf("[Warning] Empty timeout, using default 30s")
					msg.Timeout = "30s"
				}

				config := wafdetect.Config{
					Threads: msg.Threads,
					Worker:  msg.Worker,
					Timeout: msg.Timeout,
				}

				// 进度回调函数（限制发送频率，实时显示结果）
				progressCallback := func(results []wafdetect.Result, progress float64) {
					runningTaskMutex.Lock()
					runningTaskResults[msg.TaskID] = results
					runningTaskMutex.Unlock()

					// 实时显示新完成的结果
					displayedResultsMutex.Lock()
					for _, result := range results {
						// 只显示已完成的结果（status 为 completed 或 failed）
						if (result.Status == "completed" || result.Status == "failed") && !displayedResults[result.Domain] {
							fmt.Printf("  %s --- %s\n", result.Domain, result.WAF)
							displayedResults[result.Domain] = true
						}
					}
					displayedResultsMutex.Unlock()

					// 限制发送频率：每30秒最多发送一次进度更新（优化：减少数据库请求）
					lastProgressUpdateMutex.Lock()
					lastUpdate, exists := lastProgressUpdate[msg.TaskID]
					shouldSend := !exists || time.Since(lastUpdate) >= 30*time.Second
					if shouldSend {
						lastProgressUpdate[msg.TaskID] = time.Now()
					}
					lastProgressUpdateMutex.Unlock()

					if shouldSend {
						// 获取当前有效连接（支持重连）
						taskConn := GetCurrentConnection()
						if taskConn != nil {
							// 检查连接状态（线程安全）
							if CheckConnectionAlive(taskConn) {
								sendTaskProgressUpdate(taskConn, msg.TaskID, results, progress)
							}
						}
					}
				}

				// 执行 WAF 检测（传入 context 以便取消）
				results, err := wafdetect.RunWAFDetectWithContext(ctx, msg.Domains, config, progressCallback)
				if err != nil {
					if err == context.Canceled {
						fmt.Printf("%s[Task Paused]%s ID: %s, Name: %s\n", utils.ColorYellow, utils.ColorReset, msg.TaskID, msg.TaskName)
					} else {
						log.Printf("WAF detection failed for task %s: %v", msg.TaskID, err)
					}
					return
				}

				// 发送最终结果（不受频率限制）
				taskConn := GetCurrentConnection()
				if taskConn != nil {
					// 检查连接状态（线程安全）
					if CheckConnectionAlive(taskConn) {
						sendTaskProgressUpdate(taskConn, msg.TaskID, results, 100.0)
					}
				}
			}()

		case "task_pause":
			// Server requesting to pause a running task（任务仍然存在于数据库中，仅临时暂停，不删除本地文件）
			fmt.Printf("%s[Task Pausing]%s ID: %s\n", utils.ColorYellow, utils.ColorReset, msg.TaskID)

			// 取消任务
			taskCancelFuncsMutex.Lock()
			cancel, exists := taskCancelFuncs[msg.TaskID]
			if exists {
				cancel()
				delete(taskCancelFuncs, msg.TaskID)
			}
			taskCancelFuncsMutex.Unlock()

			// 清理任务状态
			runningTasksMutex.Lock()
			delete(runningTasks, msg.TaskID)
			runningTasksMutex.Unlock()

			// 发送最终进度更新（标记任务已暂停）
			runningTaskMutex.Lock()
			results, exists := runningTaskResults[msg.TaskID]
			if exists {
				// 发送进度更新后清理结果，防止内存泄漏
				taskConn := GetCurrentConnection()
				if taskConn != nil {
					// 检查连接状态（线程安全）
					if CheckConnectionAlive(taskConn) {
						sendTaskProgressUpdate(taskConn, msg.TaskID, results, 0.0)
					}
				}
				delete(runningTaskResults, msg.TaskID)
			}
			runningTaskMutex.Unlock()

		case "task_cancel":
			// Server indicates that the task has been deleted; stop locally and remove encrypted files.
			fmt.Printf("%s[Task Cancelled]%s ID: %s\n", utils.ColorYellow, utils.ColorReset, msg.TaskID)

			// 取消任务
			taskCancelFuncsMutex.Lock()
			cancel, exists := taskCancelFuncs[msg.TaskID]
			if exists {
				cancel()
				delete(taskCancelFuncs, msg.TaskID)
			}
			taskCancelFuncsMutex.Unlock()

			// 清理任务状态
			runningTasksMutex.Lock()
			delete(runningTasks, msg.TaskID)
			runningTasksMutex.Unlock()

			// 发送最终进度更新（标记任务已取消，进度不再推进）
			runningTaskMutex.Lock()
			results, exists := runningTaskResults[msg.TaskID]
			if exists {
				taskConn := GetCurrentConnection()
				if taskConn != nil {
					// 检查连接状态（线程安全）
					if CheckConnectionAlive(taskConn) {
						sendTaskProgressUpdate(taskConn, msg.TaskID, results, 0.0)
					}
				}
				// 清理任务结果，防止内存泄漏
				delete(runningTaskResults, msg.TaskID)
			}
			runningTaskMutex.Unlock()

			// 删除本地任务目录（包括加密文件和 config.json）
			if err := utils.DeleteTaskDir(msg.TaskID); err != nil {
				log.Printf("Failed to delete local task dir for %s: %v", msg.TaskID, err)
			} else {
				fmt.Printf("[Task Cleanup] Local data for task %s has been removed\n", msg.TaskID)
			}

		case "task_progress_request":
			// Server requesting progress update for a running task (每30秒)
			// 更新当前连接引用
			SetCurrentConnection(conn)

			runningTaskMutex.RLock()
			results, exists := runningTaskResults[msg.TaskID]
			runningTaskMutex.RUnlock()

			if exists {
				// 计算当前进度
				totalProgress := 0.0
				if len(results) > 0 {
					for _, r := range results {
						totalProgress += r.Progress
					}
					totalProgress /= float64(len(results))
				}

				// 发送进度更新（标记为30秒定期更新）
				sendTaskProgressUpdatePeriodic(conn, msg.TaskID, results, totalProgress)
			} else {
				// 任务不存在或尚未开始，发送空结果
				sendTaskProgressUpdatePeriodic(conn, msg.TaskID, []wafdetect.Result{}, 0.0)
			}

		case "task_progress_update_ack":
			// Server acknowledged progress update
			// 静默处理，不需要输出

		case "error":
			fmt.Printf("\n[Error] %s\n", msg.Message)

		default:
			fmt.Printf("\n[Unknown message type] %s\n", msg.Type)
		}
	}
}

// IsAuthenticated returns whether auth_success was received.
func IsAuthenticated() bool {
	authMutex.RLock()
	defer authMutex.RUnlock()
	return isAuthenticated
}

// GetTokens returns access and refresh tokens.
func GetTokens() (string, string) {
	authMutex.RLock()
	defer authMutex.RUnlock()
	return accessToken, refreshToken
}

// ShouldExit indicates caller should terminate due to fatal server notice.
func ShouldExit() bool {
	authMutex.RLock()
	defer authMutex.RUnlock()
	return shouldExit
}

// SendSystemInfo sends system information to the server
func SendSystemInfo(conn *websocket.Conn) error {
	hwid, err := auth.GetOrGenerateHWID()
	if err != nil {
		return fmt.Errorf("failed to get or generate HWID: %v", err)
	}

	ip, ram, cores, machineName := utils.GetSystemInfo()
	systemInfoMsg := Message{
		Type:        "system_info",
		IP:          ip,
		RAM:         ram,
		CPUCores:    cores,
		MachineName: machineName,
		HWID:        hwid,
	}
	if err := SendMessage(conn, systemInfoMsg); err != nil {
		return fmt.Errorf("failed to send system info: %v", err)
	}

	if hwid != "" {
		fmt.Printf("\n[System info sent] IP: %s, RAM: %s, CPU cores: %d, Hostname: %s, HWID: %s\n", ip, ram, cores, machineName, hwid[:16]+"...")
	} else {
		fmt.Printf("\n[System info sent] IP: %s, RAM: %s, CPU cores: %d, Hostname: %s\n", ip, ram, cores, machineName)
	}
	return nil
}

// sendTaskProgressUpdate 发送任务进度更新到服务器（常规更新，不更新恢复信息）
func sendTaskProgressUpdate(conn *websocket.Conn, taskID string, results []wafdetect.Result, overallProgress float64) {
	// 检查连接状态
	if conn == nil {
		return
	}

	// 转换为 URLResult 格式
	urlResults := make([]URLResult, len(results))
	for i, r := range results {
		urlResults[i] = URLResult{
			Domain:   r.Domain,
			WAF:      r.WAF,
			Database: r.Database,
			Rows:     r.Rows,
			Status:   r.Status,
			Progress: r.Progress,
		}
	}

	progressMsg := Message{
		Type:             "task_progress_update",
		TaskID:           taskID,
		Results:          urlResults,
		Progress:         int(overallProgress),
		IsPeriodicUpdate: false, // 常规更新，不更新恢复信息
	}

	// 静默处理发送错误，避免日志刷屏
	if err := SendMessage(conn, progressMsg); err != nil {
		// 只在连接关闭错误时记录，其他错误静默忽略
		if err.Error() != "websocket: close sent" && err.Error() != "write message failed: websocket: close sent" {
			log.Printf("Failed to send task progress update for task %s: %v", taskID, err)
		}
	}
}

// sendTaskProgressUpdatePeriodic 发送任务进度更新到服务器（30秒定期更新，会更新恢复信息）
func sendTaskProgressUpdatePeriodic(conn *websocket.Conn, taskID string, results []wafdetect.Result, overallProgress float64) {
	// 检查连接状态
	if conn == nil {
		return
	}

	// 检查连接是否已关闭（线程安全）
	if !CheckConnectionAlive(conn) {
		// 连接已关闭，静默返回（避免日志刷屏）
		return
	}

	// 转换为 URLResult 格式
	urlResults := make([]URLResult, len(results))
	for i, r := range results {
		urlResults[i] = URLResult{
			Domain:   r.Domain,
			WAF:      r.WAF,
			Database: r.Database,
			Rows:     r.Rows,
			Status:   r.Status,
			Progress: r.Progress,
		}
	}

	progressMsg := Message{
		Type:             "task_progress_update",
		TaskID:           taskID,
		Results:          urlResults,
		Progress:         int(overallProgress),
		IsPeriodicUpdate: true, // 30秒定期更新，会更新恢复信息
	}

	// 静默处理发送错误，避免日志刷屏
	if err := SendMessage(conn, progressMsg); err != nil {
		// 只在连接关闭错误时记录，其他错误静默忽略
		if err.Error() != "websocket: close sent" && err.Error() != "write message failed: websocket: close sent" {
			log.Printf("Failed to send periodic task progress update for task %s: %v", taskID, err)
		}
	}
}
