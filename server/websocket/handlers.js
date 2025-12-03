import { authenticatedConnections, clientSystemInfo, runningTasks, addTaskToConnection, clientIPs, addConnectionToIndex } from '../stores.js';
import { saveOrUpdateMachine, updateMachineHeartbeat, updateTaskProgress, upsertTaskUrlResults, updateTaskTotalLines } from '../supabase.js';
import { isRateLimited, getClientIP } from '../utils/rateLimiter.js';
import { enqueueProgressUpdate } from '../utils/progressQueue.js';
import supabase from '../supabase.js';

/**
 * 处理系统信息消息
 * @param {WebSocket} ws - WebSocket连接
 * @param {object} data - 消息数据
 * @param {boolean} isAuthenticated - 是否已认证
 * @returns {Promise<boolean>} 如果消息已处理返回true，否则返回false
 */
export async function handleSystemInfo(ws, data, isAuthenticated) {
  if (data.type !== 'system_info') {
    return false;
  }

  if (!isAuthenticated) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Authentication required before sending system info'
    }));
    return true;
  }

  const connInfo = authenticatedConnections.get(ws);
  if (!connInfo || !connInfo.userId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Connection not authenticated'
    }));
    return true;
  }

  const machineInfo = {
    ip: data.ip || 'unknown',
    ram: data.ram || null,
    cpuCores: data.cpuCores || 0,
    machineName: data.machineName || 'unknown',
    hwid: data.hwid || null
  };

  const machineIdentifier = (machineInfo.machineName && machineInfo.machineName !== 'unknown')
    ? machineInfo.machineName
    : (machineInfo.ip && machineInfo.ip !== 'unknown' ? machineInfo.ip : null);
  const hwidForCheck = machineInfo.hwid || null;

  clientSystemInfo.set(ws, {
    ip: machineInfo.ip,
    ram: machineInfo.ram,
    cpuCores: machineInfo.cpuCores,
    machineName: machineInfo.machineName,
    hwid: machineInfo.hwid,
    receivedAt: Date.now()
  });

  // 更新连接索引（用于快速查找）
  addConnectionToIndex(
    ws,
    connInfo.userId,
    machineInfo.hwid || null,
    machineInfo.machineName || null
  );

  const result = await saveOrUpdateMachine(
    connInfo.userId,
    connInfo.apiKey,
    machineInfo
  );

  if (result.success) {
    if (machineIdentifier) {
      connInfo.machineIdentifier = machineIdentifier;
    }
    if (result.machineId) {
      connInfo.machineId = result.machineId;
    }

    // 在服务器重启后，客户端重新上报 system_info 时：
    // 恢复该机器上所有 “running” 状态的任务到内存 runningTasks，保证继续请求进度。
    // 注意：不再自动恢复 paused 任务，防止用户手动暂停被强制恢复。
    try {
      if (connInfo.machineId) {
        // 恢复 running 状态任务到 runningTasks
        const { data: running, error: runningError } = await supabase
          .from('tasks')
          .select('id, status')
          .eq('user_id', connInfo.userId)
          .eq('machine_id', connInfo.machineId)
          .eq('status', 'running');

        if (!runningError && Array.isArray(running) && running.length > 0) {
          for (const task of running) {
            if (!task?.id) continue;
            runningTasks.set(task.id, {
              ws,
              userId: connInfo.userId,
              machineId: connInfo.machineId || null,
              lastProgressRequest: Date.now(),
              progressRequestCount: 0
            });
            // 优化：添加到连接的索引中
            addTaskToConnection(ws, task.id);
          }
        }
      }
    } catch (e) {
      console.error('[system_info] Failed to restore running tasks after restart:', e);
    }

    ws.send(JSON.stringify({
      type: 'system_info_received',
      message: 'System info received and saved'
    }));

    console.log(`System info saved for user ${connInfo.userId}, machine: ${machineIdentifier || 'unknown'}`);
  } else {
    ws.send(JSON.stringify({
      type: 'error',
      message: `Failed to save system info: ${result.error || 'Unknown error'}`
    }));
    console.error(`Failed to save system info for user ${connInfo.userId}:`, result.error);
  }

  return true;
}


/**
 * 处理数据消息
 * @param {WebSocket} ws - WebSocket连接
 * @param {object} data - 消息数据
 * @returns {boolean} 如果消息已处理返回true，否则返回false
 */
export function handleData(ws, data) {
  if (data.type !== 'data') {
    return false;
  }

  // 简单回显数据消息（可以根据需求修改）
  ws.send(JSON.stringify({
    type: 'data',
    message: 'Echo: ' + (data.message || ''),
    data: data.data || null
  }));

  return true;
}

/**
 * 处理断开连接消息
 * @param {WebSocket} ws - WebSocket连接
 * @param {object} data - 消息数据
 * @param {boolean} isAuthenticated - 是否已认证
 * @returns {Promise<boolean>} 如果消息已处理返回true，否则返回false
 */
export async function handleDisconnect(ws, data, isAuthenticated) {
  if (data.type !== 'disconnect') {
    return false;
  }

  if (!isAuthenticated) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Authentication required'
    }));
    return true;
  }

  // 发送断开确认
  ws.send(JSON.stringify({
    type: 'disconnect_ack',
    message: 'Disconnect acknowledged'
  }));

  // 关闭连接
  setTimeout(() => {
    ws.close(1000, 'Client requested disconnect');
  }, 100);

  return true;
}

/**
 * 处理任务进度上报消息
 * @param {WebSocket} ws - WebSocket连接
 * @param {object} data - 消息数据
 * @param {boolean} isAuthenticated - 是否已认证
 * @returns {Promise<boolean>} 如果消息已处理返回true，否则返回false
 */
export async function handleTaskProgress(ws, data, isAuthenticated) {
  // 支持两种消息类型：task_progress (旧格式) 和 task_progress_update (新格式)
  if (data.type !== 'task_progress' && data.type !== 'task_progress_update') {
    return false;
  }

  if (!isAuthenticated) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Authentication required before reporting progress'
    }));
    return true;
  }

  const connInfo = authenticatedConnections.get(ws);
  if (!connInfo || !connInfo.userId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Connection not authenticated'
    }));
    return true;
  }

  const taskId = data.taskId;
  if (!taskId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'taskId is required for task_progress'
    }));
    return true;
  }

  // 优化：添加限流检查（防止单个连接发送过多进度更新）
  const clientIP = getClientIP(ws, clientIPs);
  if (isRateLimited(clientIP, 'task_progress')) {
    // 限流时仍然返回确认，但将更新加入队列延迟处理
    if (data.type === 'task_progress_update' && Array.isArray(data.results)) {
      const urlResults = data.results.map(result => ({
        domain: result.domain || result.domains || null,
        waf: result.waf || null,
        database: result.database || null,
        rows: result.rows || null,
        status: result.status || 'running',
        progress: typeof result.progress === 'number' ? result.progress : (Number(result.progress) || 0)
      }));
      
      const totalProgress = typeof data.progress === 'number' ? data.progress : 
        urlResults.reduce((sum, r) => sum + (r.progress || 0), 0) / urlResults.length;
      
      // 加入队列，异步处理
      enqueueProgressUpdate(
        taskId,
        connInfo.userId,
        urlResults,
        totalProgress,
        data.isPeriodicUpdate === true
      );
    }
    
    // 仍然返回确认，避免客户端重试
    ws.send(JSON.stringify({
      type: 'task_progress_update_ack',
      taskId
    }));
    return true;
  }

  // 新格式：包含多个 URL 结果
  if (data.type === 'task_progress_update' && Array.isArray(data.results)) {
    const urlResults = data.results.map(result => ({
      domain: result.domain || result.domains || null,
      waf: result.waf || null,
      database: result.database || null,
      rows: result.rows || null,
      status: result.status || 'running',
      progress: typeof result.progress === 'number' ? result.progress : (Number(result.progress) || 0)
    }));

    const isPeriodicUpdate = data.isPeriodicUpdate === true;
    
    // 优化：非定期更新使用队列异步处理，定期更新立即处理（保证实时性）
    if (!isPeriodicUpdate) {
      // 常规更新：加入队列，批量处理
      const totalProgress = typeof data.progress === 'number' ? data.progress : 
        urlResults.reduce((sum, r) => sum + (r.progress || 0), 0) / urlResults.length;
      
      enqueueProgressUpdate(
        taskId,
        connInfo.userId,
        urlResults,
        totalProgress,
        false
      );
      
      // 立即返回确认
      ws.send(JSON.stringify({
        type: 'task_progress_update_ack',
        taskId
      }));
      return true;
    }

    // 定期更新：立即处理（保证恢复信息的实时性）
    const result = await upsertTaskUrlResults(connInfo.userId, taskId, urlResults);
    if (!result.success) {
      ws.send(JSON.stringify({
        type: 'error',
        message: `Failed to update task_url results: ${result.error || 'Unknown error'}`
      }));
      return true;
    }
    
    if (urlResults.length > 0) {
      // 每30秒更新一次恢复信息（current_lines 和 total_url_lines）
      const totalProgress = typeof data.progress === 'number' ? data.progress : 
        urlResults.reduce((sum, r) => sum + (r.progress || 0), 0) / urlResults.length;
      
      // 计算已完成的域名数量（只统计 completed 和 failed，不包括 offline）
      const completedCount = urlResults.filter(r => 
        r.status === 'completed' || r.status === 'failed'
      ).length;
      
      // 优化：使用传入的结果数量作为总数量，避免额外查询数据库
      // 如果 urlResults 包含所有结果，直接使用长度；否则从缓存或上次值获取
      const totalCount = urlResults.length; // 简化：使用当前结果数量，避免查询
      
      // 每30秒更新一次恢复信息
      await updateTaskProgress(connInfo.userId, taskId, totalProgress, undefined, completedCount, totalCount);
      console.log(`[progress] Updated recovery info for task ${taskId}: ${completedCount}/${totalCount} completed (30s periodic update)`);
    }

    // 返回确认消息
    ws.send(JSON.stringify({
      type: 'task_progress_update_ack',
      taskId
    }));

    return true;
  }

  // 旧格式：单个任务进度
  const progress = typeof data.progress === 'number' ? data.progress : Number(data.progress);
  const status = typeof data.status === 'string' ? data.status : undefined;

  if (!Number.isFinite(progress)) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'progress must be a number'
    }));
    return true;
  }

  const result = await updateTaskProgress(connInfo.userId, taskId, progress, status);
  if (!result.success) {
    ws.send(JSON.stringify({
      type: 'error',
      message: `Failed to update task progress: ${result.error || 'Unknown error'}`
    }));
    return true;
  }

  // 可选：返回确认消息
  ws.send(JSON.stringify({
    type: 'task_progress_ack',
    taskId,
    progress
  }));

  return true;
}

/**
 * 处理客户端上报的任务列表行数
 * @param {WebSocket} ws
 * @param {object} data
 * @param {boolean} isAuthenticated
 * @returns {Promise<boolean>}
 */
export async function handleTaskListInfo(ws, data, isAuthenticated) {
  if (data.type !== 'task_list_info') {
    return false;
  }

  if (!isAuthenticated) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Authentication required before sending task metadata'
    }));
    return true;
  }

  const connInfo = authenticatedConnections.get(ws);
  if (!connInfo || !connInfo.userId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Connection not authenticated'
    }));
    return true;
  }

  const taskId = data.taskId;
  const totalLines = Number(data.totalLines);

  if (!taskId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'taskId is required for task_list_info'
    }));
    return true;
  }

  if (!Number.isFinite(totalLines) || totalLines < 0) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'totalLines must be a non-negative number'
    }));
    return true;
  }

  const result = await updateTaskTotalLines(connInfo.userId, taskId, totalLines);
  if (!result.success) {
    ws.send(JSON.stringify({
      type: 'error',
      message: `Failed to update task metadata: ${result.error || 'Unknown error'}`
    }));
    return true;
  }

  ws.send(JSON.stringify({
    type: 'task_list_info_ack',
    taskId
  }));

  return true;
}
