import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing Supabase environment variables');
}

// 使用service_role_key创建客户端，绕过RLS策略
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  },
  db: {
    schema: 'public'
  }
});

/**
 * 验证API Key是否存在于users表中
 * @param {string} apiKey - 要验证的API Key
 * @returns {Promise<{valid: boolean, userId?: string}>}
 */
export async function verifyApiKey(apiKey) {
  try {
    const cleanApiKey = apiKey ? apiKey.trim() : "";
    if (!cleanApiKey) {
      console.log("API Key is empty");
      return { valid: false };
    }

    console.log(`Verifying API Key (length: ${cleanApiKey.length})`);

    const { data, error } = await supabase
      .from("users")
      .select("id, status")
      .eq("apikey", cleanApiKey)
      .maybeSingle();

    if (error && error.code !== "PGRST116") {
      console.error("Supabase query error:", JSON.stringify(error, null, 2));
      return { valid: false };
    }

    if (data && data.id) {
      // 检查用户状态
      if (data.status !== "Active") {
        console.log(`API Key found but user status is: ${data.status}`);
        return { valid: false };
      }
      console.log(`API Key verified successfully for user: ${data.id}`);
      return { valid: true, userId: data.id };
    }

    console.log("API Key mismatch - no matching key found");
    return { valid: false };
  } catch (error) {
    console.error("Error verifying API key:", error);
    return { valid: false };
  }
}


/**
 * 保存或更新机器信息到machines表
 * @param {string} userId - 用户ID
 * @param {string} apiKey - API Key
 * @param {Object} machineInfo - 机器信息
 * @param {string} machineInfo.ip - IP地址
 * @param {string} machineInfo.ram - 内存信息
 * @param {number} machineInfo.cpuCores - CPU核心数
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function saveOrUpdateMachine(userId, apiKey, machineInfo) {
  try {
    console.log(`[saveOrUpdateMachine] Called with userId=${userId}, apiKey=${apiKey ? 'present' : 'missing'}, machineName=${machineInfo?.machineName}`);
    
    if (!userId || !apiKey || !machineInfo) {
      console.error('[saveOrUpdateMachine] Invalid parameters:', { userId, hasApiKey: !!apiKey, hasMachineInfo: !!machineInfo });
      return { success: false, error: 'Invalid parameters' };
    }

    const { ip, ram, cpuCores, machineName } = machineInfo;

    // 使用电脑名字作为机器标识（如果为空或unknown，则使用IP作为备用）
    const machineIdentifier = (machineName && machineName !== 'unknown') ? machineName : (ip || 'unknown');
    
    if (machineIdentifier === 'unknown') {
      console.error('[saveOrUpdateMachine] Cannot identify machine: both machineName and ip are unknown');
      return { success: false, error: 'Cannot identify machine: missing machineName and ip' };
    }

    // 首先尝试查找现有记录（根据user_id和name，如果name为空则使用ip）
    const { data: existingMachine, error: findError } = await supabase
      .from('machines')
      .select('id')
      .eq('user_id', userId)
      .eq('name', machineIdentifier)
      .maybeSingle();

    if (findError && findError.code !== 'PGRST116') {
      // PGRST116是"未找到记录"的错误，这是正常的
      console.error('Error finding machine:', findError);
      return { success: false, error: findError.message };
    }

    if (existingMachine) {
      // 更新现有记录（更新IP、RAM、Core等信息，但保留name字段）
      const machineData = {
        user_id: userId,
        apikey: apiKey,
        ip: ip || null, // IP可能会变化，所以更新它
        ram: ram || null,
        core: cpuCores || null,
        // 不更新name字段，保留数据库中的原有值
        status: 'Active',
        last_heartbeat: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      
      const { error: updateError } = await supabase
        .from('machines')
        .update(machineData)
        .eq('id', existingMachine.id);

      if (updateError) {
        console.error('Error updating machine:', updateError);
        return { success: false, error: updateError.message };
      }

      // 即使更新现有机器，也检查并更新users表中的machine_ip字段（如果IP不在其中）
      if (ip && ip !== 'unknown') {
        console.log(`[saveOrUpdateMachine] Machine exists, calling updateUserMachineIp for user ${userId}, IP ${ip}`);
        await updateUserMachineIp(userId, ip);
      }

      console.log(`Machine updated: user ${userId}, machineName ${machineIdentifier}`);
      return { success: true };
    } else {
      // 创建新记录（包含电脑名字）
      const machineData = {
        user_id: userId,
        apikey: apiKey,
        ip: ip || null,
        ram: ram || null,
        core: cpuCores || null,
        name: machineIdentifier, // 使用电脑名字或IP作为标识
        status: 'Active',
        last_heartbeat: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      
      const { error: insertError } = await supabase
        .from('machines')
        .insert(machineData);

      if (insertError) {
        console.error('Error inserting machine:', insertError);
        return { success: false, error: insertError.message };
      }

      // 更新users表中的machine_ip字段
      if (ip && ip !== 'unknown') {
        console.log(`[saveOrUpdateMachine] Machine created, calling updateUserMachineIp for user ${userId}, IP ${ip}`);
        await updateUserMachineIp(userId, ip);
      }

      console.log(`Machine created: user ${userId}, machineName ${machineIdentifier}`);
      return { success: true };
    }
  } catch (error) {
    console.error('Error in saveOrUpdateMachine:', error);
    return { success: false, error: error.message };
  }
}

/**
 * 更新users表中的machine_ip字段
 * 如果machine_ip_1为空，写入machine_ip_1
 * 如果machine_ip_1已有值但machine_ip_2为空，写入machine_ip_2
 * 如果machine_ip_1和machine_ip_2都有值但machine_ip_3为空，写入machine_ip_3
 * 如果IP已存在于任何一个字段中，则不更新
 * @param {string} userId - 用户ID
 * @param {string} ip - IP地址
 * @returns {Promise<void>}
 */
async function updateUserMachineIp(userId, ip) {
  try {
    console.log(`[updateUserMachineIp] Starting update for user ${userId} with IP ${ip}`);
    
    // 获取用户当前的machine_ip字段值
    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select('machine_ip_1, machine_ip_2, machine_ip_3')
      .eq('id', userId)
      .single();

    if (fetchError) {
      console.error(`[updateUserMachineIp] Error fetching user machine IPs for user ${userId}:`, fetchError);
      return;
    }

    console.log(`[updateUserMachineIp] Current user machine IPs:`, {
      machine_ip_1: user.machine_ip_1,
      machine_ip_2: user.machine_ip_2,
      machine_ip_3: user.machine_ip_3
    });

    // 检查IP是否已经存在于任何一个字段中
    if (user.machine_ip_1 === ip || user.machine_ip_2 === ip || user.machine_ip_3 === ip) {
      console.log(`[updateUserMachineIp] IP ${ip} already exists in user ${userId} machine IPs, skipping update`);
      return;
    }

    // 确定要更新的字段（安全地检查null和空字符串）
    let updateField = null;
    if (!user.machine_ip_1 || (typeof user.machine_ip_1 === 'string' && user.machine_ip_1.trim() === '')) {
      updateField = 'machine_ip_1';
    } else if (!user.machine_ip_2 || (typeof user.machine_ip_2 === 'string' && user.machine_ip_2.trim() === '')) {
      updateField = 'machine_ip_2';
    } else if (!user.machine_ip_3 || (typeof user.machine_ip_3 === 'string' && user.machine_ip_3.trim() === '')) {
      updateField = 'machine_ip_3';
    }

    if (updateField) {
      console.log(`[updateUserMachineIp] Updating ${updateField} for user ${userId} with IP ${ip}`);
      const { error: updateError } = await supabase
        .from('users')
        .update({ [updateField]: ip })
        .eq('id', userId);

      if (updateError) {
        console.error(`[updateUserMachineIp] Error updating ${updateField} for user ${userId}:`, updateError);
      } else {
        console.log(`[updateUserMachineIp] Successfully updated ${updateField} for user ${userId} with IP ${ip}`);
      }
    } else {
      console.log(`[updateUserMachineIp] All machine IP slots are full for user ${userId}, cannot add IP ${ip}`);
    }
  } catch (error) {
    console.error(`[updateUserMachineIp] Error in updateUserMachineIp for user ${userId}:`, error);
  }
}

/**
 * 更新机器的最后心跳时间
 * @param {string} userId - 用户ID
 * @param {string} machineName - 电脑名字（机器标识）
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function updateMachineHeartbeat(userId, machineName) {
  try {
    if (!userId || !machineName) {
      console.error('Invalid parameters for updateMachineHeartbeat');
      return { success: false, error: 'Invalid parameters' };
    }

    const { error } = await supabase
      .from('machines')
      .update({
        last_heartbeat: new Date().toISOString(),
        status: 'Active',
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId)
      .eq('name', machineName);

    if (error) {
      console.error('Error updating machine heartbeat:', error);
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (error) {
    console.error('Error in updateMachineHeartbeat:', error);
    return { success: false, error: error.message };
  }
}

/**
 * 将机器状态更新为离线
 * @param {string} userId - 用户ID
 * @param {string} machineName - 电脑名字（机器标识）
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function setMachineOffline(userId, machineName) {
  try {
    if (!userId || !machineName) {
      console.error('Invalid parameters for setMachineOffline');
      return { success: false, error: 'Invalid parameters' };
    }

    const { error } = await supabase
      .from('machines')
      .update({
        status: 'Offline',
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId)
      .eq('name', machineName);

    if (error) {
      console.error('Error setting machine offline:', error);
      return { success: false, error: error.message };
    }

    console.log(`Machine set to offline: user ${userId}, machineName ${machineName}`);
    return { success: true };
  } catch (error) {
    console.error('Error in setMachineOffline:', error);
    return { success: false, error: error.message };
  }
}

export default supabase;

