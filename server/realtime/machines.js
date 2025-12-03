import supabase, { pauseRunningTasksForMachine } from '../supabase.js';

// 导入清除缓存的函数（从tasks.js导出）
let clearMachineCache = null;

/**
 * 设置清除缓存函数（由tasks.js调用）
 * @param {function} fn - 清除缓存函数
 */
export function setClearMachineCacheFunction(fn) {
  clearMachineCache = fn;
}

/**
 * Subscribe to Supabase Realtime for machine status updates.
 * 当前仅在服务端打印日志，方便将来接入 Web 管理面板做在线状态展示。
 */
export function startMachineRealtimeListener() {
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 10;
  const BASE_RECONNECT_DELAY = 5000; // 5秒基础延迟
  let reconnectTimer = null;

  const channel = supabase
    .channel('public:machines')
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'machines'
      },
      async (payload) => {
        const { old, new: next, eventType } = payload;

        if (eventType === 'UPDATE') {
          const prevStatus = old?.status;
          const nextStatus = next?.status;
          const machineId = next?.id;

          // 清除machine缓存（机器信息已更新）
          if (machineId && clearMachineCache) {
            clearMachineCache(machineId);
          }

          if (prevStatus !== nextStatus) {
            console.log(
              `[realtime:machines] Machine ${machineId} status ${prevStatus} -> ${nextStatus} (user ${next.user_id})`
            );

            // 当机器从 Active 变为 Offline（或其他非 Active 状态）时，
            // 将该机器上仍然处于 running 状态的任务全部标记为 paused，防止"幽灵任务"继续占用配额。
            if (prevStatus === 'Active' && nextStatus && nextStatus !== 'Active') {
              try {
                const userId = next.user_id;
                const result = await pauseRunningTasksForMachine(userId, machineId);
                if (!result.success) {
                  console.error(
                    `[realtime:machines] Failed to pause running tasks for machine ${machineId}:`,
                    result.error
                  );
                }
              } catch (error) {
                console.error(
                  '[realtime:machines] Error while pausing running tasks for offline machine:',
                  error
                );
              }
            }
          }
        } else {
          console.log('[realtime:machines] change:', {
            eventType,
            id: next?.id || old?.id,
            user_id: next?.user_id || old?.user_id
          });
        }
      }
    )
    .subscribe((status, err) => {
      if (err) {
        console.error('[realtime:machines] Channel error:', err);
      }
      
      if (status === 'SUBSCRIBED') {
        console.log('[realtime:machines] Channel subscribed successfully');
        reconnectAttempts = 0; // 重置重连计数
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        reconnectAttempts++;
        
        if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
          console.error(`[realtime:machines] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Channel may be unstable.`);
          return;
        }

        // 指数退避：延迟时间 = BASE_DELAY * 2^(attempts-1)，最大60秒
        const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1), 60000);
        console.warn(`[realtime:machines] Channel ${status}, will reconnect in ${delay/1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
        
        // 清除之前的重连定时器
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
        }

        reconnectTimer = setTimeout(() => {
          try {
            // 重新订阅当前频道
            channel.unsubscribe();
            channel.subscribe();
          } catch (reconnectError) {
            console.error('[realtime:machines] Failed to reconnect:', reconnectError);
          }
        }, delay);
      } else {
        console.log('[realtime:machines] channel status:', status);
      }
    });

  return channel;
}


