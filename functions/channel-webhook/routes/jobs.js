import { Router } from "express";
import { requireAdminFactory } from "../middlewares/adminAuth.js";

export default function jobsRouter({ supabase }) {
  const router = Router();
  const requireAdmin = requireAdminFactory();

  function requireSupabase(req, res, next) {
    if (!supabase) return res.status(503).json({ error: "SUPABASE_NOT_CONFIGURED" });
    next();
  }

  router.get("/", requireAdmin, requireSupabase, async (req, res) => { /* 그대로 */ });
  router.get("/:chatId", requireAdmin, requireSupabase, async (req, res) => { /* 그대로 */ });
  router.patch("/:chatId/ops_status", requireAdmin, requireSupabase, async (req, res) => { /* 그대로 */ });

  return router;
}
