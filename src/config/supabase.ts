import { createClient } from "@supabase/supabase-js";
import { config } from "./env";

// Service role client — bypasses RLS (RLS is disabled per requirements)
export const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey);
