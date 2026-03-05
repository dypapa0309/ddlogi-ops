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
      // 캘린더는 jobs 테이블의 scheduled_at을 기준으로 일정 정보를 생성한다.
      // scheduled_at 컬럼은 KST 기준 ISO 문자열로 저장되며, from/to 범위는 날짜 문자열(YYYY-MM-DD)로 전달된다.
      const fromStart = toKstStart(from);
      const toStart = toKstStart(toPlus);
      let q = supabase
        .from("jobs")
        .select("id, chat_id, scheduled_at, status, assigned_driver_id, customer_name, from_address, to_address")
        .gte("scheduled_at", fromStart)
        .lt("scheduled_at", toStart);
      if (status) q = q.eq("status", status);
      if (req.role === "driver") q = q.eq("assigned_driver_id", req.user_id);
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      const rows = data || [];
      // 일정은 2시간 단위로 가정한다. title은 고객 이름과 출발지→도착지 요약.
      const events = rows.map((job) => {
        const startAt = job.scheduled_at;
        const endAt = (() => {
          try {
            const d = new Date(startAt);
            const endD = new Date(d.getTime() + 2 * 60 * 60 * 1000);
            return endD.toISOString();
          } catch {
            return null;
          }
        })();
        const title = `${job.customer_name || "고객"} | ${String(job.from_address || "-").slice(0, 18)} → ${String(job.to_address || "-").slice(0, 18)}`;
        return {
          id: job.id,
          chat_id: job.chat_id,
          start_at: startAt,
          end_at: endAt,
          status: job.status,
          title,
          assigned_driver_id: job.assigned_driver_id,
        };
      });
      return res.json({ data: events });
    } catch (e) {
      return res.status(500).json({ error: e?.message || String(e) });
    }
  });

  return router;
}