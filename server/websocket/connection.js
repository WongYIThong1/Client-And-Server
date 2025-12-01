import { authenticatedConnections, cleanupConnection, clientSystemInfo, clientIPs } from '../stores.js';
import { setMachineOffline, checkPlanExpired, checkMachineExists } from '../supabase.js';
import { handleAuth, handleRefreshToken, handleTokenAuth, checkAndRefreshToken } from '../auth/handlers.js';
import { handleSystemInfo, handleData, handleDisconnect } from './handlers.js';
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
      // 认证请求速率限制
      if (isRateLimited(clientIP, 'auth')) {
        const remaining = getRemainingRequests(clientIP, 'auth');
        ws.send(JSON.stringify({
          type: 'error',
          message: `Rate limit exceeded. Too many authentication attempts. Please try again later.`
        }));
        console.log(`Rate limit exceeded for auth from IP: ${clientIP}`);
        return;
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
    
    // 使用电脑名字作为机器标识（如果为空或unknown，则使用IP作为备用）
    const machineIdentifier = (sysInfo.machineName && sysInfo.machineName !== 'unknown') 
      ? sysInfo.machineName 
      : (sysInfo.ip && sysInfo.ip !== 'unknown' ? sysInfo.ip : null);
    
    if (userId && machineIdentifier) {
      // 异步更新状态，不阻塞关闭流程
      setMachineOffline(userId, machineIdentifier).catch(error => {
        console.error('Error setting machine offline:', error);
      });
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
    
    // 检查machine是否被删除
    const connInfo = authenticatedConnections.get(ws);
    const sysInfo = clientSystemInfo.get(ws);
    if (connInfo && sysInfo && connInfo.userId) {
      const machineIdentifier = (sysInfo.machineName && sysInfo.machineName !== 'unknown') 
        ? sysInfo.machineName 
        : (sysInfo.ip && sysInfo.ip !== 'unknown' ? sysInfo.ip : null);
      
      if (machineIdentifier) {
        const machineCheck = await checkMachineExists(connInfo.userId, machineIdentifier);
        if (!machineCheck.exists) {
          console.log(`Machine ${machineIdentifier} deleted for user ${connInfo.userId}, closing connection`);
          ws.send(JSON.stringify({
            type: 'machine_deleted',
            message: 'Your machine has been deleted. Please re-authenticate.'
          }));
          setTimeout(() => {
            ws.close();
          }, 100);
          return;
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
    await handleClose(ws, connectionState);
  });

  // 处理错误
  ws.on('error', (error) => {
    clearInterval(heartbeatInterval);
    handleError(ws, error, connectionState);
  });

  return connectionState;
}
