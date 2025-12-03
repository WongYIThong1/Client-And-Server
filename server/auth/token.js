import jwt from 'jsonwebtoken';
import { JWT_SECRET, ACCESS_TOKEN_EXPIRY, REFRESH_TOKEN_EXPIRY } from '../config.js';
import { tokenBlacklist } from '../stores.js';

// ???????,??????
const tokenBlacklistQueue = [];
const MAX_BLACKLIST = 10000;

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

export function verifyToken(token) {
  if (!token) return null;
  try {
    if (tokenBlacklist.has(token)) {
      return null;
    }
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

export function revokeToken(token) {
  if (!token) return;
  if (!tokenBlacklist.has(token)) {
    tokenBlacklist.add(token);
    tokenBlacklistQueue.push(token);
    if (tokenBlacklistQueue.length > MAX_BLACKLIST) {
      const oldest = tokenBlacklistQueue.shift();
      tokenBlacklist.delete(oldest);
    }
  }
}

export function isTokenExpiringSoon(decoded, threshold) {
  if (!decoded || !decoded.exp) {
    return false;
  }
  const remainingTime = (decoded.exp * 1000) - Date.now();
  return remainingTime < threshold && remainingTime > 0;
}
