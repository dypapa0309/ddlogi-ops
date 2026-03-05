// functions/channel-webhook/routes/drivers.js
import { Router } from "express";
import { requireRoleJwtFactory } from "../middlewares/adminAuth.js";

export default function driversRouter({ supabase }) {
  const router = Router();
  const requireAdmin = requireRoleJwtFactory({ supabase, allowRoles: ["admin"] });

  router.get("/", requireAdmin, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("user_id, role, name, phone, created_at")
        .eq("role", "driver")
        .order("name", { ascending: true });

      if (error) return res.status(500).json({ error: error.message });
      return res.json({ data: data || [] });
    } catch (e) {
      return res.status(500).json({ error: e?.message || String(e) });
    }
  });

  return router;
}
