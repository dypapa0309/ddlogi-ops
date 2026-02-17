// /functions/channel-webhook/routes/jobs.js (ESM)
import { Router } from "express";
import { requireAdminJwtFactory } from "../middlewares/adminAuth.js";

export default function jobsRouter({ supabase }) {
  const router = Router();
  const requireAdmin = requireAdminJwtFactory({ supabase });

  // 목록
  router.get("/", requireAdmin, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
      const status = String(req.query.status || "").trim();

      let q = supabase
        .from("jobs")
        .select("*", { count: "exact" })
        .order("updated_at", { ascending: false })
        .limit(limit);

      if (status) q = q.eq("status", status);

      const { data, count, error } = await q;
      if (error) return res.status(500).json({ error: error.message });

      return res.json({ count: count ?? (data?.length || 0), data: data || [] });
    } catch (e) {
      return res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // 단건
  router.get("/:chatId", requireAdmin, async (req, res) => {
    try {
      const chatId = String(req.params.chatId || "").trim();
      if (!chatId) return res.status(400).json({ error: "CHAT_ID_REQUIRED" });

      const { data, error } = await supabase
        .from("jobs")
        .select("*")
        .eq("chat_id", chatId)
        .maybeSingle();

      if (error) return res.status(500).json({ error: error.message });
      if (!data) return res.status(404).json({ error: "NOT_FOUND" });

      return res.json({ data });
    } catch (e) {
      return res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // (옵션) ops_status patch도 동일 requireAdmin으로 보호하면 됨
  router.patch("/:chatId/ops_status", requireAdmin, async (req, res) => {
    try {
      const chatId = String(req.params.chatId || "").trim();
      const ops_status = String(req.body?.ops_status || "").trim();
      if (!chatId) return res.status(400).json({ error: "CHAT_ID_REQUIRED" });
      if (!ops_status) return res.status(400).json({ error: "OPS_STATUS_REQUIRED" });

      const { data, error } = await supabase
        .from("jobs")
        .update({ ops_status, updated_at: new Date().toISOString() })
        .eq("chat_id", chatId)
        .select("*")
        .maybeSingle();

      if (error) return res.status(500).json({ error: error.message });
      return res.json({ data });
    } catch (e) {
      return res.status(500).json({ error: e?.message || String(e) });
    }
  });

  return router;
}
