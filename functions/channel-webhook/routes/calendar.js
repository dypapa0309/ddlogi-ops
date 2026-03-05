// functions/channel-webhook/routes/calendar.js
import { Router } from "express";
import { requireRoleJwtFactory } from "../middlewares/adminAuth.js";

function toKstStart(dateStr) {
  return `${dateStr}T00:00:00+09:00`;
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00+09:00`);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
}

export default function calendarRouter({ supabase }) {
  const router = Router();
  const requireAny = requireRoleJwtFactory({ supabase, allowRoles: ["admin", "driver"] });

  router.get("/", requireAny, async (req, res) => {
    try {
      const from = String(req.query.from || "").trim(); // YYYY-MM-DD
      const to = String(req.query.to || "").trim(); // YYYY-MM-DD
      const status = String(req.query.status || "").trim();

      if (!from || !to) return res.status(400).json({ error: "FROM_TO_REQUIRED" });

      const toPlus = addDays(to, 1);

      let q = supabase
        .from("job_events")
        .select("id, chat_id, start_at, end_at, status, title, assigned_driver_id")
        .gte("start_at", toKstStart(from))
        .lt("start_at", toKstStart(toPlus))
        .order("start_at", { ascending: true });

      if (status) q = q.eq("status", status);
      if (req.role === "driver") q = q.eq("assigned_driver_id", req.user_id);

      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });

      return res.json({ data: data || [] });
    } catch (e) {
      return res.status(500).json({ error: e?.message || String(e) });
    }
  });

  return router;
}
