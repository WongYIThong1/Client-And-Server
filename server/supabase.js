import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import crypto from 'crypto';

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

    // ✅ 修复：使用索引查询，只查询匹配的记录（而不是查询所有用户）
    // 先尝试使用 .eq() 查询
    const { data: user, error: queryError } = await supabase
      .from("users")
      .select("id, status, expires_at")
      .eq("apikey", cleanApiKey)
      .maybeSingle();

    // 如果 .eq() 查询失败（可能是 Supabase 的已知问题），使用备选方案
    if (queryError || !user) {
      // 备选方案：查询所有用户并在内存中匹配（保留原逻辑作为后备）
      // 注意：这仍然有性能问题，但至少不会因为查询失败而完全无法工作
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

      const matchedUser = allUsers.find(u => {
        if (!u.apikey) return false;
        return u.apikey.trim() === cleanApiKey.trim();
      });

      if (!matchedUser) {
        return { valid: false };
      }

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

      console.log(`API Key verified: user ${matchedUser.id} (using fallback method)`);
      return { valid: true, userId: matchedUser.id };
    }

    // ✅ 使用索引查询成功的情况
    // 检查用户状态
    if (user.status !== "Active") {
      return { valid: false };
    }
    
    // 检查 plan 是否过期
    if (user.expires_at) {
      const expiresAt = new Date(user.expires_at);
      const now = new Date();
      if (expiresAt < now) {
        return { valid: false, planExpired: true };
      }
    }

    console.log(`API Key verified: user ${user.id}`);
    return { valid: true, userId: user.id };
  } catch (error) {
    console.error("Error verifying API key:", error);
    return { valid: false };
  }
}


/**
 * 生成 HWID（服务器端 fallback）
 * @param {string} userId - 用户ID
 * @param {string} ip - IP地址
 * @param {string} machineName - 机器名称
 * @returns {string} HWID
 */
function generateHWID(userId, ip, machineName) {
  const combined = `${userId}||${ip || ''}||${machineName || ''}`;
  const hash = crypto.createHash('sha256').update(combined).digest('hex');
  return hash.substring(0, 32); // 取前32个字符
}

/**
 * 保存或更新机器信息到machines表
 * @param {string} userId - 用户ID
 * @param {string} apiKey - API Key
 * @param {Object} machineInfo - 机器信息
 * @param {string} machineInfo.ip - IP地址
 * @param {string} machineInfo.ram - 内存信息
 * @param {number} machineInfo.cpuCores - CPU核心数
 * @param {string} machineInfo.hwid - 硬件ID（可选）
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function saveOrUpdateMachine(userId, apiKey, machineInfo) {
  try {
    if (!userId || !apiKey || !machineInfo) {
      return { success: false, error: 'Invalid parameters' };
    }

    const { ip, ram, cpuCores, machineName, hwid } = machineInfo;
    
    // 如果客户端没有提供 hwid，服务器端自动生成一个
    let finalHWID = hwid;
    if (!finalHWID || finalHWID.trim() === '') {
      finalHWID = generateHWID(userId, ip, machineName);
      console.log(`Generated HWID for user ${userId}: ${finalHWID}`);
    }

    // 使用电脑名字作为机器标识（如果为空或unknown，则使用IP作为备用）
    const machineIdentifier = (machineName && machineName !== 'unknown') ? machineName : (ip || 'unknown');
    
    if (machineIdentifier === 'unknown') {
      return { success: false, error: 'Cannot identify machine: missing machineName and ip' };
    }

    // 查找策略（优先级从高到低）：
    // 0. 优先根据 user_id + hwid 查找（HWID是最稳定的标识）
    // 1. 根据 user_id + ip 查找（保持向后兼容）
    // 2. 根据 user_id + name 查找（使用客户端发送的name）
    // 3. 根据 user_id + cpuCores 匹配（辅助匹配）
    let existingMachine = null;
    
    // 策略0（最高优先级）: 根据HWID查找
    if (finalHWID) {
      const { data: machineByHWID, error: findErrorByHWID } = await supabase
        .from('machines')
        .select('id, name, ram, core, hwid')
        .eq('user_id', userId)
        .eq('hwid', finalHWID)
        .maybeSingle();

      if (findErrorByHWID && findErrorByHWID.code !== 'PGRST116') {
        return { success: false, error: findErrorByHWID.message };
      }

      if (machineByHWID) {
        existingMachine = machineByHWID;
        console.log(`Found machine by HWID: ${machineByHWID.name} (ID: ${machineByHWID.id})`);
      }
    }
    
    // 策略1: 根据IP查找（向后兼容）
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
      // 更新现有记录（更新IP、RAM、Core、HWID等信息，但保留name字段）
      const machineData = {
        user_id: userId,
        apikey: apiKey,
        ip: ip || null, // IP可能会变化，所以更新它
        ram: ram || null,
        core: cpuCores || null,
        hwid: finalHWID, // 更新或设置 HWID
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
      // 创建新记录（包含电脑名字和HWID）
      const machineData = {
        user_id: userId,
        apikey: apiKey,
        ip: ip || null,
        ram: ram || null,
        core: cpuCores || null,
        name: machineIdentifier, // 使用电脑名字或IP作为标识
        hwid: finalHWID, // 保存 HWID
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
 * @param {string} machineIdentifier - 机器标识（优先使用 hwid，否则使用 name）
 * @param {string} hwid - 硬件ID（可选）
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function updateMachineHeartbeat(userId, machineIdentifier, hwid = null) {
  try {
    if (!userId || !machineIdentifier) {
      console.error('Invalid parameters for updateMachineHeartbeat');
      return { success: false, error: 'Invalid parameters' };
    }

    let query = supabase
      .from('machines')
      .update({
        last_heartbeat: new Date().toISOString(),
        status: 'Active',
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId);

    // 优先使用 hwid，如果没有则使用 name
    if (hwid) {
      query = query.eq('hwid', hwid);
    } else {
      query = query.eq('name', machineIdentifier);
    }

    const { error } = await query;

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
 * @param {string} machineIdentifier - 机器标识（优先使用 hwid，否则使用 name）
 * @param {string} hwid - 硬件ID（可选）
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function setMachineOffline(userId, machineIdentifier, hwid = null) {
  try {
    if (!userId || !machineIdentifier) {
      console.error('Invalid parameters for setMachineOffline');
      return { success: false, error: 'Invalid parameters' };
    }

    let query = supabase
      .from('machines')
      .update({
        status: 'Offline',
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId);

    // 优先使用 hwid，如果没有则使用 name
    if (hwid) {
      query = query.eq('hwid', hwid);
    } else {
      query = query.eq('name', machineIdentifier);
    }

    const { error } = await query;

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
 * @param {string} machineIdentifier - 机器标识（优先使用 hwid，否则使用 name）
 * @param {string} hwid - 硬件ID（可选）
 * @returns {Promise<{exists: boolean, error?: string}>}
 */
export async function checkMachineExists(userId, machineIdentifier, hwid = null) {
  try {
    if (!userId || !machineIdentifier) {
      return { exists: false };
    }

    let query = supabase
      .from('machines')
      .select('id')
      .eq('user_id', userId);

    // 优先使用 hwid，如果没有则使用 name
    if (hwid) {
      query = query.eq('hwid', hwid);
    } else {
      query = query.eq('name', machineIdentifier);
    }

    const { data, error } = await query.maybeSingle();

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

