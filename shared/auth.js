// /shared/auth.js
// ✅ Supabase Auth + profiles.role 기반 권한 체크
(() => {
  const supabase = window.DDLOGI_SUPABASE;

  function assertSupabase() {
    if (!supabase) throw new Error("DDLOGI_SUPABASE_NOT_READY (supabase-client.js 로드/설정 확인)");
  }

  async function getSession() {
    assertSupabase();
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    return data.session || null;
  }

  async function signInWithPassword(email, password) {
    assertSupabase();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.session || null;
  }

  async function signOut() {
    assertSupabase();
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    return true;
  }

  async function getMyRole() {
    assertSupabase();
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
    // ✅ 세션 없으면 null
    const session = await getSession();
    if (!session) return null;

    const role = await getMyRole();
    if (!role) return null;

    if (requiredRole && role !== requiredRole) return null;

    return { session, role };
  }

  window.DDLOGI_AUTH = {
    getSession,
    signInWithPassword,
    signOut,
    getMyRole,
    requireRole,
  };

  console.log("✅ DDLOGI_AUTH ready");
})();
