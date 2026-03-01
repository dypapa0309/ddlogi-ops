// /shared/auth.js
(() => {
  const supabase = window.DDLOGI_SUPABASE;

  function assertSupabase() {
    if (!supabase) throw new Error("DDLOGI_SUPABASE_NOT_READY");
  }

  async function getSession() {
    assertSupabase();
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    return data.session || null;
  }

  async function getAccessToken() {
    const s = await getSession();
    return s?.access_token || null;
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

  async function getMyProfile(session) {
    assertSupabase();
    const s = session || (await getSession());
    if (!s?.user?.id) return null;

    const { data, error } = await supabase
      .from("profiles")
      .select("role, name")   // 🔥 display_name → name 으로 변경
      .eq("user_id", s.user.id)
      .maybeSingle();

    if (error) throw error;
    return data || null;
  }

  async function requireRole(requiredRole) {
    try {
      const session = await getSession();
      if (!session) return { ok: false, reason: "NO_SESSION" };

      const prof = await getMyProfile(session);
      const role = prof?.role || null;

      if (!role) return { ok: false, reason: "NO_PROFILE" };
      if (requiredRole && role !== requiredRole)
        return { ok: false, reason: "FORBIDDEN", role };

      return { ok: true, session, role, profile: prof };
    } catch (e) {
      return { ok: false, reason: "AUTH_ERROR", detail: e?.message || String(e) };
    }
  }

  window.DDLOGI_AUTH = {
    getSession,
    getAccessToken,
    signInWithPassword,
    signOut,
    getMyProfile,
    requireRole,
  };

  console.log("✅ DDLOGI_AUTH ready");
})();