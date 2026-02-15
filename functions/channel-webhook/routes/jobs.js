// functions/channel-webhook/routes/jobs.js (ESM)
import { Router } from "express";

export default function jobsRouter({ supabase, adminToken }) {
  const router = Router();

  function requireSupabase(req, res, next) {
    if (!supabase) return res.status(503).json({ error: "SUPABASE_NOT_CONFIGURED" });
    next();
  }

  // ✅ ADMIN 인증:
  // 1) (옵션) 레거시: Bearer 토큰이 adminToken과 같으면 통과
  // 2) Supabase 세션 JWT면: supabase.auth.getUser(jwt)로 유저 확인 → profiles.role=admin 확인
  async function requireAdmin(req, res, next) {
    try {
      const h = String(req.headers.authorization || "");
      const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";

      if (!token) return res.status(401).json({ error: "Unauthorized" });

      // 1) 레거시 토큰 병행 (원하면 유지)
      if (adminToken && token === adminToken) return next();

      // 2) Supabase JWT 검증
      // ⚠️ 이 supabase 클라이언트는 서버에서 생성된 서비스키 권한이어야 안정적임
      const { data: userData, error: userErr } = await supabase.auth.getUser(token);
      if (userErr || !userData?.user?.id) {
        return res.status(401).json({ error: "InvalidSessionToken" });
      }

      const userId = userData.user.id;

      // profiles.role 체크
      const { data: profile, error: profErr } = await supabase
        .from("profiles")
        .select("role")
        .eq("user_id", userId)
        .single();

      if (profErr || !profile) {
        return res.status(403).json({ error: "ProfileNotFound" });
      }
      if (profile.role !== "admin") {
        return res.status(403).json({ error: "AdminOnly" });
      }

      req.adminUserId = userId;
      next();
    } catch (e) {
      return res.status(500).json({ error: String(e?.message || e) });
    }
  }

  // 목록
  router.get("/", requireAdmin, requireSupabase, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
      const status = req.query.status ? String(req.query.status) : null;

      let q = supabase
        .from("jobs")
        .select(
          "id, chat_id, status, status_reason, confirmed_at, customer_name, customer_phone, from_address, to_address, quote_amount, deposit_amount, balance_amount, created_at, updated_at"
        )
        .order("updated_at", { ascending: false })
        .limit(limit);

      if (status) q = q.eq("status", status);

      const { data, error } = await q;
      if (error) throw error;

      return res.json({ ok: true, count: (data || []).length, data: data || [] });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // 단건
  router.get("/:chatId", requireAdmin, requireSupabase, async (req, res) => {
    try {
      const chatId = String(req.params.chatId || "").trim();
      if (!chatId) return res.status(400).json({ error: "chatId required" });

      const { data, error } = await supabase
        .from("jobs")
        .select("*")
        .eq("chat_id", chatId)
        .maybeSingle();

      if (error) throw error;
      if (!data) return res.status(404).json({ error: "Not found" });

      return res.json({ ok: true, data });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  return router;
}
