// /shared/auth.js
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

  async function getMyRole() {
    const supabase = getSupabase();
    const session = await getSession();
    if (!session?.user?.id) return null;

    const { data, error } = await supabase
      .from("profiles")
      .select("role")
      .eq("user_id", session.user.id)
      .maybeSingle();

    if (error) throw error;
    return data?.role || null;
  }

  async function requireRole(requiredRole) {
    const session = await getSession();
    if (!session) {
      location.href = "/apps/auth/";
      return null;
    }

    const role = await getMyRole();
    if (role !== requiredRole) {
      // 권한 없으면 auth로 보내거나 메시지
      location.href = "/apps/auth/?err=forbidden";
      return null;
    }

    return { session, role };
  }

  window.DDLOGI_AUTH = { signInWithPassword, signOut, getSession, getMyRole, requireRole };
})();
