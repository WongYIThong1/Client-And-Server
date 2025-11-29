import dotenv from 'dotenv';

dotenv.config();

// 服务器配置
export const PORT = process.env.PORT || 5000;
export const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this-in-production';

// Token配置
export const ACCESS_TOKEN_EXPIRY = '15m'; // Access Token有效期：15分钟
export const REFRESH_TOKEN_EXPIRY = '7d'; // Refresh Token有效期：7天

// 心跳配置
export const HEARTBEAT_INTERVAL = 30000; // 心跳间隔（30秒）
export const TOKEN_AUTO_REFRESH_THRESHOLD = 5 * 60 * 1000; // Token自动刷新阈值（5分钟，毫秒）

// Token黑名单配置
export const TOKEN_BLACKLIST_MAX_SIZE = 10000; // Token黑名单最大大小

