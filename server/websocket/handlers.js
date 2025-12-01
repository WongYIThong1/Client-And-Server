import { saveOrUpdateMachine, setMachineOffline, checkMachineExists } from '../supabase.js';
import supabase from '../supabase.js';
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
    const machineIdentifier = (systemInfo.machineName && systemInfo.machineName !== 'unknown') 
      ? systemInfo.machineName 
      : (systemInfo.ip && systemInfo.ip !== 'unknown' ? systemInfo.ip : null);
    
    if (machineIdentifier) {
      const machineCheck = await checkMachineExists(userId, machineIdentifier);
      
      // 如果machine不存在，需要判断是新连接还是machine被删除
      if (!machineCheck.exists) {
        // 尝试根据IP查找（因为name可能被重命名了）
        const { data: machineByIp } = await supabase
          .from('machines')
          .select('id, name')
          .eq('user_id', userId)
          .eq('ip', systemInfo.ip)
          .maybeSingle();
        
        if (!machineByIp) {
          // 根据IP也找不到，需要判断情况：
          // 1. 新连接（刚认证，连接时间很短）- 允许创建新记录
          // 2. 已存在的连接（连接时间较长）- machine被删除，应该通知客户端
          const connectionAge = connInfo ? (Date.now() - connInfo.connectedAt) : 0;
          const isNewConnection = connectionAge < 10000; // 10秒内认为是新连接
          
          // 检查用户是否有其他machine记录（如果有，说明这不是第一次连接）
          const { data: otherMachines } = await supabase
            .from('machines')
            .select('id')
            .eq('user_id', userId)
            .limit(1);
          
          const hasOtherMachines = otherMachines && otherMachines.length > 0;
          
          // 如果是新连接且用户没有其他machine，允许创建新记录
          // 如果连接时间较长或用户有其他machine，说明machine被删除了
          if (isNewConnection && !hasOtherMachines) {
            // 新连接，允许创建新记录
            console.log(`New connection detected, allowing machine creation for user ${userId}`);
          } else {
            // Machine被删除，通知客户端
            console.log(`Machine ${machineIdentifier} not found for user ${userId}, machine was deleted`);
            ws.send(JSON.stringify({
              type: 'machine_deleted',
              message: 'Your machine has been deleted. Please re-authenticate.'
            }));
            setTimeout(() => {
              ws.close(1000, 'Machine deleted');
            }, 500);
            return true;
          }
        }
      }
    }
    
    // 如果machine存在或允许创建新记录，继续保存/更新
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

