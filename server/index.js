import { WebSocketServer } from 'ws';
import https from 'https';
import http from 'http';
import fs from 'fs';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import { verifyApiKey } from './supabase.js';

dotenv.config();

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this-in-production';

// 创建HTTPS服务器（用于WSS）
// 注意：开发环境可以使用自签名证书，生产环境应使用有效证书
let server;
let useTLS = false;

// 尝试加载TLS证书（如果存在）
try {
  if (fs.existsSync('./cert.pem') && fs.existsSync('./key.pem')) {
    const options = {
      cert: fs.readFileSync('./cert.pem'),
      key: fs.readFileSync('./key.pem')
    };
    server = https.createServer(options);
    useTLS = true;
    console.log('TLS enabled - using WSS');
  } else {
    console.log('TLS certificates not found - using WS (not recommended for production)');
    console.log('To enable WSS, create cert.pem and key.pem files');
  }
} catch (error) {
  console.log('TLS setup failed, using WS:', error.message);
}

// 如果没有HTTPS服务器，创建一个简单的HTTP服务器（仅用于开发）
if (!server) {
  server = http.createServer();
}

// 创建WebSocket服务器
const wss = useTLS 
  ? new WebSocketServer({ server })
  : new WebSocketServer({ port: PORT });

// 如果使用HTTPS，需要监听端口
if (useTLS) {
  server.listen(PORT, () => {
    console.log(`WebSocket server listening on ${useTLS ? 'wss' : 'ws'}://localhost:${PORT}`);
  });
} else {
  console.log(`WebSocket server listening on ws://localhost:${PORT}`);
}

// 存储已认证的连接
const authenticatedConnections = new Map();

// Token黑名单（用于撤销token）
const tokenBlacklist = new Set();

// Access Token有效期：15分钟（更安全）
const ACCESS_TOKEN_EXPIRY = '15m';
// Refresh Token有效期：7天
const REFRESH_TOKEN_EXPIRY = '7d';

// 生成access token（短期有效）
function generateAccessToken(userId) {
  return jwt.sign(
    { 
      userId, 
      type: 'access',
      timestamp: Date.now() 
    },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
}

// 生成refresh token（长期有效，用于刷新access token）
function generateRefreshToken(userId) {
  return jwt.sign(
    { 
      userId, 
      type: 'refresh',
      timestamp: Date.now() 
    },
    JWT_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRY }
  );
}

// 验证token
function verifyToken(token) {
  try {
    // 检查token是否在黑名单中
    if (tokenBlacklist.has(token)) {
      return null;
    }
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

// 撤销token（加入黑名单）
function revokeToken(token) {
  tokenBlacklist.add(token);
  // 定期清理过期的token（简化处理，实际应该基于过期时间）
  if (tokenBlacklist.size > 10000) {
    tokenBlacklist.clear(); // 简单清理，生产环境应该更智能
  }
}

// 心跳间隔（30秒）
const HEARTBEAT_INTERVAL = 30000;

wss.on('connection', (ws, req) => {
  console.log('New client connected');
  
  let isAuthenticated = false;
  let sessionToken = null;
  let heartbeatInterval = null;
  let pongReceived = true;

  // 发送ping消息
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

  // 处理消息
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());
      
      // 处理心跳响应
      if (data.type === 'pong') {
        pongReceived = true;
        return;
      }

      // 处理认证请求
      if (data.type === 'auth') {
        if (isAuthenticated) {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Already authenticated'
          }));
          return;
        }

        const apiKey = data.apiKey;
        if (!apiKey) {
          ws.send(JSON.stringify({
            type: 'auth_failed',
            message: 'API Key is required'
          }));
          return;
        }

        // 验证API Key
        const verification = await verifyApiKey(apiKey);
        
        if (verification.valid) {
          isAuthenticated = true;
          const accessToken = generateAccessToken(verification.userId);
          const refreshToken = generateRefreshToken(verification.userId);
          sessionToken = accessToken;
          
          authenticatedConnections.set(ws, {
            userId: verification.userId,
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

          // 开始心跳
          startHeartbeat();
          console.log(`Client authenticated: User ID ${verification.userId}`);
        } else {
          ws.send(JSON.stringify({
            type: 'auth_failed',
            message: 'Invalid API Key'
          }));
          console.log('Authentication failed: Invalid API Key');
        }
        return;
      }

      // 处理refresh token请求
      if (data.type === 'refresh_token') {
        const refreshToken = data.refreshToken;
        if (!refreshToken) {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Refresh token is required'
          }));
          return;
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
        return;
      }

      // 处理已认证的请求
      if (!isAuthenticated) {
        // 检查是否有access token
        if (data.accessToken) {
          const decoded = verifyToken(data.accessToken);
          if (decoded && decoded.type === 'access') {
            isAuthenticated = true;
            sessionToken = data.accessToken;
            authenticatedConnections.set(ws, {
              userId: decoded.userId,
              accessToken: data.accessToken,
              connectedAt: Date.now()
            });
            startHeartbeat();
          } else {
            // Token可能过期，尝试使用refresh token
            if (data.refreshToken) {
              const refreshDecoded = verifyToken(data.refreshToken);
              if (refreshDecoded && refreshDecoded.type === 'refresh') {
                // 自动刷新token
                revokeToken(data.refreshToken);
                const newAccessToken = generateAccessToken(refreshDecoded.userId);
                const newRefreshToken = generateRefreshToken(refreshDecoded.userId);
                
                isAuthenticated = true;
                sessionToken = newAccessToken;
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
                
                startHeartbeat();
              } else {
                ws.send(JSON.stringify({
                  type: 'error',
                  message: 'Invalid or expired tokens. Please re-authenticate.'
                }));
                return;
              }
            } else {
              ws.send(JSON.stringify({
                type: 'error',
                message: 'Invalid or expired access token'
              }));
              return;
            }
          }
        } else {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Authentication required'
          }));
          return;
        }
      }

      // 检查Access Token是否即将过期（还剩5分钟），如果是则自动刷新
      const connInfo = authenticatedConnections.get(ws);
      if (connInfo && connInfo.refreshToken) {
        try {
          const decoded = verifyToken(connInfo.accessToken);
          if (decoded) {
            // 计算token剩余时间（JWT的exp是秒，Date.now()是毫秒）
            const remainingTime = (decoded.exp * 1000) - Date.now();
            const fiveMinutes = 5 * 60 * 1000; // 5分钟（毫秒）
            
            // 如果剩余时间少于5分钟，自动刷新
            if (remainingTime < fiveMinutes && remainingTime > 0) {
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
                sessionToken = newAccessToken;
                
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
              sessionToken = newAccessToken;
              
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

      // 处理其他消息类型
      if (data.type === 'data') {
        // 处理实时数据更新请求
        // 这里可以添加业务逻辑
        ws.send(JSON.stringify({
          type: 'data',
          message: 'Data received',
          timestamp: Date.now()
        }));
      }

    } catch (error) {
      console.error('Error processing message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message format'
      }));
    }
  });

  // 处理连接关闭
  ws.on('close', () => {
    console.log('Client disconnected');
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }
    // 撤销token（可选：如果希望关闭连接时撤销token）
    const connInfo = authenticatedConnections.get(ws);
    if (connInfo && connInfo.refreshToken) {
      // 注意：这里可以选择是否撤销，撤销后用户需要重新认证
      // revokeToken(connInfo.refreshToken);
    }
    authenticatedConnections.delete(ws);
  });

  // 处理错误
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }
    authenticatedConnections.delete(ws);
  });
});

// 优雅关闭
process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  wss.close(() => {
    if (server && server.close) {
      server.close(() => {
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  });
});

console.log('Server initialized');

