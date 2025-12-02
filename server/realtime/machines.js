import supabase from '../supabase.js';

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
      (payload) => {
        const { old, new: next, eventType } = payload;
        if (eventType === 'UPDATE') {
          const prevStatus = old?.status;
          const nextStatus = next?.status;
          if (prevStatus !== nextStatus) {
            console.log(
              `[realtime:machines] Machine ${next.id} status ${prevStatus} -> ${nextStatus} (user ${next.user_id})`
            );
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


