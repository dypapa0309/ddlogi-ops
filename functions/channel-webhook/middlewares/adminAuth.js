// /functions/channel-webhook/middlewares/adminAuth.js (ESM)
export function requireAdminJwtFactory({ supabase }) {
  return async function requireAdminJwt(req, res, next) {
    try {
      if (!supabase) return res.status(503).json({ error: "SUPABASE_NOT_CONFIGURED" });

      const h = String(req.headers.authorization || "");
      const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";

      if (!token) return res.status(401).json({ error: "NO_AUTH_TOKEN" });

      // ✅ 1) JWT 유효성 검증 (만료/위조면 여기서 걸림)
      const { data: userData, error: userErr } = await supabase.auth.getUser(token);
      if (userErr || !userData?.user?.id) {
        return res.status(401).json({ error: "INVALID_SESSION", detail: userErr?.message });
      }

      const userId = userData.user.id;

      // ✅ 2) role 확인 (service_role이므로 RLS 영향 없음)
      const { data: prof, error: profErr } = await supabase
        .from("profiles")
        .select("role")
        .eq("user_id", userId)
        .maybeSingle();

      if (profErr) return res.status(500).json({ error: "PROFILE_LOOKUP_FAILED", detail: profErr.message });

      const role = prof?.role || null;
      if (role !== "admin") return res.status(403).json({ error: "FORBIDDEN", role });

      // ✅ 통과
      req.user = userData.user;
      req.user_id = userId;
      req.role = role;

      next();
    } catch (e) {
      return res.status(500).json({ error: "ADMIN_AUTH_ERROR", detail: e?.message || String(e) });
    }
  };
}
