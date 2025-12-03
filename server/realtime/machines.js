import supabase, { pauseRunningTasksForMachine } from '../supabase.js';

/**
 * Subscribe to Supabase Realtime for machine status updates.
 * 当前仅在服务端打印日志，方便将来接入 Web 管理面板做在线状态展示。
 */
export function startMachineRealtimeListener() {
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

          if (prevStatus !== nextStatus) {
            console.log(
              `[realtime:machines] Machine ${next.id} status ${prevStatus} -> ${nextStatus} (user ${next.user_id})`
            );

            // 当机器从 Active 变为 Offline（或其他非 Active 状态）时，
            // 将该机器上仍然处于 running 状态的任务全部标记为 paused，防止“幽灵任务”继续占用配额。
            if (prevStatus === 'Active' && nextStatus && nextStatus !== 'Active') {
              try {
                const userId = next.user_id;
                const machineId = next.id;
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
    .subscribe((status) => {
      console.log('[realtime:machines] channel status:', status);
    });

  return channel;
}


