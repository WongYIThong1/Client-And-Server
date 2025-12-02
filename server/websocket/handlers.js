import { saveOrUpdateMachine, setMachineOffline, checkMachineExists } from '../supabase.js';
import supabase from '../supabase.js';
import { authenticatedConnections, clientSystemInfo } from '../stores.js';

/**
 * Handle incoming system_info messages.
 * Creates or updates machine records, but stops recreating machines that were deleted by the user.
 */
export async function handleSystemInfo(ws, data, isAuthenticated) {
  if (data.type !== 'system_info') return false;

  if (!isAuthenticated) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Authentication required before sending system info'
    }));
    return true;
  }

  const previousInfo = clientSystemInfo.get(ws) || {};
  const systemInfo = {
    ip: data.ip || previousInfo.ip || 'unknown',
    ram: data.ram || previousInfo.ram || 'unknown',
    cpuCores: data.cpuCores || previousInfo.cpuCores || 0,
    machineName: data.machineName || previousInfo.machineName || 'unknown',
    hwid: data.hwid || previousInfo.hwid || null,
    receivedAt: Date.now()
  };

  clientSystemInfo.set(ws, systemInfo);

  const connInfo = authenticatedConnections.get(ws);
  const userId = connInfo?.userId ?? 'unknown';
  const apiKey = connInfo?.apiKey ?? null;

  if (userId !== 'unknown' && apiKey && systemInfo.ip !== 'unknown') {
    const machineIdentifier = (systemInfo.machineName && systemInfo.machineName !== 'unknown')
      ? systemInfo.machineName
      : (systemInfo.ip && systemInfo.ip !== 'unknown' ? systemInfo.ip : null);

    if (machineIdentifier) {
      const machineCheck = await checkMachineExists(userId, machineIdentifier, systemInfo.hwid);

      if (!machineCheck.exists) {
        // Try to match by IP for renamed machines.
        const { data: machineByIp } = await supabase
          .from('machines')
          .select('id, name')
          .eq('user_id', userId)
          .eq('ip', systemInfo.ip)
          .maybeSingle();

        if (!machineByIp) {
          // Check whether this machine name/IP ever existed (user deleted it).
          const { data: userProfile } = await supabase
            .from('users')
            .select('machine_name_1, machine_name_2, machine_name_3')
            .eq('id', userId)
            .maybeSingle();

          const knownNames = [
            userProfile?.machine_name_1,
            userProfile?.machine_name_2,
            userProfile?.machine_name_3
          ].filter(Boolean).map(name => typeof name === 'string' ? name.trim() : name);

          const wasKnownMachine = knownNames.includes(machineIdentifier);
          const connectionAge = connInfo ? (Date.now() - connInfo.connectedAt) : 0;
          const isNewConnection = connectionAge < 10_000; // first 10s after connect

          if (wasKnownMachine) {
            console.log(`Machine ${machineIdentifier} previously known for user ${userId}, treating as deleted`);
            ws.send(JSON.stringify({
              type: 'machine_deleted',
              message: 'Your machine has been deleted. Please re-authenticate.'
            }));
            setTimeout(() => ws.close(1000, 'Machine deleted'), 500);
            return true;
          }

          const { data: otherMachines } = await supabase
            .from('machines')
            .select('id')
            .eq('user_id', userId)
            .limit(1);

          const hasOtherMachines = otherMachines && otherMachines.length > 0;

          if (isNewConnection && !hasOtherMachines) {
            console.log(`New connection detected, allowing machine creation for user ${userId}`);
          } else {
            console.log(`Machine ${machineIdentifier} not found for user ${userId}, machine was deleted`);
            ws.send(JSON.stringify({
              type: 'machine_deleted',
              message: 'Your machine has been deleted. Please re-authenticate.'
            }));
            setTimeout(() => ws.close(1000, 'Machine deleted'), 500);
            return true;
          }
        }
      }
    }

    const result = await saveOrUpdateMachine(userId, apiKey, {
      ip: systemInfo.ip,
      ram: systemInfo.ram,
      cpuCores: systemInfo.cpuCores,
      machineName: systemInfo.machineName,
      hwid: systemInfo.hwid
    });

    if (!result.success) {
      console.error(`Failed to save machine info: ${result.error}`);
    }
  }

  ws.send(JSON.stringify({
    type: 'system_info_received',
    message: 'System information received'
  }));

  return true;
}

/**
 * Echo data messages for connectivity checks.
 */
export function handleData(ws, data) {
  if (data.type !== 'data') return false;

  ws.send(JSON.stringify({
    type: 'data',
    message: 'Data received',
    timestamp: Date.now()
  }));

  return true;
}

/**
 * Handle explicit disconnect requests.
 */
export async function handleDisconnect(ws, data, isAuthenticated) {
  if (data.type !== 'disconnect') return false;

  if (!isAuthenticated) return true;

  const connInfo = authenticatedConnections.get(ws);
  const sysInfo = clientSystemInfo.get(ws);
  const userId = connInfo ? connInfo.userId : 'unknown';

  const machineIdentifier = sysInfo
    ? ((sysInfo.machineName && sysInfo.machineName !== 'unknown')
        ? sysInfo.machineName
        : (sysInfo.ip && sysInfo.ip !== 'unknown' ? sysInfo.ip : null))
    : null;

  if (userId !== 'unknown' && machineIdentifier) {
    const hwid = sysInfo ? sysInfo.hwid : null;
    const result = await setMachineOffline(userId, machineIdentifier, hwid);
    if (!result.success) {
      console.error(`Failed to set machine offline: ${result.error}`);
    }
  }

  ws.send(JSON.stringify({
    type: 'disconnect_ack',
    message: 'Disconnect acknowledged'
  }));

  setTimeout(() => {
    ws.close();
  }, 100);

  return true;
}
