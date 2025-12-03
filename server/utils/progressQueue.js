// 任务进度更新队列系统
// 用于缓冲和批量处理大量任务进度更新，避免数据库压力过大

/**
 * 进度更新队列项
 * @typedef {Object} ProgressQueueItem
 * @property {string} taskId - 任务ID
 * @property {string} userId - 用户ID
 * @property {Array} urlResults - URL结果数组
 * @property {number} progress - 总体进度
 * @property {boolean} isPeriodicUpdate - 是否是定期更新
 * @property {number} timestamp - 时间戳
 */

// 进度更新队列：Map<taskId, ProgressQueueItem>
const progressQueue = new Map();

// 队列处理状态
let isProcessing = false;
let processingInterval = null;

// 配置
const QUEUE_PROCESS_INTERVAL_MS = 5000; // 每5秒处理一次队列（优化：提高处理能力）
const MAX_QUEUE_SIZE = 50000; // 最大队列大小（优化：支持更多并发任务）
const BATCH_SIZE = 200; // 每次批量处理的任务数量（优化：提高吞吐量）

/**
 * 添加进度更新到队列
 * @param {string} taskId - 任务ID
 * @param {string} userId - 用户ID
 * @param {Array} urlResults - URL结果数组
 * @param {number} progress - 总体进度
 * @param {boolean} isPeriodicUpdate - 是否是定期更新
 */
export function enqueueProgressUpdate(taskId, userId, urlResults, progress, isPeriodicUpdate = false) {
  if (!taskId || !userId) {
    return;
  }

  // 如果队列过大，丢弃最旧的项目
  if (progressQueue.size >= MAX_QUEUE_SIZE) {
    const oldestKey = progressQueue.keys().next().value;
    progressQueue.delete(oldestKey);
    console.warn(`[progressQueue] Queue full, dropped oldest item: ${oldestKey}`);
  }

  // 更新或添加队列项（合并相同任务的更新）
  const existing = progressQueue.get(taskId);
  if (existing && !isPeriodicUpdate) {
    // 合并URL结果（保留最新的）
    const mergedResults = [...existing.urlResults, ...urlResults];
    // 去重（基于domain）
    const uniqueResults = new Map();
    mergedResults.forEach(result => {
      const domain = result.domain || result.domains;
      if (domain) {
        uniqueResults.set(domain, result);
      }
    });
    
    progressQueue.set(taskId, {
      taskId,
      userId,
      urlResults: Array.from(uniqueResults.values()),
      progress: progress || existing.progress,
      isPeriodicUpdate: existing.isPeriodicUpdate || isPeriodicUpdate,
      timestamp: Date.now()
    });
  } else {
    progressQueue.set(taskId, {
      taskId,
      userId,
      urlResults,
      progress,
      isPeriodicUpdate,
      timestamp: Date.now()
    });
  }
}

/**
 * 处理队列中的进度更新
 */
async function processQueue() {
  if (isProcessing || progressQueue.size === 0) {
    return;
  }

  isProcessing = true;

  try {
    // 获取一批任务进行处理
    const batch = [];
    const now = Date.now();
    const MAX_AGE_MS = 10000; // 最多保留10秒

    // 优先处理较旧的任务，避免新任务覆盖旧任务
    const sortedEntries = Array.from(progressQueue.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);

    for (const [taskId, item] of sortedEntries) {
      // 跳过太旧的项目（可能已经过期）
      if (now - item.timestamp > MAX_AGE_MS) {
        progressQueue.delete(taskId);
        continue;
      }

      batch.push(item);
      if (batch.length >= BATCH_SIZE) {
        break;
      }
    }

    if (batch.length === 0) {
      isProcessing = false;
      return;
    }

    // 批量处理
    const supabaseModule = await import('../supabase.js');
    const { upsertTaskUrlResults, updateTaskProgress } = supabaseModule;
    const supabase = supabaseModule.default;
    
    const processPromises = batch.map(async (item) => {
      try {
        // 更新 task_url 表
        const result = await upsertTaskUrlResults(item.userId, item.taskId, item.urlResults);
        
        if (!result.success) {
          console.error(`[progressQueue] Failed to update task_url for task ${item.taskId}:`, result.error);
          return;
        }

        // 如果是定期更新，更新恢复信息
        if (item.isPeriodicUpdate && item.urlResults.length > 0) {
          const completedCount = item.urlResults.filter(r => 
            r.status === 'completed' || r.status === 'failed'
          ).length;
          
          // 查询总域名数量（从 tasks 表的 total_url_lines 获取）
          const { data: taskData } = await supabase
            .from('tasks')
            .select('total_url_lines')
            .eq('id', item.taskId)
            .maybeSingle();
          
          const totalCount = taskData?.total_url_lines || item.urlResults.length;
          
          await updateTaskProgress(
            item.userId,
            item.taskId,
            item.progress,
            undefined,
            completedCount,
            totalCount
          );
        }

        // 从队列中移除已处理的项目
        progressQueue.delete(item.taskId);
      } catch (error) {
        console.error(`[progressQueue] Error processing task ${item.taskId}:`, error);
        // 如果处理失败，保留在队列中以便重试
      }
    });

    await Promise.allSettled(processPromises);
    
    // 减少日志输出：只在批量处理多个任务或队列积压时输出
    // 单个任务的实时更新（每5秒）不需要每次都输出日志
    if (batch.length > 1 || (batch.length > 0 && progressQueue.size > 5)) {
      console.log(`[progressQueue] Processed ${batch.length} tasks, ${progressQueue.size} remaining in queue`);
    }
  } catch (error) {
    console.error('[progressQueue] Error processing queue:', error);
  } finally {
    isProcessing = false;
  }
}

/**
 * 启动队列处理器
 */
export function startProgressQueueProcessor() {
  if (processingInterval) {
    return; // 已经启动
  }

  console.log(`[progressQueue] Starting progress queue processor (interval: ${QUEUE_PROCESS_INTERVAL_MS}ms)`);
  
  processingInterval = setInterval(() => {
    processQueue().catch(error => {
      console.error('[progressQueue] Error in queue processor:', error);
    });
  }, QUEUE_PROCESS_INTERVAL_MS);
}

/**
 * 停止队列处理器
 */
export function stopProgressQueueProcessor() {
  if (processingInterval) {
    clearInterval(processingInterval);
    processingInterval = null;
    console.log('[progressQueue] Stopped progress queue processor');
  }
}

/**
 * 获取队列状态
 */
export function getQueueStatus() {
  return {
    size: progressQueue.size,
    isProcessing,
    maxSize: MAX_QUEUE_SIZE
  };
}

/**
 * 清空队列（用于测试或紧急情况）
 */
export function clearQueue() {
  progressQueue.clear();
  console.log('[progressQueue] Queue cleared');
}

