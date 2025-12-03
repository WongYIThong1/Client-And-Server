import { createServer, createWebSocketServer, startServer, shutdownServer } from './server.js';
import { setupConnection } from './websocket/connection.js';
import { colorBanner } from './utils/banner.js';
import { startTaskRealtimeListener } from './realtime/tasks.js';
import { startMachineRealtimeListener } from './realtime/machines.js';
import { pauseAllRunningTasksOnStartup } from './supabase.js';

colorBanner();

// 启动时先把所有 running 任务标记为 paused，避免“脏运行状态”在重启后残留
// 不阻塞整个进程的启动流程，即使失败也只记录日志。
pauseAllRunningTasksOnStartup().then(() => {
  console.log('[startup] pauseAllRunningTasksOnStartup completed');
}).catch(() => {
  // 具体错误已在函数内部记录，这里忽略即可
});

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
