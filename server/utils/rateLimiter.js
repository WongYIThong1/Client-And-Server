// 速率限制器
// 使用滑动窗口算法

/**
 * 速率限制配置
 */
const RATE_LIMIT_CONFIG = {
  // 认证请求限制：每分钟最多5次
  auth: {
    windowMs: 60 * 1000, // 1分钟
    maxRequests: 5
  },
  // 消息发送限制：每秒最多10条
  message: {
    windowMs: 1000, // 1秒
    maxRequests: 10
  },
  // 未认证阶段：按 IP + HWID 组合限制，每分钟最多10次
  auth_ip_hwid: {
    windowMs: 60 * 1000,
    maxRequests: 10
  }
};

// 存储每个IP的请求记录
const requestRecords = new Map();

/**
 * 清理过期的记录
 * @param {string} key - 记录键
 * @param {number} windowMs - 时间窗口（毫秒）
 */
function cleanExpiredRecords(key, windowMs) {
  const records = requestRecords.get(key);
  if (!records) return;
  
  const now = Date.now();
  const cutoff = now - windowMs;
  
  // 移除过期记录
  const filtered = records.filter(timestamp => timestamp > cutoff);
  
  if (filtered.length === 0) {
    requestRecords.delete(key);
  } else {
    requestRecords.set(key, filtered);
  }
}

function applyRateLimit(key, config) {
  if (!key || !config) {
    return false;
  }

  const now = Date.now();
  cleanExpiredRecords(key, config.windowMs);

  const records = requestRecords.get(key) || [];
  if (records.length >= config.maxRequests) {
    return true;
  }

  records.push(now);
  requestRecords.set(key, records);
  return false;
}

/**
 * 检查是否超过速率限制
 * @param {string} ip - 客户端IP地址
 * @param {string} type - 限制类型 ('auth' | 'message' | 'auth_ip_hwid')
 * @param {string} customKey - 自定义键（可选，例如 IP+HWID）
 * @param {{windowMs:number,maxRequests:number}} customConfig - 自定义配置（可选）
 * @returns {boolean} true表示超过限制，false表示未超过
 */
export function isRateLimited(ip, type = 'message', customKey = null, customConfig = null) {
  const config = customConfig || RATE_LIMIT_CONFIG[type];
  if (!config) {
    return false; // 未知类型，不限制
  }

  const key = customKey || `${ip}:${type}`;
  return applyRateLimit(key, config);
}

/**
 * 使用自定义键/配置检查速率限制
 * @param {string} key - 自定义键
 * @param {{windowMs:number,maxRequests:number}} config - 配置
 * @returns {boolean}
 */
export function isRateLimitedWithKey(key, config) {
  return applyRateLimit(key, config);
}

/**
 * 获取剩余请求次数
 * @param {string} ip - 客户端IP地址
 * @param {string} type - 限制类型 ('auth' | 'message')
 * @returns {number} 剩余请求次数
 */
export function getRemainingRequests(ip, type = 'message', customKey = null, customConfig = null) {
  const config = customConfig || RATE_LIMIT_CONFIG[type];
  if (!config) {
    return Infinity;
  }
  
  const key = customKey || `${ip}:${type}`;
  cleanExpiredRecords(key, config.windowMs);
  
  const records = requestRecords.get(key) || [];
  return Math.max(0, config.maxRequests - records.length);
}

/**
 * 获取客户端IP地址
 * @param {WebSocket} ws - WebSocket连接
 * @param {Map} clientIPsMap - 客户端IP存储Map（从stores.js导入）
 * @returns {string} IP地址
 */
export function getClientIP(ws, clientIPsMap) {
  // 从存储中获取IP（在连接建立时保存）
  if (clientIPsMap && clientIPsMap.has(ws)) {
    return clientIPsMap.get(ws);
  }
  
  // 尝试从WebSocket连接获取IP
  if (ws._socket && ws._socket.remoteAddress) {
    return ws._socket.remoteAddress;
  }
  // 尝试从upgradeReq获取
  if (ws.upgradeReq && ws.upgradeReq.socket && ws.upgradeReq.socket.remoteAddress) {
    return ws.upgradeReq.socket.remoteAddress;
  }
  // 尝试从req获取
  if (ws._req && ws._req.socket && ws._req.socket.remoteAddress) {
    return ws._req.socket.remoteAddress;
  }
  // 默认值
  return 'unknown';
}

/**
 * 清理所有记录（用于测试或重置）
 */
export function clearAllRecords() {
  requestRecords.clear();
}

