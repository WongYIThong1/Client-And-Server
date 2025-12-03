import supabase from '../supabase.js';
import { authenticatedConnections, clientSystemInfo, runningTasks } from '../stores.js';
import { extractTaskSettings } from '../supabase.js';

// 从环境变量中读取 Supabase 基础 URL 和公开存储桶名称
// SUPABASE_URL 在 supabase.js 中已经使用，这里直接复用同一个环境变量
const SUPABASE_URL = process.env.SUPABASE_URL || '';
// 可通过环境变量自定义公开 bucket 名称，默认使用 user-files
const PUBLIC_BUCKET = process.env.SUPABASE_PUBLIC_BUCKET || 'user-files';

/**
 * 将数据库里的相对路径（例如 "sql_2_.txt" 或 "folder/sql_2_.txt"）
 * 转换为完整的 Supabase Storage 公开访问 URL。
 * - 如果已经是 http/https 开头，则原样返回。
 * - 如果没有斜杠且给出了 userId，则自动补上 "<userId>/<filename>"，
 *   以适配当前 Storage 对象命名规则（user_id 作为前缀目录）。
 */
function toPublicUrl(path, userId) {
  if (!path) return null;

  // 已经是完整 URL，直接返回
  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  // 如果没有配置 SUPABASE_URL，则退回原始值，避免生成错误 URL
  if (!SUPABASE_URL) {
    return path;
  }

  let cleanPath = String(path).replace(/^\/+/, '');

  // 如果路径中不包含斜杠，说明只是文件名；按当前存储策略，在前面补 userId 作为目录
  if (userId && !cleanPath.includes('/')) {
    cleanPath = `${userId}/${cleanPath}`;
  }

  return `${SUPABASE_URL}/storage/v1/object/public/${PUBLIC_BUCKET}/${cleanPath}`;
}

/**
 * 在当前已认证连接中查找与指定机器匹配的 WebSocket 连接。
 * 优先使用 hwid 进行匹配，其次使用 machine name。
 * @param {string} userId
 * @param {{ id: string, name: string | null, hwid: string | null }} machine
 * @returns {WebSocket|null}
 */
function findTargetWebSocketForMachine(userId, machine) {
  if (!userId || !machine) return null;

  let targetWs = null;

  for (const [ws, connInfo] of authenticatedConnections.entries()) {
    if (connInfo.userId !== userId) {
      continue;
    }

    const sysInfo = clientSystemInfo.get(ws);
    if (!sysInfo) {
      continue;
    }

    // 优先使用 hwid 匹配，然后使用 machine name 匹配
    const hwidMatch = machine.hwid && sysInfo.hwid && machine.hwid === sysInfo.hwid;
    const nameMatch = machine.name && sysInfo.machineName && machine.name === sysInfo.machineName;

    if (hwidMatch || nameMatch) {
      targetWs = ws;
      break;
    }
  }

  return targetWs;
}

/**
 * 从 list_file URL 读取域名列表
 * @param {string} listFileUrl - list_file 的 URL
 * @returns {Promise<string[]>} 域名数组
 */
async function fetchDomainsFromListFile(listFileUrl) {
  try {
    if (!listFileUrl) {
      return [];
    }

    const response = await fetch(listFileUrl);
    if (!response.ok) {
      console.error(`[realtime:tasks] Failed to fetch list file: ${response.statusText}`);
      return [];
    }

    const text = await response.text();
    const domains = text
      .split('\n')
      .map(line => {
        // 清理每行：移除前后空格、注释等
        line = line.trim();
        // 移除行内注释（# 之后的内容）
        const commentIndex = line.indexOf('#');
        if (commentIndex >= 0) {
          line = line.substring(0, commentIndex).trim();
        }
        return line;
      })
      .filter(line => line && line.length > 0);

    return domains;
  } catch (error) {
    console.error('[realtime:tasks] Error fetching domains from list file:', error);
    return [];
  }
}

/**
 * Subscribe to Supabase Realtime for task assignment.
 * 监听 tasks 表的 INSERT 和 UPDATE 事件，并根据 machine_id 向对应的客户端派发任务。
 */
export function startTaskRealtimeListener() {
  const channel = supabase
    .channel('public:tasks')
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'tasks'
      },
      async (payload) => {
        const newTask = payload.new;
        
        if (!newTask) {
          console.error('[realtime:tasks] Invalid task payload:', payload);
          return;
        }

        const {
          id: taskId,
          machine_id: machineId,
          name: taskName,
          list_file: listFile,
          proxy_file: proxyFile,
          user_id: userId
        } = newTask;

        if (!machineId) {
          console.log(`[realtime:tasks] Task ${taskId} has no machine_id, skipping dispatch`);
          return;
        }

        console.log(`[realtime:tasks] Task assigned: ${taskId} to machine ${machineId} (user ${userId})`);

        // 查找对应的 WebSocket 连接
        // 需要根据 machine_id 找到对应的 WebSocket
        // machine_id 对应 machines 表的 id，我们需要通过 userId 和 machine identifier 找到连接
        
        // 首先，查询 machine 信息以获取标识符（hwid 或 name）
        const { data: machine, error: machineError } = await supabase
          .from('machines')
          .select('id, name, hwid, user_id')
          .eq('id', machineId)
          .eq('user_id', userId)
          .maybeSingle();

        if (machineError || !machine) {
          console.error(`[realtime:tasks] Failed to find machine ${machineId} for user ${userId}:`, machineError);
          return;
        }

        // 查找对应的 WebSocket 连接（遍历所有已认证的连接，找到匹配的机器）
        let targetWs = findTargetWebSocketForMachine(userId, machine);

        if (!targetWs) {
          console.log(
            `[realtime:tasks] No active connection found for machine ${machineId} (${machine.name || machine.hwid || 'unknown'}), task ${taskId} will be dispatched when machine comes online`
          );

          // 额外安全检查：查询数据库中该机器当前状态，如果是 Active，说明可能刚刚上线但连接映射还没建立，
          // 延迟一小段时间后重试一次查找并派发任务（最佳努力，避免频繁重复派发）
          try {
            const { data: machineState, error: stateError } = await supabase
              .from('machines')
              .select('status, last_heartbeat')
              .eq('id', machineId)
              .eq('user_id', userId)
              .maybeSingle();

            if (!stateError && machineState && machineState.status === 'Active') {
              console.log(
                `[realtime:tasks] Machine ${machineId} is marked Active in DB, scheduling retry dispatch for task ${taskId}`
              );

              setTimeout(async () => {
                try {
                  const retryWs = findTargetWebSocketForMachine(userId, machine);
                  if (!retryWs || retryWs.readyState !== 1) {
                    console.log(
                      `[realtime:tasks] Retry: still no active connection for machine ${machineId}, task ${taskId} will stay pending`
                    );
                    return;
                  }

                  const normalizedListFileRetry = listFile ? toPublicUrl(listFile, userId) : null;
                  const normalizedProxyFileRetry = proxyFile ? toPublicUrl(proxyFile, userId) : null;

                  const retryMessage = {
                    type: 'task_assigned',
                    taskId,
                    name: taskName || null,
                    listFile: normalizedListFileRetry,
                    proxyFile: normalizedProxyFileRetry
                  };

                  retryWs.send(JSON.stringify(retryMessage));
                  console.log(
                    `[realtime:tasks] Retry dispatch: Task ${taskId} dispatched to machine ${machineId} (${machine.name || machine.hwid || 'unknown'})`
                  );
                } catch (retryError) {
                  console.error(
                    `[realtime:tasks] Retry dispatch failed for task ${taskId} on machine ${machineId}:`,
                    retryError
                  );
                }
              }, 3000);
            }
          } catch (stateCheckError) {
            console.error('[realtime:tasks] Error checking machine online state for retry:', stateCheckError);
          }

          return;
        }

        // 检查 WebSocket 连接状态
        // WebSocket.OPEN = 1 (from ws library)
        if (targetWs.readyState !== 1) {
          console.log(`[realtime:tasks] WebSocket connection for machine ${machineId} is not open (state: ${targetWs.readyState}), task ${taskId} will be dispatched when connection is ready`);
          return;
        }

        // 规范化文件 URL：如果数据库里是文件名/相对路径，这里自动补全为完整 Supabase 公网 URL
        const normalizedListFile = listFile ? toPublicUrl(listFile, userId) : null;
        const normalizedProxyFile = proxyFile ? toPublicUrl(proxyFile, userId) : null;

        // 构建并发送任务分配消息
        const taskMessage = {
          type: 'task_assigned',
          taskId: taskId,
          name: taskName || null,
          listFile: normalizedListFile,
          proxyFile: normalizedProxyFile
        };

        try {
          targetWs.send(JSON.stringify(taskMessage));
          console.log(`[realtime:tasks] Task ${taskId} dispatched to machine ${machineId} (${machine.name || machine.hwid || 'unknown'})`);
        } catch (error) {
          console.error(`[realtime:tasks] Failed to send task ${taskId} to machine ${machineId}:`, error);
        }
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'DELETE',
        schema: 'public',
        table: 'tasks'
      },
      async (payload) => {
        const deletedTask = payload.old;

        if (!deletedTask) {
          console.error('[realtime:tasks] Invalid task delete payload:', payload);
          return;
        }

        const {
          id: taskId,
          machine_id: machineId,
          user_id: userId
        } = deletedTask;

        if (!taskId) {
          console.error('[realtime:tasks] Deleted task has no id:', payload);
          return;
        }

        // 有些情况下（例如任务在 server 仍未恢复 machine 绑定就被删除），删除记录里可能没有 machine_id/user_id。
        // 尝试从 runningTasks 缓存中获取这些信息，确保可以向对应客户端发送取消指令。
        let resolvedMachineId = machineId;
        let resolvedUserId = userId;
        const runningInfo = runningTasks.get(taskId);
        if (!resolvedMachineId && runningInfo?.machineId) {
          resolvedMachineId = runningInfo.machineId;
        }
        if (!resolvedUserId && runningInfo?.userId) {
          resolvedUserId = runningInfo.userId;
        }

        console.log(`[realtime:tasks] Task ${taskId} deleted, stopping task on machine ${resolvedMachineId || 'unknown'} (user ${resolvedUserId || 'unknown'})`);

        // 无论机器是否在线，都先从 runningTasks 中移除，避免继续请求进度
        if (runningTasks.has(taskId)) {
          runningTasks.delete(taskId);
        }

        if (!resolvedMachineId || !resolvedUserId) {
          // 没有绑定机器或用户信息，只能做到清理服务器内部状态
          return;
        }

        try {
          // 查找对应的 machine 信息
          const { data: machine, error: machineError } = await supabase
            .from('machines')
            .select('id, name, hwid, user_id')
            .eq('id', resolvedMachineId)
            .eq('user_id', resolvedUserId)
            .maybeSingle();

          if (machineError || !machine) {
            console.error(`[realtime:tasks] Failed to find machine ${resolvedMachineId} for deleted task ${taskId}:`, machineError);
            return;
          }

          // 查找对应的 WebSocket 连接
          let targetWs = findTargetWebSocketForMachine(resolvedUserId, machine);

          if (!targetWs || targetWs.readyState !== 1) {
            console.log(`[realtime:tasks] No active connection for machine ${resolvedMachineId} when deleting task ${taskId}`);
            return;
          }

          // 发送取消消息给客户端，让客户端立刻停止本地任务并删除本地数据
          const taskCancelMessage = {
            type: 'task_cancel',
            taskId
          };

          try {
            targetWs.send(JSON.stringify(taskCancelMessage));
            console.log(`[realtime:tasks] Sent cancel command for deleted task ${taskId} to machine ${resolvedMachineId}`);
          } catch (error) {
            console.error(`[realtime:tasks] Failed to send cancel for deleted task ${taskId} to machine ${resolvedMachineId}:`, error);
          }
        } catch (error) {
          console.error('[realtime:tasks] Error handling task delete event:', error);
        }
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'tasks'
      },
      async (payload) => {
        const updatedTask = payload.new;
        const oldTask = payload.old;

        if (!updatedTask) {
          console.error('[realtime:tasks] Invalid task update payload:', payload);
          return;
        }

        // 处理 status 变为 'running' 或 'paused' 的情况
        const oldStatus = oldTask?.status;
        const newStatus = updatedTask.status;

        // 处理 status 变为 'paused' 的情况
        // 放宽条件：只要从「非 paused」状态变为「paused」，就发送暂停指令
        if (newStatus === 'paused' && oldStatus !== 'paused') {
          const {
            id: taskId,
            machine_id: machineId,
            user_id: userId
          } = updatedTask;

          if (!machineId) {
            return;
          }

          console.log(`[realtime:tasks] Task ${taskId} status changed to paused, sending pause command to machine ${machineId} (user ${userId})`);

          // 查找对应的 machine 信息
          const { data: machine, error: machineError } = await supabase
            .from('machines')
            .select('id, name, hwid, user_id')
            .eq('id', machineId)
            .eq('user_id', userId)
            .maybeSingle();

          if (machineError || !machine) {
            console.error(`[realtime:tasks] Failed to find machine ${machineId} for user ${userId}:`, machineError);
            return;
          }

          // 查找对应的 WebSocket 连接
          let targetWs = findTargetWebSocketForMachine(userId, machine);

          if (!targetWs || targetWs.readyState !== 1) {
            console.log(`[realtime:tasks] No active connection found for machine ${machineId}, pause command will be sent when machine comes online`);
            return;
          }

          // 发送暂停消息
          const taskPauseMessage = {
            type: 'task_pause',
            taskId: taskId
          };

          try {
            targetWs.send(JSON.stringify(taskPauseMessage));
            console.log(`[realtime:tasks] Task ${taskId} pause command dispatched to machine ${machineId}`);
            
            // 从 runningTasks 中移除
            runningTasks.delete(taskId);
          } catch (error) {
            console.error(`[realtime:tasks] Failed to send task pause command ${taskId} to machine ${machineId}:`, error);
          }

          return;
        }

        // 只处理 status 变为 'running' 的情况
        if (oldStatus === 'running' || newStatus !== 'running') {
          return; // 不是从其他状态变为 running，忽略
        }

        const {
          id: taskId,
          machine_id: machineId,
          name: taskName,
          list_file: listFile,
          proxy_file: proxyFile,
          user_id: userId
        } = updatedTask;

        if (!machineId) {
          console.log(`[realtime:tasks] Task ${taskId} has no machine_id, skipping dispatch`);
          return;
        }

        // 如果任务已经在 runningTasks 中，说明已经为该状态发过一次 task_start，
        // 此次 UPDATE 很可能是重复写入，直接跳过，避免重复日志和资源消耗。
        if (runningTasks.has(taskId)) {
          console.log(`[realtime:tasks] Task ${taskId} is already running, skipping duplicate start command`);
          return;
        }

        console.log(`[realtime:tasks] Task ${taskId} status changed to running, dispatching to machine ${machineId} (user ${userId})`);

        // 查找对应的 machine 信息
        const { data: machine, error: machineError } = await supabase
          .from('machines')
          .select('id, name, hwid, user_id')
          .eq('id', machineId)
          .eq('user_id', userId)
          .maybeSingle();

        if (machineError || !machine) {
          console.error(`[realtime:tasks] Failed to find machine ${machineId} for user ${userId}:`, machineError);
          return;
        }

        // 查找对应的 WebSocket 连接
        let targetWs = findTargetWebSocketForMachine(userId, machine);

        if (!targetWs) {
          console.log(
            `[realtime:tasks] No active connection found for machine ${machineId} (${machine.name || machine.hwid || 'unknown'}), task ${taskId} will be dispatched when machine comes online`
          );
          return;
        }

        // 检查 WebSocket 连接状态
        if (targetWs.readyState !== 1) {
          console.log(`[realtime:tasks] WebSocket connection for machine ${machineId} is not open (state: ${targetWs.readyState}), task ${taskId} will be dispatched when connection is ready`);
          return;
        }

        // 规范化文件 URL
        const normalizedListFile = listFile ? toPublicUrl(listFile, userId) : null;
        const normalizedProxyFile = proxyFile ? toPublicUrl(proxyFile, userId) : null;

        // 从 list_file 读取域名列表
        const allDomains = normalizedListFile ? await fetchDomainsFromListFile(normalizedListFile) : [];

        // 查询已完成的域名（从 paused 状态恢复时使用）
        const { data: completedUrls, error: urlQueryError } = await supabase
          .from('task_url')
          .select('domains, status')
          .eq('task_id', taskId)
          .in('status', ['completed', 'failed']);

        const completedDomains = new Set();
        if (!urlQueryError && completedUrls) {
          completedUrls.forEach(url => {
            if (url.domains) {
              completedDomains.add(url.domains);
            }
          });
        }

        // 过滤掉已完成的域名，只处理未完成的
        const remainingDomains = allDomains.filter(domain => !completedDomains.has(domain));
        const completedCount = completedDomains.size;
        const totalCount = allDomains.length;

        console.log(`[realtime:tasks] Task ${taskId}: ${completedCount}/${totalCount} domains already completed, ${remainingDomains.length} remaining`);

        // 更新 tasks 表中的恢复信息（明文显示）
        if (totalCount > 0) {
          const { error: updateError } = await supabase
            .from('tasks')
            .update({
              total_url_lines: totalCount,
              current_lines: completedCount,
              updated_at: new Date().toISOString()
            })
            .eq('id', taskId)
            .eq('user_id', userId);

          if (updateError) {
            console.error(`[realtime:tasks] Failed to update task recovery info for task ${taskId}:`, updateError);
          } else {
            console.log(`[realtime:tasks] Task ${taskId} recovery info updated: ${completedCount}/${totalCount} completed`);
          }
        }

        // 提取任务设置（完全按照数据库中的设置）
        let settings;
        try {
          settings = extractTaskSettings(updatedTask);
        } catch (error) {
          console.error(`[realtime:tasks] Failed to extract task settings for task ${taskId}:`, error);
          return;
        }

        // 构建并发送任务运行消息
        const taskStartMessage = {
          type: 'task_start',
          taskId: taskId,
          name: taskName || null,
          domains: remainingDomains, // 只发送未完成的域名
          completedCount: completedCount, // 已完成的域名数量
          totalCount: totalCount, // 总域名数量
          threads: settings.threads,
          worker: settings.worker,
          timeout: settings.timeout,
          listFile: normalizedListFile,
          proxyFile: normalizedProxyFile
        };

        try {
          targetWs.send(JSON.stringify(taskStartMessage));
          console.log(`[realtime:tasks] Task ${taskId} start command dispatched to machine ${machineId} (${machine.name || machine.hwid || 'unknown'}), domains: ${remainingDomains.length} (${completedCount}/${totalCount} already completed)`);
          
          // 将任务添加到 runningTasks Map，用于进度请求
          runningTasks.set(taskId, {
            ws: targetWs,
            userId: userId,
            machineId: machineId,
            lastProgressRequest: Date.now(),
            progressRequestCount: 0
          });
        } catch (error) {
          console.error(`[realtime:tasks] Failed to send task start command ${taskId} to machine ${machineId}:`, error);
        }
      }
    )
    .subscribe((status) => {
      console.log('[realtime:tasks] channel status:', status);
    });

  return channel;
}
