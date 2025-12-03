import { verifyApiKey } from '../supabase.js';
import { generateAccessToken, generateRefreshToken, verifyToken, revokeToken, isTokenExpiringSoon } from './token.js';
import { authenticatedConnections } from '../stores.js';
import { TOKEN_AUTO_REFRESH_THRESHOLD } from '../config.js';

export async function handleAuth(ws, data) {
  if (data.type !== 'auth') {
    return false;
  }

  const apiKey = data.apiKey;
  if (!apiKey) {
    ws.send(JSON.stringify({
      type: 'auth_failed',
      message: 'API Key is required'
    }));
    return true;
  }

  const cleanApiKey = apiKey.trim();
  const verification = await verifyApiKey(cleanApiKey);
  
  if (verification.valid) {
    const accessToken = generateAccessToken(verification.userId);
    const refreshToken = generateRefreshToken(verification.userId);
    
    authenticatedConnections.set(ws, {
      userId: verification.userId,
      apiKey: cleanApiKey,
      accessToken,
      refreshToken,
      connectedAt: Date.now()
    });

    ws.send(JSON.stringify({
      type: 'auth_success',
      accessToken,
      refreshToken,
      message: 'Authentication successful'
    }));

    console.log(`Client authenticated: User ${verification.userId}`);
    return { authenticated: true, userId: verification.userId };
  } else {
    if (verification.planExpired) {
      ws.send(JSON.stringify({
        type: 'plan_expired',
        message: 'Your plan has expired. Please renew your subscription.'
      }));
      // 关闭连接
      setTimeout(() => {
        ws.close();
      }, 100);
  } else {
    ws.send(JSON.stringify({
      type: 'auth_failed',
      message: 'Invalid API Key'
    }));
    }
    return true;
  }
}

export async function handleRefreshToken(ws, data) {
  if (data.type !== 'refresh_token') {
    return false;
  }

  const refreshToken = data.refreshToken;
  if (!refreshToken) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Refresh token is required'
    }));
    return true;
  }

  const connInfo = authenticatedConnections.get(ws);
  if (!connInfo || !connInfo.refreshToken || connInfo.refreshToken !== refreshToken) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Refresh token does not match current session'
    }));
    return true;
  }

  const decoded = verifyToken(refreshToken);
  if (decoded && decoded.type === 'refresh') {
    revokeToken(refreshToken);
    const newAccessToken = generateAccessToken(decoded.userId);
    const newRefreshToken = generateRefreshToken(decoded.userId);
    connInfo.accessToken = newAccessToken;
    connInfo.refreshToken = newRefreshToken;

    ws.send(JSON.stringify({
      type: 'token_refreshed',
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      message: 'Token refreshed successfully'
    }));
  } else {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Invalid or expired refresh token'
    }));
  }
  return true;
}

export async function handleTokenAuth(ws, data) {
  if (!data.accessToken) {
    return false;
  }

  const decoded = verifyToken(data.accessToken);
  if (decoded && decoded.type === 'access') {
    authenticatedConnections.set(ws, {
      userId: decoded.userId,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      connectedAt: Date.now()
    });
    return true;
  } else {
    if (data.refreshToken) {
      const refreshDecoded = verifyToken(data.refreshToken);
      if (refreshDecoded && refreshDecoded.type === 'refresh') {
        revokeToken(data.refreshToken);
        const newAccessToken = generateAccessToken(refreshDecoded.userId);
        const newRefreshToken = generateRefreshToken(refreshDecoded.userId);
        
        authenticatedConnections.set(ws, {
          userId: refreshDecoded.userId,
          accessToken: newAccessToken,
          refreshToken: newRefreshToken,
          connectedAt: Date.now()
        });
        
        ws.send(JSON.stringify({
          type: 'token_refreshed',
          accessToken: newAccessToken,
          refreshToken: newRefreshToken
        }));
        
        return true;
      } else {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Invalid or expired tokens. Please re-authenticate.'
        }));
        return false;
      }
    } else {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid or expired access token'
      }));
      return false;
    }
  }
}

export async function checkAndRefreshToken(ws) {
  const connInfo = authenticatedConnections.get(ws);
  if (!connInfo || !connInfo.refreshToken) {
    return;
  }

  try {
    const decoded = verifyToken(connInfo.accessToken);
    if (decoded) {
      if (isTokenExpiringSoon(decoded, TOKEN_AUTO_REFRESH_THRESHOLD)) {
        const refreshDecoded = verifyToken(connInfo.refreshToken);
        if (refreshDecoded && refreshDecoded.type === 'refresh') {
          revokeToken(connInfo.refreshToken);
          const newAccessToken = generateAccessToken(refreshDecoded.userId);
          const newRefreshToken = generateRefreshToken(refreshDecoded.userId);
          connInfo.accessToken = newAccessToken;
          connInfo.refreshToken = newRefreshToken;
          ws.send(JSON.stringify({
            type: 'token_refreshed',
            accessToken: newAccessToken,
            refreshToken: newRefreshToken,
            message: 'Token automatically refreshed'
          }));
        }
      }
    } else {
      const refreshDecoded = verifyToken(connInfo.refreshToken);
      if (refreshDecoded && refreshDecoded.type === 'refresh') {
        revokeToken(connInfo.refreshToken);
        const newAccessToken = generateAccessToken(refreshDecoded.userId);
        const newRefreshToken = generateRefreshToken(refreshDecoded.userId);
        connInfo.accessToken = newAccessToken;
        connInfo.refreshToken = newRefreshToken;
        ws.send(JSON.stringify({
          type: 'token_refreshed',
          accessToken: newAccessToken,
          refreshToken: newRefreshToken,
          message: 'Token automatically refreshed (expired)'
        }));
      }
    }
  } catch {
    // ignore
  }
}
