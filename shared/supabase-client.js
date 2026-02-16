// /shared/supabase-client.js
(() => {
  const CFG = window.DDLOGI_CONFIG || {};
  const url = CFG.supabaseUrl;
  const key = CFG.supabaseKey;

  console.log("[DDLOGI] supabaseUrl:", url);
  console.log("[DDLOGI] supabaseKey prefix/len:", String(key).slice(0, 10), String(key).length);

  if (!url || !key) {
    console.error("[DDLOGI] Missing supabaseUrl/supabaseKey. config.js not loaded?");
    return;
  }
  if (!window.supabase?.createClient) {
    console.error("[DDLOGI] supabase-js not loaded.");
    return;
  }

  if (!window.__DDLOGI_SUPABASE__) {
    window.__DDLOGI_SUPABASE__ = window.supabase.createClient(url, key, {
      auth: {
        storageKey: "ddlogi_auth_v1",
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  }

  window.DDLOGI_SUPABASE = window.__DDLOGI_SUPABASE__;
})();
