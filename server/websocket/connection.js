import { authenticatedConnections, cleanupConnection, clientSystemInfo } from '../stores.js';
import { setMachineOffline } from '../supabase.js';
import { handleAuth, handleRefreshToken, handleTokenAuth, checkAndRefreshToken } from '../auth/handlers.js';
import { handleSystemInfo, handleData, handleDisconnect } from './handlers.js';

/**
 * 处理WebSocket消息
 * @param {WebSocket} ws - WebSocket连接
 * @param {object} connectionState - 连接状态对象
 * @param {Buffer} message - 接收到的消息
 */
export async function handleMessage(ws, connectionState, message) {
  try {
    const data = JSON.parse(message.toString());

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
  console.log('Client disconnected');
  
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
      setMachineOffline(userId, machineIdentifier).then(result => {
        if (result.success) {
          console.log(`Machine set to offline (forced disconnect): user ${userId}, machineName ${machineIdentifier}`);
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
  cleanupConnection(ws);
}

/**
 * 创建并设置WebSocket连接
 * @param {WebSocket} ws - WebSocket连接
 */
export function setupConnection(ws) {
  console.log('New client connected');
  
  const connectionState = {
    isAuthenticated: false
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

