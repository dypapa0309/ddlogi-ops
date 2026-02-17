// /shared/supabase-client.js
(() => {
  const CFG = window.DDLOGI_CONFIG || {};
  const url = CFG.supabaseUrl;
  const key = CFG.supabaseAnonKey;

  if (!window.supabase || typeof window.supabase.createClient !== "function") {
    console.error("❌ supabase-js CDN이 로드되지 않았습니다. index.html에 CDN 포함 확인");
    return;
  }

  if (!url || !key || String(key).includes("YOUR_")) {
    console.error("❌ config.js의 supabaseUrl / supabaseAnonKey가 설정되지 않았습니다.");
    return;
  }

  // ✅ 전역 1개만
  window.DDLOGI_SUPABASE = window.supabase.createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });

  console.log("✅ DDLOGI_SUPABASE ready");
})();
