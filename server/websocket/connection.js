import { authenticatedConnections, cleanupConnection, clientSystemInfo, clientIPs, runningTasks } from '../stores.js';
import { setMachineOffline, checkPlanExpired, checkMachineExists, removeMachineName, pauseRunningTasksForMachine } from '../supabase.js';
import { handleAuth, handleRefreshToken, handleTokenAuth, checkAndRefreshToken } from '../auth/handlers.js';
import { handleSystemInfo, handleData, handleDisconnect, handleTaskProgress, handleTaskListInfo } from './handlers.js';
import { isRateLimited, getClientIP, getRemainingRequests } from '../utils/rateLimiter.js';

/**
 * 处理WebSocket消息
 * @param {WebSocket} ws - WebSocket连接
 * @param {object} connectionState - 连接状态对象
 * @param {Buffer} message - 接收到的消息
 */
export async function handleMessage(ws, connectionState, message) {
  try {
    const data = JSON.parse(message.toString());
    const clientIP = getClientIP(ws, clientIPs);

    // 速率限制检查
    if (data.type === 'auth') {
      // 未认证连接按 IP+HWID 限频（每分钟10次）
      if (!connectionState.isAuthenticated) {
        const hwidFromMessage = typeof data.hwid === 'string' && data.hwid.trim() !== '' ? data.hwid.trim() : null;
        const machineNameFromMessage = typeof data.machineName === 'string' && data.machineName.trim() !== '' ? data.machineName.trim() : null;
        const rateIdentifier = hwidFromMessage || machineNameFromMessage || 'unknown';
        const rateKey = `${clientIP}|${rateIdentifier}`;

        // 提前缓存客户端提供的机器信息（若后续 system_info 缺失仍可使用）
        if (hwidFromMessage || machineNameFromMessage) {
          const existingInfo = clientSystemInfo.get(ws) || {};
          clientSystemInfo.set(ws, {
            ...existingInfo,
            machineName: machineNameFromMessage || existingInfo.machineName || 'unknown',
            hwid: hwidFromMessage || existingInfo.hwid || null,
            receivedAt: existingInfo.receivedAt || Date.now()
          });
        }

        if (isRateLimited(clientIP, 'auth_ip_hwid', rateKey)) {
          const remaining = getRemainingRequests(clientIP, 'auth_ip_hwid', rateKey);
          ws.send(JSON.stringify({
            type: 'error',
            message: `Rate limit exceeded. Too many authentication attempts. Please try again later.`
          }));
          console.log(`Rate limit exceeded for auth (IP+HWID) from IP: ${clientIP}, key: ${rateIdentifier}, remaining: ${remaining}`);
          return;
        }
      }
    } else {
      // 普通消息速率限制
      if (isRateLimited(clientIP, 'message')) {
        const remaining = getRemainingRequests(clientIP, 'message');
        ws.send(JSON.stringify({
          type: 'error',
          message: `Rate limit exceeded. Too many messages. Please slow down.`
        }));
        console.log(`Rate limit exceeded for messages from IP: ${clientIP}`);
        return;
      }
    }

    // 处理认证请求
    const authResult = await handleAuth(ws, data);
    if (authResult === true) {
      return; // 认证失败，已发送错误消息
    }
    if (authResult && authResult.authenticated) {
      connectionState.isAuthenticated = true;
      return;
    }

    // 处理refresh token请求
    if (await handleRefreshToken(ws, data)) {
      return;
    }

    // 处理已认证的请求
    if (!connectionState.isAuthenticated) {
      // 检查是否有access token
      if (data.accessToken) {
        const authenticated = await handleTokenAuth(ws, data);
        if (authenticated) {
          connectionState.isAuthenticated = true;
        } else {
          return; // 认证失败，已发送错误消息
        }
      } else {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Authentication required'
        }));
        return;
      }
    }

    // 检查并自动刷新即将过期的token
    await checkAndRefreshToken(ws);

    // 检查 plan 是否过期
    const connInfo = authenticatedConnections.get(ws);
    if (connInfo && connInfo.userId) {
      const planCheck = await checkPlanExpired(connInfo.userId);
      if (planCheck.expired) {
        ws.send(JSON.stringify({
          type: 'plan_expired',
          message: 'Your plan has expired. Please renew your subscription.'
        }));
        // 关闭连接
        setTimeout(() => {
          ws.close();
        }, 100);
        return;
      }
    }

    // 处理system_info消息（连接建立时自动发送）
    if (await handleSystemInfo(ws, data, connectionState.isAuthenticated)) {
      return;
    }

    // 处理disconnect消息（客户端主动断开）
    if (await handleDisconnect(ws, data, connectionState.isAuthenticated)) {
      return;
    }

    // 处理任务进度消息
    if (await handleTaskProgress(ws, data, connectionState.isAuthenticated)) {
      return;
    }

    if (await handleTaskListInfo(ws, data, connectionState.isAuthenticated)) {
      return;
    }

    // 处理data消息
    if (handleData(ws, data)) {
      return;
    }

  } catch (error) {
    console.error('Error processing message:', error);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Invalid message format'
    }));
  }
}

/**
 * 处理WebSocket连接关闭
 * @param {WebSocket} ws - WebSocket连接
 * @param {object} connectionState - 连接状态对象
 */
export async function handleClose(ws, connectionState) {
  
  // 如果已认证，更新机器状态为离线（处理强制关闭的情况）
  const connInfo = authenticatedConnections.get(ws);
  const sysInfo = clientSystemInfo.get(ws);
  
  if (connInfo && sysInfo) {
    const userId = connInfo.userId;
    const machineId = connInfo.machineId;
    
    // 使用电脑名字作为机器标识（如果为空或unknown，则使用IP作为备用）
    const machineIdentifier = (sysInfo.machineName && sysInfo.machineName !== 'unknown') 
      ? sysInfo.machineName 
      : (sysInfo.ip && sysInfo.ip !== 'unknown' ? sysInfo.ip : null);
    
    if (userId && machineIdentifier) {
      // 异步更新状态，不阻塞关闭流程
      const hwid = sysInfo ? sysInfo.hwid : null;
      setMachineOffline(userId, machineIdentifier, hwid).catch(error => {
        console.error('Error setting machine offline:', error);
      });

      // 如果有绑定的 machineId，将该机器上运行中的任务标记为 paused
      if (machineId) {
        pauseRunningTasksForMachine(userId, machineId).catch(error => {
          console.error('Error pausing running tasks for machine on close:', error);
        });
      }
    }
  }
  
  // 清理连接相关的所有数据
  cleanupConnection(ws);
}

/**
 * 处理WebSocket错误
 * @param {WebSocket} ws - WebSocket连接
 * @param {Error} error - 错误对象
 * @param {object} connectionState - 连接状态对象
 */
export function handleError(ws, error, connectionState) {
  console.error('WebSocket error:', error);
  cleanupConnection(ws);
}

/**
 * 创建并设置WebSocket连接
 * @param {WebSocket} ws - WebSocket连接
 */
export function setupConnection(ws) {
  
  // 保存客户端IP地址
  let clientIP = 'unknown';
  if (ws._socket && ws._socket.remoteAddress) {
    clientIP = ws._socket.remoteAddress;
  } else if (ws.upgradeReq && ws.upgradeReq.socket && ws.upgradeReq.socket.remoteAddress) {
    clientIP = ws.upgradeReq.socket.remoteAddress;
  } else if (ws._req && ws._req.socket && ws._req.socket.remoteAddress) {
    clientIP = ws._req.socket.remoteAddress;
  }
  clientIPs.set(ws, clientIP);
  
  const connectionState = {
    isAuthenticated: false
  };

  // heartbeat & token refresh
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  const HEARTBEAT_INTERVAL_MS = 30000;
  const PROGRESS_REQUEST_INTERVAL_MS = 30000; // 定时器 tick 间隔
  const FIRST_PROGRESS_DELAY_MS = 30000; // 任务开始后首次请求进度的延迟
  const NEXT_PROGRESS_DELAY_MS = 60000; // 之后每次请求进度的间隔
  let heartbeatCount = 0; // 心跳计数器，用于控制machine检查频率
  const MACHINE_CHECK_INTERVAL = 2; // 每2次心跳（60秒）检查一次machine
  
  // 进度请求定时器：每30秒向客户端请求运行中任务的进度
  const progressRequestInterval = setInterval(() => {
    if (ws.readyState === ws.CLOSED || ws.readyState === ws.CLOSING) {
      return;
    }
    
    const connInfo = authenticatedConnections.get(ws);
    if (!connInfo || !connInfo.userId) {
      return;
    }

    // 查找该连接上的所有运行中任务
    for (const [taskId, taskInfo] of runningTasks.entries()) {
      if (taskInfo.ws === ws && taskInfo.userId === connInfo.userId) {
        const now = Date.now();
        const requestCount = typeof taskInfo.progressRequestCount === 'number'
          ? taskInfo.progressRequestCount
          : 0;

        // 第一次请求使用 30 秒延迟，之后使用 60 秒间隔
        const requiredDelay = requestCount === 0 ? FIRST_PROGRESS_DELAY_MS : NEXT_PROGRESS_DELAY_MS;

        if (!taskInfo.lastProgressRequest || (now - taskInfo.lastProgressRequest) >= requiredDelay) {
          try {
            ws.send(JSON.stringify({
              type: 'task_progress_request',
              taskId: taskId
            }));
            runningTasks.set(taskId, {
              ...taskInfo,
              lastProgressRequest: now,
              progressRequestCount: requestCount + 1
            });
            console.log(`[progress] Requested progress for task ${taskId} (count=${requestCount + 1})`);
          } catch (error) {
            console.error(`[progress] Failed to request progress for task ${taskId}:`, error);
          }
        }
      }
    }
  }, PROGRESS_REQUEST_INTERVAL_MS);

  const heartbeatInterval = setInterval(async () => {
    if (ws.readyState === ws.CLOSED || ws.readyState === ws.CLOSING) {
      return;
    }
    if (ws.isAlive === false) {
      console.log('Terminating stale connection (no pong received)');
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    await checkAndRefreshToken(ws).catch(() => {});
    
    // 每2次心跳（60秒）检查一次machine是否被删除
    heartbeatCount++;
    if (heartbeatCount % MACHINE_CHECK_INTERVAL === 0) {
      const connInfo = authenticatedConnections.get(ws);
      const sysInfo = clientSystemInfo.get(ws);
      if (connInfo && sysInfo && connInfo.userId) {
        const machineIdentifier = (sysInfo.machineName && sysInfo.machineName !== 'unknown') 
          ? sysInfo.machineName 
          : (sysInfo.ip && sysInfo.ip !== 'unknown' ? sysInfo.ip : null);
        
        if (machineIdentifier) {
          const hwid = sysInfo ? sysInfo.hwid : null;
          const machineCheck = await checkMachineExists(connInfo.userId, machineIdentifier, hwid);
          if (!machineCheck.exists) {
            console.log(`Machine ${machineIdentifier} deleted for user ${connInfo.userId}, closing connection`);
            try {
              await removeMachineName(connInfo.userId, machineIdentifier).catch(() => {});
              // 发送machine_deleted消息
              const message = JSON.stringify({
                type: 'machine_deleted',
                message: 'Your machine has been deleted. Please re-authenticate.'
              });
              
              // 检查连接状态
              if (ws.readyState === ws.OPEN) {
                ws.send(message);
                // 给足够时间让消息发送出去，然后关闭连接
                setTimeout(() => {
                  if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
                    ws.close(1000, 'Machine deleted');
                  }
                }, 500);
              } else {
                // 连接已关闭，直接清理
                cleanupConnection(ws);
              }
            } catch (error) {
              console.error('Error sending machine_deleted message:', error);
              // 即使发送失败也关闭连接
              if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
                ws.close(1000, 'Machine deleted');
              }
            }
            return;
          }
        }
      }
    }
    
    ws.ping();
  }, HEARTBEAT_INTERVAL_MS);

  // 处理消息
  ws.on('message', async (message) => {
    await handleMessage(ws, connectionState, message);
  });

  // 处理连接关闭
  ws.on('close', async () => {
    clearInterval(heartbeatInterval);
    clearInterval(progressRequestInterval);
    // 清理该连接上的所有运行中任务
    const connInfo = authenticatedConnections.get(ws);
    if (connInfo && connInfo.userId) {
      for (const [taskId, taskInfo] of runningTasks.entries()) {
        if (taskInfo.ws === ws && taskInfo.userId === connInfo.userId) {
          runningTasks.delete(taskId);
        }
      }
    }
    await handleClose(ws, connectionState);
  });

  // 处理错误
  ws.on('error', (error) => {
    clearInterval(heartbeatInterval);
    clearInterval(progressRequestInterval);
    // 清理该连接上的所有运行中任务
    for (const [taskId, taskInfo] of runningTasks.entries()) {
      if (taskInfo.ws === ws) {
        runningTasks.delete(taskId);
      }
    }
    handleError(ws, error, connectionState);
  });

  return connectionState;
}
