import { saveOrUpdateMachine, setMachineOffline } from '../supabase.js';
import { authenticatedConnections, clientSystemInfo } from '../stores.js';

/**
 * 处理system_info消息（连接建立时自动发送）
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
  
  // 保存机器信息到Supabase
  if (userId !== 'unknown' && apiKey && systemInfo.ip !== 'unknown') {
    const result = await saveOrUpdateMachine(userId, apiKey, {
      ip: systemInfo.ip,
      ram: systemInfo.ram,
      cpuCores: systemInfo.cpuCores,
      machineName: systemInfo.machineName
    });
    
    if (!result.success) {
      console.error(`Failed to save machine info: ${result.error}`);
    }
  }
  
  // 发送确认消息
  ws.send(JSON.stringify({
    type: 'system_info_received',
    message: 'System information received'
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
  
  // 使用电脑名字作为机器标识（如果为空或unknown，则使用IP作为备用）
  const machineIdentifier = sysInfo 
    ? ((sysInfo.machineName && sysInfo.machineName !== 'unknown') 
        ? sysInfo.machineName 
        : (sysInfo.ip && sysInfo.ip !== 'unknown' ? sysInfo.ip : null))
    : null;

  if (userId !== 'unknown' && machineIdentifier) {
    // 更新机器状态为离线
    const result = await setMachineOffline(userId, machineIdentifier);
    if (!result.success) {
      console.error(`Failed to set machine offline: ${result.error}`);
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

