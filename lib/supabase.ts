import { createClient } from '@supabase/supabase-js';

// 느낌표(!)는 "이 변수는 무조건 있어! 걱정 마!" 라는 뜻입니다.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseKey);
