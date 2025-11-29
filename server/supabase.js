import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing Supabase environment variables');
}

const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * 验证API Key是否存在于users表中
 * @param {string} apiKey - 要验证的API Key
 * @returns {Promise<{valid: boolean, userId?: string}>}
 */
export async function verifyApiKey(apiKey) {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, apikey')
      .eq('apikey', apiKey)
      .single();

    if (error) {
      console.error('Supabase query error:', error);
      return { valid: false };
    }

    if (data && data.apikey === apiKey) {
      return { valid: true, userId: data.id };
    }

    return { valid: false };
  } catch (error) {
    console.error('Error verifying API key:', error);
    return { valid: false };
  }
}

export default supabase;

