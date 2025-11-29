import { verifyApiKey } from '../supabase.js';
import { generateAccessToken, generateRefreshToken, verifyToken, revokeToken, isTokenExpiringSoon } from './token.js';
import { authenticatedConnections } from '../stores.js';
import { TOKEN_AUTO_REFRESH_THRESHOLD } from '../config.js';

/**
 * 处理认证请求
 * @param {WebSocket} ws - WebSocket连接
 * @param {object} data - 消息数据
 * @returns {Promise<boolean>} 返回true表示已处理，false表示需要继续处理
 */
export async function handleAuth(ws, data) {
  if (data.type !== 'auth') {
    return false;
  }

  const apiKey = data.apiKey;
  if (!apiKey) {
    ws.send(JSON.stringify({
      type: 'auth_failed',
      message: 'API Key is required'
    }));
    return true;
  }

  // 清理API Key（去除首尾空格）
  const cleanApiKey = apiKey.trim();
  console.log(`Received API Key for verification (length: ${cleanApiKey.length})`);

  // 验证API Key
  const verification = await verifyApiKey(cleanApiKey);
  
  if (verification.valid) {
    const accessToken = generateAccessToken(verification.userId);
    const refreshToken = generateRefreshToken(verification.userId);
    
    authenticatedConnections.set(ws, {
      userId: verification.userId,
      apiKey: cleanApiKey, // 存储API Key以便后续保存机器信息
      accessToken,
      refreshToken,
      connectedAt: Date.now()
    });

    ws.send(JSON.stringify({
      type: 'auth_success',
      accessToken: accessToken,
      refreshToken: refreshToken,
      message: 'Authentication successful'
    }));

    console.log(`Client authenticated: User ID ${verification.userId}`);
    return { authenticated: true, userId: verification.userId };
  } else {
    ws.send(JSON.stringify({
      type: 'auth_failed',
      message: 'Invalid API Key'
    }));
    console.log('Authentication failed: Invalid API Key');
    return true;
  }
}

/**
 * 处理refresh token请求
 * @param {WebSocket} ws - WebSocket连接
 * @param {object} data - 消息数据
 * @returns {Promise<boolean>} 返回true表示已处理
 */
export async function handleRefreshToken(ws, data) {
  if (data.type !== 'refresh_token') {
    return false;
  }

  const refreshToken = data.refreshToken;
  if (!refreshToken) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Refresh token is required'
    }));
    return true;
  }

  const decoded = verifyToken(refreshToken);
  if (decoded && decoded.type === 'refresh') {
    // 撤销旧的refresh token
    revokeToken(refreshToken);
    
    // 生成新的token对
    const newAccessToken = generateAccessToken(decoded.userId);
    const newRefreshToken = generateRefreshToken(decoded.userId);
    
    ws.send(JSON.stringify({
      type: 'token_refreshed',
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      message: 'Token refreshed successfully'
    }));
    
    // 更新连接信息
    const connInfo = authenticatedConnections.get(ws);
    if (connInfo) {
      connInfo.accessToken = newAccessToken;
      connInfo.refreshToken = newRefreshToken;
    }
  } else {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Invalid or expired refresh token'
    }));
  }
  
  return true;
}

/**
 * 验证并处理token认证
 * @param {WebSocket} ws - WebSocket连接
 * @param {object} data - 消息数据
 * @returns {Promise<boolean>} 返回true表示已认证，false表示认证失败
 */
export async function handleTokenAuth(ws, data) {
  if (!data.accessToken) {
    return false;
  }

  const decoded = verifyToken(data.accessToken);
  if (decoded && decoded.type === 'access') {
    authenticatedConnections.set(ws, {
      userId: decoded.userId,
      accessToken: data.accessToken,
      connectedAt: Date.now()
    });
    return true;
  } else {
    // Token可能过期，尝试使用refresh token
    if (data.refreshToken) {
      const refreshDecoded = verifyToken(data.refreshToken);
      if (refreshDecoded && refreshDecoded.type === 'refresh') {
        // 自动刷新token
        revokeToken(data.refreshToken);
        const newAccessToken = generateAccessToken(refreshDecoded.userId);
        const newRefreshToken = generateRefreshToken(refreshDecoded.userId);
        
        authenticatedConnections.set(ws, {
          userId: refreshDecoded.userId,
          accessToken: newAccessToken,
          refreshToken: newRefreshToken,
          connectedAt: Date.now()
        });
        
        ws.send(JSON.stringify({
          type: 'token_refreshed',
          accessToken: newAccessToken,
          refreshToken: newRefreshToken
        }));
        
        return true;
      } else {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Invalid or expired tokens. Please re-authenticate.'
        }));
        return false;
      }
    } else {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid or expired access token'
      }));
      return false;
    }
  }
}

/**
 * 检查并自动刷新即将过期的token
 * @param {WebSocket} ws - WebSocket连接
 * @returns {Promise<void>}
 */
export async function checkAndRefreshToken(ws) {
  const connInfo = authenticatedConnections.get(ws);
  if (!connInfo || !connInfo.refreshToken) {
    return;
  }

  try {
    const decoded = verifyToken(connInfo.accessToken);
    if (decoded) {
      // 检查是否即将过期
      if (isTokenExpiringSoon(decoded, TOKEN_AUTO_REFRESH_THRESHOLD)) {
        const refreshDecoded = verifyToken(connInfo.refreshToken);
        if (refreshDecoded && refreshDecoded.type === 'refresh') {
          // 撤销旧的refresh token
          revokeToken(connInfo.refreshToken);
          
          // 生成新的token对
          const newAccessToken = generateAccessToken(refreshDecoded.userId);
          const newRefreshToken = generateRefreshToken(refreshDecoded.userId);
          
          // 更新连接信息
          connInfo.accessToken = newAccessToken;
          connInfo.refreshToken = newRefreshToken;
          
          // 发送新的token给客户端
          ws.send(JSON.stringify({
            type: 'token_refreshed',
            accessToken: newAccessToken,
            refreshToken: newRefreshToken,
            message: 'Token automatically refreshed'
          }));
          
          console.log(`Token auto-refreshed for user ${refreshDecoded.userId}`);
        }
      }
    } else {
      // Access Token已过期，尝试使用Refresh Token刷新
      const refreshDecoded = verifyToken(connInfo.refreshToken);
      if (refreshDecoded && refreshDecoded.type === 'refresh') {
        revokeToken(connInfo.refreshToken);
        const newAccessToken = generateAccessToken(refreshDecoded.userId);
        const newRefreshToken = generateRefreshToken(refreshDecoded.userId);
        
        connInfo.accessToken = newAccessToken;
        connInfo.refreshToken = newRefreshToken;
        
        ws.send(JSON.stringify({
          type: 'token_refreshed',
          accessToken: newAccessToken,
          refreshToken: newRefreshToken,
          message: 'Token automatically refreshed (expired)'
        }));
        
        console.log(`Token auto-refreshed (expired) for user ${refreshDecoded.userId}`);
      }
    }
  } catch (error) {
    // Token验证失败，忽略错误继续处理
  }
}

