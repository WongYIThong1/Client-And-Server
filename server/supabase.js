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
    // 清理API Key（去除首尾空格）
    const cleanApiKey = apiKey ? apiKey.trim() : '';
    
    if (!cleanApiKey) {
      console.log('API Key is empty');
      return { valid: false };
    }

    console.log(`Verifying API Key (length: ${cleanApiKey.length})`);

    // 问题：.eq() 查询返回了错误的行，所以获取所有用户然后在代码中精确匹配
    const { data, error } = await supabase
      .from('users')
      .select('id, apikey');

    if (error) {
      console.error('Supabase query error:', JSON.stringify(error, null, 2));
      return { valid: false };
    }

    console.log(`Query result: Found ${data ? data.length : 0} total user(s)`);

    // 在代码中进行精确匹配（因为Supabase的.eq()可能有问题）
    if (data && data.length > 0) {
      for (const row of data) {
        const dbApiKey = row.apikey ? row.apikey.trim() : '';
        
        // 精确匹配
        if (dbApiKey === cleanApiKey) {
          console.log(`API Key verified successfully for user: ${row.id}`);
          return { valid: true, userId: row.id };
        }
      }
      
      console.log('API Key mismatch - no matching key found after checking all users');
    } else {
      console.log('No users found in database');
    }

    return { valid: false };
  } catch (error) {
    console.error('Error verifying API key:', error);
    return { valid: false };
  }
}

export default supabase;

