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

      return { success: true, machineId: existingMachine.id, updated: true, created: false };
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
      
      const { data: inserted, error: insertError } = await supabase
        .from('machines')
        .insert(machineData)
        .select('id')
        .single();

      if (insertError) {
        return { success: false, error: insertError.message };
      }

      // 更新users表中的machine_name字段
      if (machineIdentifier && machineIdentifier !== 'unknown') {
        await updateUserMachineName(userId, machineIdentifier);
      }

      return { success: true, machineId: inserted?.id || null, created: true, updated: false };
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
 * 从users表中移除指定的machine_name条目
 * @param {string} userId
 * @param {string} machineName
 * @returns {Promise<{success: boolean, updated: boolean, error?: string}>}
 */
export async function removeMachineName(userId, machineName) {
  try {
    if (!userId || !machineName) {
      return { success: false, updated: false, error: 'Invalid parameters' };
    }

    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select('machine_name_1, machine_name_2, machine_name_3')
      .eq('id', userId)
      .maybeSingle();

    if (fetchError || !user) {
      return { success: false, updated: false, error: fetchError ? fetchError.message : 'User not found' };
    }

    const updates = {};
    if (user.machine_name_1 === machineName) {
      updates.machine_name_1 = null;
    }
    if (user.machine_name_2 === machineName) {
      updates.machine_name_2 = null;
    }
    if (user.machine_name_3 === machineName) {
      updates.machine_name_3 = null;
    }

    if (Object.keys(updates).length === 0) {
      return { success: true, updated: false };
    }

    const { error: updateError } = await supabase
      .from('users')
      .update(updates)
      .eq('id', userId);

    if (updateError) {
      return { success: false, updated: false, error: updateError.message };
    }

    return { success: true, updated: true };
  } catch (error) {
    return { success: false, updated: false, error: error.message };
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

/**
 * 在指定机器断开连接时，将该机器上的运行中任务设置为暂停，并保存当前进度
 * @param {string} userId - 用户ID
 * @param {string} machineId - machines 表中的机器ID
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function pauseRunningTasksForMachine(userId, machineId) {
  try {
    if (!userId || !machineId) {
      console.error('Invalid parameters for pauseRunningTasksForMachine');
      return { success: false, error: 'Invalid parameters' };
    }

    // 查询该机器上所有运行中的任务
    const { data: runningTasks, error: queryError } = await supabase
      .from('tasks')
      .select('id')
      .eq('user_id', userId)
      .eq('machine_id', machineId)
      .eq('status', 'running');

    if (queryError) {
      console.error('Error querying running tasks:', queryError);
      return { success: false, error: queryError.message };
    }

    if (!runningTasks || runningTasks.length === 0) {
      return { success: true }; // 没有运行中的任务
    }

    // 对每个任务，计算当前进度并更新
    for (const task of runningTasks) {
      const taskId = task.id;

      // 查询 task_url 表中该任务的已完成数量
      const { data: taskUrls, error: urlQueryError } = await supabase
        .from('task_url')
        .select('domains, status, progress')
        .eq('task_id', taskId);

      if (urlQueryError) {
        console.error(`Error querying task_url for task ${taskId}:`, urlQueryError);
        continue;
      }

      // 计算已完成的数量（status 为 completed 或 failed）
      const completedCount = taskUrls ? taskUrls.filter(url => 
        url.status === 'completed' || url.status === 'failed'
      ).length : 0;

      // 计算总域名数量（从 task_url 表获取，如果没有则使用 tasks 表的 progress）
      const totalUrls = taskUrls ? taskUrls.length : 0;

      // 计算进度百分比
      let progress = 0;
      if (totalUrls > 0) {
        progress = Math.round((completedCount / totalUrls) * 100);
      } else {
        // 如果没有 task_url 记录，尝试从 tasks.progress 获取
        const { data: taskData } = await supabase
          .from('tasks')
          .select('progress')
          .eq('id', taskId)
          .maybeSingle();
        progress = taskData?.progress || 0;
      }

      // 更新任务状态为 paused，并保存进度和恢复信息（明文显示）
      const { error: updateError } = await supabase
        .from('tasks')
        .update({
          status: 'paused',
          progress: progress,
          current_lines: completedCount,
          total_url_lines: totalUrls,
          updated_at: new Date().toISOString()
        })
        .eq('id', taskId)
        .eq('user_id', userId);

      if (updateError) {
        console.error(`Error pausing task ${taskId}:`, updateError);
      } else {
        console.log(`[pause] Task ${taskId} paused at progress ${progress}% (${completedCount}/${totalUrls} completed)`);
      }
    }

    return { success: true };
  } catch (error) {
    console.error('Error in pauseRunningTasksForMachine:', error);
    return { success: false, error: error.message };
  }
}

/**
 * 更新指定任务的进度和状态
 * @param {string} userId - 用户ID
 * @param {string} taskId - 任务ID（tasks.id）
 * @param {number} progress - 进度百分比（0-100）
 * @param {string} [status] - 可选的新状态（pending/running/paused/completed/failed）
 * @param {number} [currentLines] - 可选：当前已完成的域名数量（实时更新）
 * @param {number} [totalLines] - 可选：总域名数量（实时更新）
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function updateTaskProgress(userId, taskId, progress, status, currentLines, totalLines) {
  try {
    if (!userId || !taskId) {
      console.error('Invalid parameters for updateTaskProgress');
      return { success: false, error: 'Invalid parameters' };
    }

    // 限制进度在 0-100 之间
    let safeProgress = Number.isFinite(progress) ? Math.round(progress) : 0;
    if (safeProgress < 0) safeProgress = 0;
    if (safeProgress > 100) safeProgress = 100;

    const updateData = {
      progress: safeProgress,
      updated_at: new Date().toISOString()
    };

    if (status && typeof status === 'string') {
      updateData.status = status;
    }

    // 实时更新当前行数和总行数（明文显示）
    if (typeof currentLines === 'number' && currentLines >= 0) {
      updateData.current_lines = currentLines;
    }
    if (typeof totalLines === 'number' && totalLines > 0) {
      updateData.total_url_lines = totalLines;
    }

    const { error } = await supabase
      .from('tasks')
      .update(updateData)
      .eq('id', taskId)
      .eq('user_id', userId);

    if (error) {
      console.error('Error updating task progress:', error);
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (error) {
    console.error('Error in updateTaskProgress:', error);
    return { success: false, error: error.message };
  }
}

/**
 * 检查机器名是否已记录（用于区分全新机器 vs 已被用户删除的机器）
 * @param {string} userId
 * @param {string} machineName
 * @returns {Promise<{tracked: boolean, error?: string}>}
 */
export async function isMachineNameTracked(userId, machineName) {
  try {
    if (!userId || !machineName) {
      return { tracked: false };
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('machine_name_1, machine_name_2, machine_name_3')
      .eq('id', userId)
      .maybeSingle();

    if (error || !user) {
      return { tracked: false, error: error?.message };
    }

    const tracked =
      user.machine_name_1 === machineName ||
      user.machine_name_2 === machineName ||
      user.machine_name_3 === machineName;

    return { tracked };
  } catch (error) {
    return { tracked: false, error: error.message };
  }
}

/**
 * 从 tasks 表中提取任务设置（完全按照数据库中的设置）
 * @param {object} task - 任务对象（从 Supabase tasks 表查询的结果）
 * @returns {object} 任务设置
 */
export function extractTaskSettings(task) {
  if (!task) {
    throw new Error('Task object is required');
  }

  // 完全按照数据库中的设置，不使用默认值
  // 如果数据库字段为 null 或 undefined，则抛出错误，因为这些都是必填字段
  const settings = {
    threads: task.thread,
    worker: task.worker,
    timeout: task.timeout
  };

  // 验证必填字段
  if (settings.threads === null || settings.threads === undefined) {
    throw new Error('Task thread is required');
  }
  if (settings.worker === null || settings.worker === undefined) {
    throw new Error('Task worker is required');
  }
  if (!settings.timeout || settings.timeout === null || settings.timeout === undefined) {
    throw new Error('Task timeout is required');
  }

  // 确保数值类型正确
  settings.threads = parseInt(settings.threads, 10);
  settings.worker = parseInt(settings.worker, 10);

  if (isNaN(settings.threads) || settings.threads < 1) {
    throw new Error(`Invalid thread value: ${task.thread}`);
  }
  if (isNaN(settings.worker) || settings.worker < 1) {
    throw new Error(`Invalid worker value: ${task.worker}`);
  }

  return settings;
}

/**
 * 写入或更新 task_url 表中的记录
 * @param {string} userId - 用户ID
 * @param {string} taskId - 任务ID
 * @param {Array<object>} urlResults - URL结果数组，每个元素包含 {domain, waf, database, rows, status, progress}
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function upsertTaskUrlResults(userId, taskId, urlResults) {
  try {
    if (!userId || !taskId || !Array.isArray(urlResults)) {
      return { success: false, error: 'Invalid parameters' };
    }

    // 验证任务属于该用户
    const { data: task, error: taskError } = await supabase
      .from('tasks')
      .select('id, user_id')
      .eq('id', taskId)
      .eq('user_id', userId)
      .maybeSingle();

    if (taskError || !task) {
      return { success: false, error: 'Task not found or access denied' };
    }

    // 对每个结果进行 upsert（先查询是否存在，然后更新或插入）
    // 只写入在线网站的结果（status 不为 "offline"）
    for (const result of urlResults) {
      const domain = result.domain || null;
      const status = result.status || null;
      
      // 跳过离线网站，不写入数据库
      if (status === 'offline') {
        continue;
      }
      
      // 查询是否存在相同的 task_id + domains 记录
      const { data: existing, error: queryError } = await supabase
        .from('task_url')
        .select('id')
        .eq('task_id', taskId)
        .eq('domains', domain)
        .maybeSingle();

      const recordData = {
        task_id: taskId,
        domains: domain,
        waf: result.waf || null,
        database: result.database || null,
        rows: result.rows || null,
        status: status, // 保存状态（completed, failed 等）
        progress: result.progress || 0,
        updated_at: new Date().toISOString()
      };

      if (queryError && queryError.code !== 'PGRST116') {
        console.error('Error querying task_url:', queryError);
        continue;
      }

      if (existing) {
        // 更新现有记录
        const { error: updateError } = await supabase
          .from('task_url')
          .update(recordData)
          .eq('id', existing.id);

        if (updateError) {
          console.error('Error updating task_url:', updateError);
        }
      } else {
        // 插入新记录
        const { error: insertError } = await supabase
          .from('task_url')
          .insert(recordData);

        if (insertError) {
          console.error('Error inserting task_url:', insertError);
        }
      }
    }

    // 只更新 task_url 表，不更新 tasks 表的恢复信息
    // 恢复信息（current_lines 和 total_url_lines）会在每30秒的进度请求时更新

    return { success: true };
  } catch (error) {
    console.error('Error in upsertTaskUrlResults:', error);
    return { success: false, error: error.message };
  }
}

export default supabase;
