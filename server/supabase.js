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
 * 检查用户的 plan 是否过期
 * @param {string} userId - 用户ID
 * @returns {Promise<{expired: boolean, expiresAt?: Date}>}
 */
export async function checkPlanExpired(userId) {
  try {
    if (!userId) {
      return { expired: false };
    }

    const { data: user, error } = await supabase
      .from("users")
      .select("expires_at")
      .eq("id", userId)
      .single();

    if (error || !user) {
      return { expired: false };
    }

    if (!user.expires_at) {
      return { expired: false };
    }

    const expiresAt = new Date(user.expires_at);
    const now = new Date();
    const expired = expiresAt < now;

    return { expired, expiresAt };
  } catch (error) {
    console.error("Error checking plan expiration:", error);
    return { expired: false };
  }
}

/**
 * 验证API Key是否存在于users表中
 * @param {string} apiKey - 要验证的API Key
 * @returns {Promise<{valid: boolean, userId?: string, planExpired?: boolean}>}
 */
export async function verifyApiKey(apiKey) {
  try {
    const cleanApiKey = apiKey ? apiKey.trim() : "";
    if (!cleanApiKey) {
      return { valid: false };
    }

    // 直接查询所有用户然后在代码中过滤（绕过 Supabase .eq() 查询问题）
    const { data: allUsers, error: fetchError } = await supabase
      .from("users")
      .select("id, status, apikey, expires_at");

    if (fetchError) {
      console.error("Error fetching users:", fetchError.message);
      return { valid: false };
    }

    if (!allUsers || allUsers.length === 0) {
      return { valid: false };
    }

    // 在代码中查找匹配的 API Key（使用 trim 确保没有空格问题）
    const matchedUser = allUsers.find(user => {
      if (!user.apikey) return false;
      return user.apikey.trim() === cleanApiKey.trim();
    });

    if (matchedUser) {
      // 检查用户状态
      if (matchedUser.status !== "Active") {
        return { valid: false };
      }
      
      // 检查 plan 是否过期
      if (matchedUser.expires_at) {
        const expiresAt = new Date(matchedUser.expires_at);
        const now = new Date();
        if (expiresAt < now) {
          return { valid: false, planExpired: true };
        }
    }

      console.log(`API Key verified: user ${matchedUser.id}`);
      return { valid: true, userId: matchedUser.id };
    }
    
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
    if (!userId || !apiKey || !machineInfo) {
      return { success: false, error: 'Invalid parameters' };
    }

    const { ip, ram, cpuCores, machineName } = machineInfo;

    // 使用电脑名字作为机器标识（如果为空或unknown，则使用IP作为备用）
    const machineIdentifier = (machineName && machineName !== 'unknown') ? machineName : (ip || 'unknown');
    
    if (machineIdentifier === 'unknown') {
      return { success: false, error: 'Cannot identify machine: missing machineName and ip' };
    }

    // 查找策略：
    // 1. 优先根据 user_id + ip 查找（IP是最稳定的标识）
    // 2. 如果IP没找到，尝试根据 user_id + name 查找（使用客户端发送的name）
    // 3. 如果还是没找到，查询该用户的所有机器，尝试根据系统特征匹配（CPU核心数）
    let existingMachine = null;
    
    // 策略1: 根据IP查找
    if (ip && ip !== 'unknown') {
      const { data: machineByIp, error: findErrorByIp } = await supabase
        .from('machines')
        .select('id, name, ram, core')
        .eq('user_id', userId)
        .eq('ip', ip)
        .maybeSingle();

      if (findErrorByIp && findErrorByIp.code !== 'PGRST116') {
        return { success: false, error: findErrorByIp.message };
      }

      if (machineByIp) {
        existingMachine = machineByIp;
        console.log(`Found machine by IP: ${machineByIp.name} (ID: ${machineByIp.id})`);
      }
    }

    // 策略2: 如果IP没找到，尝试根据name查找（使用客户端发送的name）
    if (!existingMachine && machineIdentifier && machineIdentifier !== 'unknown') {
      const { data: machineByName, error: findErrorByName } = await supabase
        .from('machines')
        .select('id, name, ram, core')
        .eq('user_id', userId)
        .eq('name', machineIdentifier)
        .maybeSingle();

      if (findErrorByName && findErrorByName.code !== 'PGRST116') {
        return { success: false, error: findErrorByName.message };
      }

      if (machineByName) {
        existingMachine = machineByName;
        console.log(`Found machine by name: ${machineByName.name} (ID: ${machineByName.id})`);
      }
    }

    // 策略3: 如果还是没找到，尝试根据系统特征匹配（防止IP和name都变化的情况）
    // 查询该用户的所有Active机器，尝试根据CPU核心数匹配
    // 注意：这个策略主要用于处理用户重命名machine后，IP也变化的情况
    if (!existingMachine && cpuCores > 0) {
      const { data: allMachines, error: findAllError } = await supabase
        .from('machines')
        .select('id, name, ram, core, ip')
        .eq('user_id', userId)
        .in('status', ['Active', 'Offline']) // 包括Offline状态的机器，因为可能刚离线
        .limit(20); // 增加查询数量，以防用户有多台机器

      if (!findAllError && allMachines && allMachines.length > 0) {
        // 尝试匹配CPU核心数
        // 如果有多台机器CPU核心数相同，优先选择最近活跃的（通过updated_at判断）
        const machinesWithSameCores = allMachines.filter(m => m.core === cpuCores);
        
        if (machinesWithSameCores.length === 1) {
          // 只有一台机器匹配，使用它
          existingMachine = machinesWithSameCores[0];
          console.log(`Matched machine by CPU cores: ${existingMachine.name} (ID: ${existingMachine.id})`);
        } else if (machinesWithSameCores.length > 1) {
          // 多台机器CPU核心数相同，需要更精确的匹配
          // 如果客户端发送的name（系统主机名）与数据库中某台机器的name匹配，优先使用它
          // 否则，使用第一台（通常是最早创建的）
          const exactNameMatch = machinesWithSameCores.find(m => m.name === machineIdentifier);
          if (exactNameMatch) {
            existingMachine = exactNameMatch;
            console.log(`Matched machine by CPU cores and name: ${existingMachine.name} (ID: ${existingMachine.id})`);
          } else {
            // 如果name也不匹配，说明用户可能重命名了，使用第一台
            existingMachine = machinesWithSameCores[0];
            console.log(`Matched machine by CPU cores (multiple matches, using first): ${existingMachine.name} (ID: ${existingMachine.id})`);
          }
        }
      }
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
        return { success: false, error: updateError.message };
      }

      // 即使更新现有机器，也检查并更新users表中的machine_name字段（如果机器名不在其中）
      if (machineIdentifier && machineIdentifier !== 'unknown') {
        await updateUserMachineName(userId, machineIdentifier);
      }

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
        return { success: false, error: insertError.message };
      }

      // 更新users表中的machine_name字段
      if (machineIdentifier && machineIdentifier !== 'unknown') {
        await updateUserMachineName(userId, machineIdentifier);
      }

      return { success: true };
    }
  } catch (error) {
    console.error('Error in saveOrUpdateMachine:', error);
    return { success: false, error: error.message };
  }
}

/**
 * 更新users表中的machine_name字段
 * 如果machine_name_1为空，写入machine_name_1
 * 如果machine_name_1已有值但machine_name_2为空，写入machine_name_2
 * 如果machine_name_1和machine_name_2都有值但machine_name_3为空，写入machine_name_3
 * 如果机器名已存在于任何一个字段中，则不更新
 * @param {string} userId - 用户ID
 * @param {string} machineName - 机器名称
 * @returns {Promise<void>}
 */
async function updateUserMachineName(userId, machineName) {
  try {
    // 获取用户当前的machine_name字段值
    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select('machine_name_1, machine_name_2, machine_name_3')
      .eq('id', userId)
      .single();

    if (fetchError) {
      return;
    }

    // 检查机器名是否已经存在于任何一个字段中
    if (user.machine_name_1 === machineName || user.machine_name_2 === machineName || user.machine_name_3 === machineName) {
      return;
    }

    // 确定要更新的字段（安全地检查null和空字符串）
    let updateField = null;
    if (!user.machine_name_1 || (typeof user.machine_name_1 === 'string' && user.machine_name_1.trim() === '')) {
      updateField = 'machine_name_1';
    } else if (!user.machine_name_2 || (typeof user.machine_name_2 === 'string' && user.machine_name_2.trim() === '')) {
      updateField = 'machine_name_2';
    } else if (!user.machine_name_3 || (typeof user.machine_name_3 === 'string' && user.machine_name_3.trim() === '')) {
      updateField = 'machine_name_3';
    }

    if (updateField) {
      await supabase
        .from('users')
        .update({ [updateField]: machineName })
        .eq('id', userId);
    }
  } catch (error) {
    // 静默处理错误
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

    return { success: true };
  } catch (error) {
    console.error('Error in setMachineOffline:', error);
    return { success: false, error: error.message };
  }
}

/**
 * 检查machine是否存在
 * @param {string} userId - 用户ID
 * @param {string} machineName - 电脑名字（机器标识）
 * @returns {Promise<{exists: boolean, error?: string}>}
 */
export async function checkMachineExists(userId, machineName) {
  try {
    if (!userId || !machineName) {
      return { exists: false };
    }

    const { data, error } = await supabase
      .from('machines')
      .select('id')
      .eq('user_id', userId)
      .eq('name', machineName)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') {
      console.error('Error checking machine existence:', error);
      return { exists: false, error: error.message };
    }

    return { exists: !!data };
  } catch (error) {
    console.error('Error in checkMachineExists:', error);
    return { exists: false, error: error.message };
  }
}

export default supabase;

