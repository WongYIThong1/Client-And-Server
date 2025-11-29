/**
 * 数据存储模块
 * 管理服务器运行时的内存数据
 */

// 存储已认证的连接
// Map<WebSocket, {userId, apiKey, accessToken, refreshToken, connectedAt}>
export const authenticatedConnections = new Map();

// 存储客户端系统信息（与连接关联）
// Map<WebSocket, {ip, ram, cpuCores, receivedAt}>
export const clientSystemInfo = new Map();

// Token黑名单（用于撤销token）
export const tokenBlacklist = new Set();

/**
 * 清理连接相关的所有数据
 * @param {WebSocket} ws - WebSocket连接
 */
export function cleanupConnection(ws) {
  authenticatedConnections.delete(ws);
  clientSystemInfo.delete(ws);
}

/**
 * 清理Token黑名单（当超过最大大小时）
 */
export function cleanupTokenBlacklist() {
  if (tokenBlacklist.size > 10000) {
    tokenBlacklist.clear();
  }
}

