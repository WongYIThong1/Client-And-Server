// Connection state stores
export const authenticatedConnections = new Map(); // Map<WebSocket, {userId, apiKey, accessToken, refreshToken, connectedAt, machineId}>
export const clientSystemInfo = new Map(); // Map<WebSocket, {ip, ram, cpuCores, machineName, receivedAt}>
export const clientIPs = new Map(); // Map<WebSocket, string> - 存储客户端IP地址
export const tokenBlacklist = new Set();
export const runningTasks = new Map(); // Map<taskId, {ws, userId, lastProgressRequest}> - 正在运行的任务
export const taskAssignments = new Map(); // Map<taskId, {userId, machineId}>

/**
 * 清理连接相关的所有数据
 * @param {WebSocket} ws
 */
export function cleanupConnection(ws) {
  authenticatedConnections.delete(ws);
  clientSystemInfo.delete(ws);
  clientIPs.delete(ws);
}
