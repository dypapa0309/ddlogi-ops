// functions/channel-webhook/middlewares/adminAuth.js
// JWT auth middleware: validates access token with Supabase Auth server,
// then checks profiles.role for authorization.

export function requireRoleJwtFactory({ supabase, allowRoles = [] }) {
  return async function requireRoleJwt(req, res, next) {
    try {
      if (!supabase) return res.status(503).json({ error: "SUPABASE_NOT_CONFIGURED" });

      const h = String(req.headers.authorization || "");
      const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
      if (!token) return res.status(401).json({ error: "NO_AUTH_TOKEN" });

      const { data: userData, error: userErr } = await supabase.auth.getUser(token);
      if (userErr || !userData?.user?.id) {
        return res.status(401).json({ error: "INVALID_SESSION", detail: userErr?.message || null });
      }

      const userId = userData.user.id;

      const { data: prof, error: profErr } = await supabase
        .from("profiles")
        .select("role, name")
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
      req.name = prof?.name || null;

      next();
    } catch (e) {
      return res.status(500).json({ error: "AUTH_ERROR", detail: e?.message || String(e) });
    }
  };
}
