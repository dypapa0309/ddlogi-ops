// functions/channel-webhook/routes/jobs.js (ESM)
import { Router } from "express";
import { requireAdmin } from "../middlewares/adminAuth.js";

export default function jobsRouter({ supabase }) {
  const router = Router();

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
          "id, chat_id, status, status_reason, ops_status, confirmed_at, customer_name, customer_phone, from_address, to_address, quote_amount, deposit_amount, balance_amount, created_at, updated_at"
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
      if (!chatId) return res.status(400).json({ ok: false, error: "chatId required" });

      const { data, error } = await supabase
        .from("jobs")
        .select("*")
        .eq("chat_id", chatId)
        .maybeSingle();

      if (error) throw error;
      if (!data) return res.status(404).json({ ok: false, error: "Not found" });

      return res.json({ ok: true, data });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // (선택) ops_status 변경 API — webhook와 완전 분리
  // PATCH /jobs/:chatId/ops_status  { ops_status: "assigned" | "completed" | ... }
  router.patch("/:chatId/ops_status", requireAdmin, requireSupabase, async (req, res) => {
    try {
      const chatId = String(req.params.chatId || "").trim();
      const ops_status = String(req.body?.ops_status || "").trim();

      if (!chatId) return res.status(400).json({ ok: false, error: "chatId required" });
      if (!ops_status) return res.status(400).json({ ok: false, error: "ops_status required" });

      // 허용값 화이트리스트
      const ALLOWED = new Set([
        "unassigned",
        "assigned",
        "in_transit",
        "completed",
        "settled",
        "closed",
        "canceled",
      ]);
      if (!ALLOWED.has(ops_status)) {
        return res.status(400).json({ ok: false, error: "Invalid ops_status" });
      }

      const { data, error } = await supabase
        .from("jobs")
        .update({ ops_status, updated_at: new Date().toISOString() })
        .eq("chat_id", chatId)
        .select("*")
        .maybeSingle();

      if (error) throw error;
      if (!data) return res.status(404).json({ ok: false, error: "Not found" });

      return res.json({ ok: true, data });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  return router;
}
