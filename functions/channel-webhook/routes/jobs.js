// functions/channel-webhook/routes/jobs.js (ESM)
import { Router } from "express";

export default function jobsRouter({ supabase, adminToken }) {
  const router = Router();

  function requireAdmin(req, res, next) {
    const h = String(req.headers.authorization || "");
    const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";

    if (!adminToken) {
      return res.status(500).json({ error: "ADMIN_API_TOKEN_MISSING" });
    }
    if (!token || token !== adminToken) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  }

  function requireSupabase(req, res, next) {
    if (!supabase) return res.status(503).json({ error: "SUPABASE_NOT_CONFIGURED" });
    next();
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
