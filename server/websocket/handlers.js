import { saveOrUpdateMachine, updateMachineHeartbeat, setMachineOffline } from '../supabase.js';
import { authenticatedConnections, clientSystemInfo } from '../stores.js';

/**
 * 处理system_info消息（客户端首次心跳包）
 * @param {WebSocket} ws - WebSocket连接
 * @param {object} data - 消息数据
 * @param {boolean} isAuthenticated - 是否已认证
 * @returns {Promise<boolean>} 返回true表示已处理
 */
export async function handleSystemInfo(ws, data, isAuthenticated) {
  if (data.type !== 'system_info') {
    return false;
  }

  // 检查是否已认证
  if (!isAuthenticated) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Authentication required before sending system info'
    }));
    return true;
  }

  const systemInfo = {
    ip: data.ip || 'unknown',
    ram: data.ram || 'unknown',
    cpuCores: data.cpuCores || 0,
    machineName: data.machineName || 'unknown',
    receivedAt: Date.now()
  };
  
  // 存储系统信息
  clientSystemInfo.set(ws, systemInfo);
  
  const connInfo = authenticatedConnections.get(ws);
  const userId = connInfo ? connInfo.userId : 'unknown';
  const apiKey = connInfo ? connInfo.apiKey : null;
  
  console.log(`Received system_info from user ${userId}:`, systemInfo);
  
  // 保存机器信息到Supabase
  if (userId !== 'unknown' && apiKey && systemInfo.ip !== 'unknown') {
    const result = await saveOrUpdateMachine(userId, apiKey, {
      ip: systemInfo.ip,
      ram: systemInfo.ram,
      cpuCores: systemInfo.cpuCores,
      machineName: systemInfo.machineName
    });
    
    if (!result.success) {
      console.error(`Failed to save machine info to Supabase: ${result.error}`);
      // 不阻止客户端响应，仅记录错误
    } else {
      console.log(`Machine info saved to Supabase: user ${userId}, IP ${systemInfo.ip}`);
    }
  } else {
    console.warn(`Cannot save machine info: userId=${userId}, apiKey=${apiKey ? 'present' : 'missing'}, ip=${systemInfo.ip}`);
  }
  
  // 发送确认消息
  ws.send(JSON.stringify({
    type: 'system_info_received',
    message: 'System information received'
  }));
  
  return true;
}

/**
 * 处理heartbeat消息（客户端定期心跳包）
 * @param {WebSocket} ws - WebSocket连接
 * @param {object} data - 消息数据
 * @param {boolean} isAuthenticated - 是否已认证
 * @returns {Promise<boolean>} 返回true表示已处理
 */
export async function handleHeartbeat(ws, data, isAuthenticated) {
  if (data.type !== 'heartbeat') {
    return false;
  }

  // 检查是否已认证
  if (!isAuthenticated) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Authentication required before sending heartbeat'
    }));
    return true;
  }

  const sysInfo = clientSystemInfo.get(ws);
  const connInfo = authenticatedConnections.get(ws);
  const userId = connInfo ? connInfo.userId : 'unknown';
  const apiKey = connInfo ? connInfo.apiKey : null;
  
  if (sysInfo) {
    console.log(`Received heartbeat from user ${userId} (IP: ${sysInfo.ip})`);
    
    // 更新机器的最后心跳时间
    if (userId !== 'unknown' && sysInfo.ip && sysInfo.ip !== 'unknown') {
      const result = await updateMachineHeartbeat(userId, sysInfo.ip);
      
      if (!result.success) {
        // 如果更新失败，可能是机器记录不存在，尝试创建
        if (apiKey) {
          const createResult = await saveOrUpdateMachine(userId, apiKey, {
            ip: sysInfo.ip,
            ram: sysInfo.ram || 'unknown',
            cpuCores: sysInfo.cpuCores || 0,
            machineName: sysInfo.machineName || 'unknown'
          });
          
          if (!createResult.success) {
            console.error(`Failed to update/create machine heartbeat: ${result.error || createResult.error}`);
          }
        } else {
          console.warn(`Cannot update machine heartbeat: missing apiKey for user ${userId}`);
        }
      }
    }
  } else {
    console.log(`Received heartbeat from user ${userId} (no system info)`);
  }
  
  // 发送确认消息
  ws.send(JSON.stringify({
    type: 'heartbeat_received',
    message: 'Heartbeat received',
    timestamp: Date.now()
  }));
  
  return true;
}

/**
 * 处理data消息
 * @param {WebSocket} ws - WebSocket连接
 * @param {object} data - 消息数据
 * @returns {boolean} 返回true表示已处理
 */
export function handleData(ws, data) {
  if (data.type !== 'data') {
    return false;
  }

  // 处理实时数据更新请求
  // 这里可以添加业务逻辑
  ws.send(JSON.stringify({
    type: 'data',
    message: 'Data received',
    timestamp: Date.now()
  }));

  return true;
}

/**
 * 处理pong消息（心跳响应）
 * @param {object} data - 消息数据
 * @returns {boolean} 返回true表示已处理
 */
export function handlePong(data) {
  return data.type === 'pong';
}

/**
 * 处理disconnect消息（客户端主动断开）
 * @param {WebSocket} ws - WebSocket连接
 * @param {object} data - 消息数据
 * @param {boolean} isAuthenticated - 是否已认证
 * @returns {Promise<boolean>} 返回true表示已处理
 */
export async function handleDisconnect(ws, data, isAuthenticated) {
  if (data.type !== 'disconnect') {
    return false;
  }

  // 检查是否已认证
  if (!isAuthenticated) {
    return true; // 未认证，直接返回
  }

  const connInfo = authenticatedConnections.get(ws);
  const sysInfo = clientSystemInfo.get(ws);
  const userId = connInfo ? connInfo.userId : 'unknown';
  const ip = sysInfo ? sysInfo.ip : null;

  if (userId !== 'unknown' && ip && ip !== 'unknown') {
    // 更新机器状态为离线
    const result = await setMachineOffline(userId, ip);
    if (!result.success) {
      console.error(`Failed to set machine offline: ${result.error}`);
    } else {
      console.log(`Machine disconnected gracefully: user ${userId}, IP ${ip}`);
    }
  }

  // 发送确认消息
  ws.send(JSON.stringify({
    type: 'disconnect_ack',
    message: 'Disconnect acknowledged'
  }));

  // 关闭连接
  setTimeout(() => {
    ws.close();
  }, 100); // 给一点时间让确认消息发送出去

  return true;
}

