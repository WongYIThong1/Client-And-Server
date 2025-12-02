import { createServer, createWebSocketServer, startServer, shutdownServer } from './server.js';
import { setupConnection } from './websocket/connection.js';
import { colorBanner } from './utils/banner.js';
import { startTaskRealtimeListener } from './realtime/tasks.js';
import { startMachineRealtimeListener } from './realtime/machines.js';

colorBanner();

const { server, useTLS } = createServer();
const wss = createWebSocketServer(server, useTLS);

// Start Supabase Realtime listeners after WS server is ready
const taskChannel = startTaskRealtimeListener();
const machineChannel = startMachineRealtimeListener();

wss.on('connection', (ws) => {
  setupConnection(ws);
});

startServer(server, useTLS);

process.on('SIGINT', () => {
  try {
    if (taskChannel && taskChannel.unsubscribe) {
      taskChannel.unsubscribe();
    }
    if (machineChannel && machineChannel.unsubscribe) {
      machineChannel.unsubscribe();
    }
  } catch {
    // ignore
  }
  shutdownServer(wss, server);
});

console.log('Server initialized');
