// Connection state stores
export const authenticatedConnections = new Map(); // Map<WebSocket, {userId, apiKey, accessToken, refreshToken, connectedAt}>
export const clientSystemInfo = new Map(); // Map<WebSocket, {ip, ram, cpuCores, machineName, receivedAt}>
export const tokenBlacklist = new Set();

/**
 * ????????????
 * @param {WebSocket} ws
 */
export function cleanupConnection(ws) {
  authenticatedConnections.delete(ws);
  clientSystemInfo.delete(ws);
}
