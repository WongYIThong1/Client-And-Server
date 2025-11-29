import jwt from 'jsonwebtoken';
import { JWT_SECRET, ACCESS_TOKEN_EXPIRY, REFRESH_TOKEN_EXPIRY } from '../config.js';
import { tokenBlacklist, cleanupTokenBlacklist } from '../stores.js';

/**
 * 生成access token（短期有效）
 * @param {string} userId - 用户ID
 * @returns {string} JWT token
 */
export function generateAccessToken(userId) {
  return jwt.sign(
    { 
      userId, 
      type: 'access',
      timestamp: Date.now() 
    },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
}

/**
 * 生成refresh token（长期有效，用于刷新access token）
 * @param {string} userId - 用户ID
 * @returns {string} JWT token
 */
export function generateRefreshToken(userId) {
  return jwt.sign(
    { 
      userId, 
      type: 'refresh',
      timestamp: Date.now() 
    },
    JWT_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRY }
  );
}

/**
 * 验证token
 * @param {string} token - JWT token
 * @returns {object|null} 解码后的token payload，如果无效则返回null
 */
export function verifyToken(token) {
  try {
    // 检查token是否在黑名单中
    if (tokenBlacklist.has(token)) {
      return null;
    }
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

/**
 * 撤销token（加入黑名单）
 * @param {string} token - 要撤销的token
 */
export function revokeToken(token) {
  tokenBlacklist.add(token);
  // 定期清理过期的token
  cleanupTokenBlacklist();
}

/**
 * 检查token是否即将过期
 * @param {object} decoded - 解码后的token
 * @param {number} threshold - 过期阈值（毫秒）
 * @returns {boolean} 如果剩余时间少于阈值则返回true
 */
export function isTokenExpiringSoon(decoded, threshold) {
  if (!decoded || !decoded.exp) {
    return false;
  }
  const remainingTime = (decoded.exp * 1000) - Date.now();
  return remainingTime < threshold && remainingTime > 0;
}

