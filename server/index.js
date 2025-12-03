import { createServer, createWebSocketServer, startServer, shutdownServer } from './server.js';
import { setupConnection } from './websocket/connection.js';
import { colorBanner } from './utils/banner.js';
import { startTaskRealtimeListener, clearMachineCache, stopMachineCacheCleanup } from './realtime/tasks.js';
import { startMachineRealtimeListener, setClearMachineCacheFunction } from './realtime/machines.js';
import { pauseAllRunningTasksOnStartup, startTaskCleanupScheduler, startTaskCacheCleanup, stopTaskCacheCleanup } from './supabase.js';
import { startProgressQueueProcessor, stopProgressQueueProcessor } from './utils/progressQueue.js';

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
const { channel: taskChannel, queueProcessorInterval: taskQueueInterval } = startTaskRealtimeListener();
const machineChannel = startMachineRealtimeListener();

// 设置machine缓存清除函数（当机器信息更新时清除缓存）
setClearMachineCacheFunction(clearMachineCache);

// 启动任务清理调度器（定期清理已完成/失败的任务）
const cleanupInterval = startTaskCleanupScheduler();

// 启动任务验证缓存定期清理
startTaskCacheCleanup();

// 启动进度更新队列处理器（批量处理任务进度更新）
startProgressQueueProcessor();

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
    // 清理任务清理定时器
    if (cleanupInterval) {
      clearInterval(cleanupInterval);
    }
    // 停止进度队列处理器
    stopProgressQueueProcessor();
    // 清理任务创建队列处理器
    if (taskQueueInterval) {
      clearInterval(taskQueueInterval);
    }
    // 停止任务验证缓存清理
    stopTaskCacheCleanup();
    // 停止machine缓存清理
    stopMachineCacheCleanup();
  } catch {
    // ignore
  }
  shutdownServer(wss, server);
});

console.log('Server initialized');
