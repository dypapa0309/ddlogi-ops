// /shared/supabase-client.js
(() => {
  const CFG = window.DDLOGI_CONFIG || {};
  const url = CFG.supabaseUrl;
  const key = CFG.supabaseAnonKey;

  if (!window.supabase || typeof window.supabase.createClient !== "function") {
    console.error("❌ supabase-js CDN not loaded");
    return;
  }

  if (!url || !key) {
    console.error("❌ config.js missing supabaseUrl / supabaseAnonKey");
    return;
  }

  window.DDLOGI_SUPABASE = window.supabase.createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });

  console.log("✅ DDLOGI_SUPABASE ready");
})();
