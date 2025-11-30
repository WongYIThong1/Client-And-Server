import { createServer, createWebSocketServer, startServer, shutdownServer } from './server.js';
import { setupConnection } from './websocket/connection.js';
import { colorBanner } from './utils/banner.js';

colorBanner();

const { server, useTLS } = createServer();
const wss = createWebSocketServer(server, useTLS);

wss.on('connection', (ws) => {
  setupConnection(ws);
});

startServer(server, useTLS);

process.on('SIGINT', () => {
  shutdownServer(wss, server);
});

console.log('Server initialized');
