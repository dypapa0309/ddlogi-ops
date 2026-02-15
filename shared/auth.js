// apps/shared/auth.js
(() => {
  const CFG = window.DDLOGI_CONFIG || {};
  const supabase = window.supabase?.createClient?.(CFG.supabaseUrl, CFG.supabaseKey);

  async function getSession() {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    return data.session || null;
  }

  async function getMyRole() {
    const session = await getSession();
    if (!session?.user?.id) return null;

    const { data, error } = await supabase
      .from("profiles")
      .select("role")
      .eq("user_id", session.user.id)
      .single();

    if (error) throw error;
    return data?.role || null;
  }

  async function requireRole(requiredRole) {
    const session = await getSession();
    if (!session) {
      location.href = "/apps/auth/";
      return;
    }

    const role = await getMyRole();
    if (!role) {
      await supabase.auth.signOut();
      location.href = "/apps/auth/";
      return;
    }

    if (requiredRole && role !== requiredRole) {
      // 권한 다르면 역할에 맞는 홈으로 보내기
      location.href = role === "admin" ? "/apps/admin/" : "/apps/driver/";
      return;
    }
    return { session, role, supabase };
  }

  async function signOut() {
    await supabase.auth.signOut();
    location.href = "/apps/auth/";
  }

  window.DDLOGI_AUTH = { supabase, getSession, getMyRole, requireRole, signOut };
})();
