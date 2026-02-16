(() => {
  function getSupabase() {
    const sb = window.DDLOGI_SUPABASE;
    if (!sb) throw new Error("DDLOGI_SUPABASE_NOT_READY: supabase-client.js 먼저 로드돼야 함");
    return sb;
  }

  async function signInWithPassword(email, password) {
    const supabase = getSupabase();
    return await supabase.auth.signInWithPassword({ email, password });
  }

  async function signOut() {
    const supabase = getSupabase();
    return await supabase.auth.signOut();
  }

  async function getSession() {
    const supabase = getSupabase();
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    return data.session || null;
  }

  // 필요 함수만 노출
  window.DDLOGI_AUTH = { signInWithPassword, signOut, getSession };
})();
