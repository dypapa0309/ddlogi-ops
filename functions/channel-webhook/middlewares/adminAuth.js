// functions/channel-webhook/middlewares/adminAuth.js (ESM)
// ✅ 이름은 adminAuth.js 그대로 두되, 내부는 "JWT + role"로 통일
export function requireRoleJwtFactory({ supabase, allowRoles = [] }) {
  return async function requireRoleJwt(req, res, next) {
    try {
      if (!supabase) return res.status(503).json({ error: "SUPABASE_NOT_CONFIGURED" });

      const h = String(req.headers.authorization || "");
      const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
      if (!token) return res.status(401).json({ error: "NO_AUTH_TOKEN" });

      // ✅ Supabase 공식 권장: 서버에서 토큰 검증은 getUser(jwt) 사용 citeturn0search10
      const { data: userData, error: userErr } = await supabase.auth.getUser(token);
      if (userErr || !userData?.user?.id) {
        return res.status(401).json({ error: "INVALID_SESSION", detail: userErr?.message });
      }

      const userId = userData.user.id;

      const { data: prof, error: profErr } = await supabase
        .from("profiles")
        .select("role, display_name")
        .eq("user_id", userId)
        .maybeSingle();

      if (profErr) return res.status(500).json({ error: "PROFILE_LOOKUP_FAILED", detail: profErr.message });

      const role = prof?.role || null;

      if (allowRoles.length > 0 && !allowRoles.includes(role)) {
        return res.status(403).json({ error: "FORBIDDEN", role });
      }

      req.user = userData.user;
      req.user_id = userId;
      req.role = role;
      req.display_name = prof?.display_name || null;

      next();
    } catch (e) {
      return res.status(500).json({ error: "AUTH_ERROR", detail: e?.message || String(e) });
    }
  };
}
