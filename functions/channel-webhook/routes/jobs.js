// functions/channel-webhook/routes/jobs.js
import { Router } from "express";
import { requireRoleJwtFactory } from "../middlewares/adminAuth.js";

export default function jobsRouter({ supabase }) {
  const router = Router();

  const requireAdmin = requireRoleJwtFactory({ supabase, allowRoles: ["admin"] });
  const requireAdminOrDriver = requireRoleJwtFactory({ supabase, allowRoles: ["admin", "driver"] });
  // Separate middleware for driver-only routes
  const requireDriver = requireRoleJwtFactory({ supabase, allowRoles: ["driver"] });

  // Admin: list jobs
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

  // Admin/Driver: job detail (drivers only if assigned)
  router.get("/:chatId", requireAdminOrDriver, async (req, res) => {
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

      if (req.role === "driver" && data.assigned_driver_id !== req.user_id) {
        return res.status(403).json({ error: "FORBIDDEN_ASSIGNEE" });
      }

      return res.json({ data });
    } catch (e) {
      return res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Admin/Driver (assigned): update ops_status
  router.patch("/:chatId/ops_status", requireAdminOrDriver, async (req, res) => {
    try {
      const chatId = String(req.params.chatId || "").trim();
      const ops_status = String(req.body?.ops_status || "").trim();
      if (!chatId) return res.status(400).json({ error: "CHAT_ID_REQUIRED" });
      if (!ops_status) return res.status(400).json({ error: "OPS_STATUS_REQUIRED" });

      const { data: existing, error: exErr } = await supabase
        .from("jobs")
        .select("assigned_driver_id")
        .eq("chat_id", chatId)
        .maybeSingle();

      if (exErr) return res.status(500).json({ error: exErr.message });
      if (!existing) return res.status(404).json({ error: "NOT_FOUND" });

      if (req.role === "driver" && existing.assigned_driver_id !== req.user_id) {
        return res.status(403).json({ error: "FORBIDDEN_ASSIGNEE" });
      }

      const { data, error } = await supabase
        .from("jobs")
        .update({ ops_status })
        .eq("chat_id", chatId)
        .select("*")
        .maybeSingle();

      if (error) return res.status(500).json({ error: error.message });
      return res.json({ data });
    } catch (e) {
      return res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Admin: assign driver
  router.patch("/:chatId/assign_driver", requireAdmin, async (req, res) => {
    try {
      const chatId = String(req.params.chatId || "").trim();
      const driver_user_id = String(req.body?.driver_user_id || "").trim();

      if (!chatId) return res.status(400).json({ error: "CHAT_ID_REQUIRED" });
      if (!driver_user_id) return res.status(400).json({ error: "DRIVER_USER_ID_REQUIRED" });

      const { data, error } = await supabase
        .from("jobs")
        .update({ assigned_driver_id: driver_user_id })
        .eq("chat_id", chatId)
        .select("*")
        .maybeSingle();

      if (error) return res.status(500).json({ error: error.message });
      if (!data) return res.status(404).json({ error: "NOT_FOUND" });

      await supabase.from("job_events").update({ assigned_driver_id: driver_user_id }).eq("chat_id", chatId);

      return res.json({ data });
    } catch (e) {
      return res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // List open jobs (status=confirmed, ops_status=open)
  router.get("/open", requireAdminOrDriver, async (req, res) => {
    try {
      // Fetch jobs that are confirmed and currently open
      const { data, error } = await supabase
        .from("jobs")
        .select("*")
        .eq("status", "confirmed")
        .eq("ops_status", "open")
        .order("move_date", { ascending: true });
      if (error) return res.status(500).json({ error: error.message });
      let rows = data || [];
      // For drivers, mask sensitive information prior to pickup
      if (req.role === "driver") {
        rows = rows.map((r) => ({
          ...r,
          phone: null,
          customer_name: null
        }));
      }
      return res.json({ data: rows });
    } catch (e) {
      return res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Driver: pick up a job (self-assign)
  router.post("/:chatId/pick", requireDriver, async (req, res) => {
    try {
      const chatId = String(req.params.chatId || "").trim();
      if (!chatId) return res.status(400).json({ error: "CHAT_ID_REQUIRED" });
      // Retrieve the job information
      const { data: job, error: jobErr } = await supabase
        .from("jobs")
        .select("id,status,ops_status,assigned_driver_id")
        .eq("chat_id", chatId)
        .maybeSingle();
      if (jobErr) return res.status(500).json({ error: jobErr.message });
      if (!job) return res.status(404).json({ error: "NOT_FOUND" });
      // Job must be confirmed and open to be picked
      if (job.status !== "confirmed" || job.ops_status !== "open") {
        return res.status(400).json({ error: "NOT_OPEN" });
      }
      // Attempt to create an assignment row; rely on DB unique constraint for race conditions
      const ins = await supabase.from("driver_assignments").insert({
        job_id: job.id,
        driver_id: req.user_id,
        status: "picked",
        source: "self_pick"
      }).select();
      if (ins.error) {
        const msg = String(ins.error.message || "").toLowerCase();
        if (msg.includes("duplicate") || msg.includes("unique")) {
          return res.status(400).json({ error: "ALREADY_PICKED" });
        }
        return res.status(500).json({ error: ins.error.message });
      }
      // Update the job to reflect the new assignment and status
      const upd = await supabase
        .from("jobs")
        .update({ assigned_driver_id: req.user_id, ops_status: "assigned" })
        .eq("id", job.id);
      if (upd.error) {
        return res.status(500).json({ error: upd.error.message });
      }
      // Log the event
      await supabase.from("job_events").insert({
        job_id: job.id,
        event_type: "driver_picked",
        payload: { actor: req.user_id }
      });
      return res.json({ data: { picked: true } });
    } catch (e) {
      return res.status(500).json({ error: e?.message || String(e) });
    }
  });

  return router;
}