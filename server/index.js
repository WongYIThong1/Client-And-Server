import { createServer, createWebSocketServer, startServer, shutdownServer } from './server.js';
import { setupConnection } from './websocket/connection.js';

// 创建HTTP/HTTPS服务器
const { server, useTLS } = createServer();

// 创建WebSocket服务器
const wss = createWebSocketServer(server, useTLS);

// 设置WebSocket连接处理
wss.on('connection', (ws) => {
  setupConnection(ws);
});

// 启动服务器
startServer(server, useTLS);

// 优雅关闭
process.on('SIGINT', () => {
  shutdownServer(wss, server);
});

console.log('Server initialized');
