import { WebSocketServer } from 'ws';
import https from 'https';
import http from 'http';
import fs from 'fs';
import { PORT } from './config.js';
import { authenticatedConnections, clientSystemInfo } from './stores.js';
import { setMachineOffline } from './supabase.js';

/**
 * 创建HTTP/HTTPS服务器
 * @returns {object} {server, useTLS}
 */
export function createServer() {
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
    }
  } catch (error) {
    // TLS setup failed, fallback to WS
  }

  // 如果没有HTTPS服务器，创建一个简单的HTTP服务器（仅用于开发）
  if (!server) {
    server = http.createServer();
  }

  return { server, useTLS };
}

/**
 * 创建WebSocket服务器
 * @param {object} httpServer - HTTP/HTTPS服务器
 * @param {boolean} useTLS - 是否使用TLS
 * @returns {WebSocketServer} WebSocket服务器实例
 */
export function createWebSocketServer(httpServer, useTLS) {
  const wss = useTLS 
    ? new WebSocketServer({ server: httpServer })
    : new WebSocketServer({ port: PORT });

  return wss;
}

/**
 * 启动服务器
 * @param {object} server - HTTP/HTTPS服务器
 * @param {boolean} useTLS - 是否使用TLS
 */
export function startServer(server, useTLS) {
  if (useTLS) {
    server.listen(PORT, () => {
      console.log(`Server listening on wss://localhost:${PORT}`);
    });
  } else {
    console.log(`Server listening on ws://localhost:${PORT}`);
  }
}

/**
 * 优雅关闭服务器
 * @param {WebSocketServer} wss - WebSocket服务器
 * @param {object} httpServer - HTTP/HTTPS服务器
 */
export function shutdownServer(wss, httpServer) {
  // 将已认证的机器标记为离线（最佳努力）
  const offlineTasks = [];
  for (const [ws, connInfo] of authenticatedConnections.entries()) {
    const sysInfo = clientSystemInfo.get(ws);
    const machineIdentifier = sysInfo
      ? (sysInfo.machineName && sysInfo.machineName !== 'unknown'
          ? sysInfo.machineName
          : (sysInfo.ip && sysInfo.ip !== 'unknown' ? sysInfo.ip : null))
      : null;
    if (connInfo?.userId && machineIdentifier) {
      offlineTasks.push(
        setMachineOffline(connInfo.userId, machineIdentifier).catch((err) => {
          console.error(`Failed to set machine offline for user ${connInfo.userId}:`, err);
        })
      );
    }
  }

  Promise.all(offlineTasks).finally(() => {
    wss.close(() => {
      if (httpServer && httpServer.close && httpServer.listening) {
        httpServer.close(() => {
          process.exit(0);
        });
      } else {
        process.exit(0);
      }
    });
  });
}

