import { WebSocketServer } from 'ws';
import https from 'https';
import http from 'http';
import fs from 'fs';
import { PORT } from './config.js';

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
      console.log(`WebSocket server listening on ${useTLS ? 'wss' : 'ws'}://localhost:${PORT}`);
    });
  } else {
    console.log(`WebSocket server listening on ws://localhost:${PORT}`);
  }
}

/**
 * 优雅关闭服务器
 * @param {WebSocketServer} wss - WebSocket服务器
 * @param {object} httpServer - HTTP/HTTPS服务器
 */
export function shutdownServer(wss, httpServer) {
  console.log('\nShutting down server...');
  wss.close(() => {
    if (httpServer && httpServer.close) {
      httpServer.close(() => {
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  });
}

