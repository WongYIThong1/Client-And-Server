import { HEARTBEAT_INTERVAL } from '../config.js';
import { authenticatedConnections, cleanupConnection } from '../stores.js';
import { setMachineOffline } from '../supabase.js';
import { handleAuth, handleRefreshToken, handleTokenAuth, checkAndRefreshToken } from '../auth/handlers.js';
import { handleSystemInfo, handleHeartbeat, handleData, handlePong, handleDisconnect } from './handlers.js';

/**
 * 设置WebSocket连接的心跳机制
 * @param {WebSocket} ws - WebSocket连接
 * @returns {Function} 返回停止心跳的函数
 */
export function setupHeartbeat(ws) {
  let heartbeatInterval = null;
  let pongReceived = true;

  const startHeartbeat = () => {
    heartbeatInterval = setInterval(() => {
      if (!pongReceived) {
        console.log('Pong timeout, closing connection');
        ws.terminate();
        return;
      }
      pongReceived = false;
      try {
        ws.send(JSON.stringify({ type: 'ping' }));
      } catch (error) {
        console.error('Error sending ping:', error);
      }
    }, HEARTBEAT_INTERVAL);
  };

  const stopHeartbeat = () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  };

  // 返回停止心跳的函数和设置pong接收状态的函数
  return {
    start: startHeartbeat,
    stop: stopHeartbeat,
    setPongReceived: () => { pongReceived = true; }
  };
}

/**
 * 处理WebSocket消息
 * @param {WebSocket} ws - WebSocket连接
 * @param {object} connectionState - 连接状态对象
 * @param {Buffer} message - 接收到的消息
 */
export async function handleMessage(ws, connectionState, message) {
  try {
    const data = JSON.parse(message.toString());
    
    // 处理心跳响应
    if (handlePong(data)) {
      connectionState.heartbeat.setPongReceived();
      return;
    }

    // 处理认证请求
    const authResult = await handleAuth(ws, data);
    if (authResult === true) {
      return; // 认证失败，已发送错误消息
    }
    if (authResult && authResult.authenticated) {
      connectionState.isAuthenticated = true;
      connectionState.heartbeat.start();
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
          connectionState.heartbeat.start();
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

    // 处理system_info消息
    if (await handleSystemInfo(ws, data, connectionState.isAuthenticated)) {
      return;
    }

    // 处理heartbeat消息
    if (await handleHeartbeat(ws, data, connectionState.isAuthenticated)) {
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
  console.log('Client disconnected');
  connectionState.heartbeat.stop();
  
  // 如果已认证，更新机器状态为离线（处理强制关闭的情况）
  const connInfo = authenticatedConnections.get(ws);
  const sysInfo = clientSystemInfo.get(ws);
  
  if (connInfo && sysInfo) {
    const userId = connInfo.userId;
    const ip = sysInfo.ip;
    
    if (userId && ip && ip !== 'unknown') {
      // 异步更新状态，不阻塞关闭流程
      setMachineOffline(userId, ip).then(result => {
        if (result.success) {
          console.log(`Machine set to offline (forced disconnect): user ${userId}, IP ${ip}`);
        } else {
          console.error(`Failed to set machine offline: ${result.error}`);
        }
      }).catch(error => {
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
  connectionState.heartbeat.stop();
  cleanupConnection(ws);
}

/**
 * 创建并设置WebSocket连接
 * @param {WebSocket} ws - WebSocket连接
 */
export function setupConnection(ws) {
  console.log('New client connected');
  
  const connectionState = {
    isAuthenticated: false,
    heartbeat: setupHeartbeat(ws)
  };

  // 处理消息
  ws.on('message', async (message) => {
    await handleMessage(ws, connectionState, message);
  });

  // 处理连接关闭
  ws.on('close', async () => {
    await handleClose(ws, connectionState);
  });

  // 处理错误
  ws.on('error', (error) => {
    handleError(ws, error, connectionState);
  });

  return connectionState;
}

