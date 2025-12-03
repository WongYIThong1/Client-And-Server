// Connection state stores
export const authenticatedConnections = new Map(); // Map<WebSocket, {userId, apiKey, accessToken, refreshToken, connectedAt, machineId}>
export const clientSystemInfo = new Map(); // Map<WebSocket, {ip, ram, cpuCores, machineName, receivedAt}>
export const clientIPs = new Map(); // Map<WebSocket, string> - 存储客户端IP地址
export const tokenBlacklist = new Set();
export const runningTasks = new Map(); // Map<taskId, {ws, userId, machineId, lastProgressRequest, progressRequestCount}> - 正在运行的任务
export const taskAssignments = new Map(); // Map<taskId, {userId, machineId}>

// 优化：按连接索引的任务映射，避免遍历所有任务
// Map<WebSocket, Set<taskId>> - 每个连接维护自己的任务列表
export const tasksByConnection = new Map();

// 优化：连接索引，用于快速查找WebSocket连接
// Map<userId, Map<identifier, WebSocket>> - 按userId和identifier(hwid/name)索引
// identifier格式: "hwid:xxx" 或 "name:xxx"
export const connectionIndex = new Map();

/**
 * 添加任务到连接的索引
 * @param {WebSocket} ws - WebSocket连接
 * @param {string} taskId - 任务ID
 */
export function addTaskToConnection(ws, taskId) {
  if (!ws || !taskId) return;
  
  if (!tasksByConnection.has(ws)) {
    tasksByConnection.set(ws, new Set());
  }
  tasksByConnection.get(ws).add(taskId);
}

/**
 * 从连接的索引中移除任务
 * @param {WebSocket} ws - WebSocket连接
 * @param {string} taskId - 任务ID
 */
export function removeTaskFromConnection(ws, taskId) {
  if (!ws || !taskId) return;
  
  const taskSet = tasksByConnection.get(ws);
  if (taskSet) {
    taskSet.delete(taskId);
    // 如果连接没有任务了，清理索引
    if (taskSet.size === 0) {
      tasksByConnection.delete(ws);
    }
  }
}

/**
 * 获取连接的所有任务ID
 * @param {WebSocket} ws - WebSocket连接
 * @returns {Set<string>} 任务ID集合
 */
export function getTasksByConnection(ws) {
  return tasksByConnection.get(ws) || new Set();
}

/**
 * 将连接添加到索引中，用于快速查找
 * @param {WebSocket} ws - WebSocket连接
 * @param {string} userId - 用户ID
 * @param {string|null} hwid - 硬件ID
 * @param {string|null} machineName - 机器名称
 */
export function addConnectionToIndex(ws, userId, hwid, machineName) {
  if (!ws || !userId) return;

  if (!connectionIndex.has(userId)) {
    connectionIndex.set(userId, new Map());
  }

  const userConnections = connectionIndex.get(userId);

  // 优先使用hwid索引
  if (hwid) {
    userConnections.set(`hwid:${hwid}`, ws);
  }

  // 其次使用machineName索引
  if (machineName && machineName !== 'unknown') {
    userConnections.set(`name:${machineName}`, ws);
  }
}

/**
 * 从索引中移除连接
 * @param {WebSocket} ws - WebSocket连接
 * @param {string} userId - 用户ID
 * @param {string|null} hwid - 硬件ID
 * @param {string|null} machineName - 机器名称
 */
export function removeConnectionFromIndex(ws, userId, hwid, machineName) {
  if (!ws || !userId) return;

  const userConnections = connectionIndex.get(userId);
  if (!userConnections) return;

  // 移除hwid索引
  if (hwid) {
    const hwidKey = `hwid:${hwid}`;
    if (userConnections.get(hwidKey) === ws) {
      userConnections.delete(hwidKey);
    }
  }

  // 移除machineName索引
  if (machineName && machineName !== 'unknown') {
    const nameKey = `name:${machineName}`;
    if (userConnections.get(nameKey) === ws) {
      userConnections.delete(nameKey);
    }
  }

  // 如果用户没有连接了，清理用户索引
  if (userConnections.size === 0) {
    connectionIndex.delete(userId);
  }
}

/**
 * 通过userId和machine信息快速查找WebSocket连接（O(1)复杂度）
 * @param {string} userId - 用户ID
 * @param {{hwid: string|null, name: string|null}} machine - 机器信息
 * @returns {WebSocket|null}
 */
export function findConnectionByMachine(userId, machine) {
  if (!userId || !machine) return null;

  const userConnections = connectionIndex.get(userId);
  if (!userConnections) return null;

  // 优先使用hwid查找
  if (machine.hwid) {
    const ws = userConnections.get(`hwid:${machine.hwid}`);
    if (ws && ws.readyState === 1) { // WebSocket.OPEN = 1
      return ws;
    }
  }

  // 其次使用name查找
  if (machine.name && machine.name !== 'unknown') {
    const ws = userConnections.get(`name:${machine.name}`);
    if (ws && ws.readyState === 1) {
      return ws;
    }
  }

  return null;
}

/**
 * 清理连接相关的所有数据
 * @param {WebSocket} ws
 */
export function cleanupConnection(ws) {
  const connInfo = authenticatedConnections.get(ws);
  const sysInfo = clientSystemInfo.get(ws);

  // 从索引中移除连接
  if (connInfo && sysInfo) {
    removeConnectionFromIndex(
      ws,
      connInfo.userId,
      sysInfo.hwid || null,
      sysInfo.machineName || null
    );
  }

  authenticatedConnections.delete(ws);
  clientSystemInfo.delete(ws);
  clientIPs.delete(ws);
  // 清理连接的任务索引
  tasksByConnection.delete(ws);
}

/**
 * 清理已完成或失败的任务（从内存中移除）
 * @param {Array<string>} completedTaskIds - 已完成或失败的任务ID数组
 */
export function cleanupCompletedTasks(completedTaskIds) {
  if (!Array.isArray(completedTaskIds) || completedTaskIds.length === 0) {
    return;
  }

  let cleanedCount = 0;
  for (const taskId of completedTaskIds) {
    const taskInfo = runningTasks.get(taskId);
    if (taskInfo) {
      // 从 runningTasks 中移除
      runningTasks.delete(taskId);
      // 从连接的索引中移除
      if (taskInfo.ws) {
        removeTaskFromConnection(taskInfo.ws, taskId);
      }
      cleanedCount++;
    }
    // 清理任务分配映射
    taskAssignments.delete(taskId);
  }

  if (cleanedCount > 0) {
    console.log(`[cleanup] Cleaned up ${cleanedCount} completed/failed tasks from memory`);
  }
}
