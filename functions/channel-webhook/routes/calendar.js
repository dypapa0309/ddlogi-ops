// functions/channel-webhook/routes/calendar.js
import { Router } from "express";
import { requireRoleJwtFactory } from "../middlewares/adminAuth.js";

function toKstIso(dateStr, timeLabel) {
  const base = `${dateStr}T09:00:00+09:00`;
  if (!timeLabel) return base;
  const t = String(timeLabel).trim();

  const m1 = t.match(/^(\d{1,2}):(\d{2})$/);
  if (m1) {
    const hh = String(m1[1]).padStart(2, "0");
    const mm = String(m1[2]).padStart(2, "0");
    return `${dateStr}T${hh}:${mm}:00+09:00`;
  }

  const m2 = t.match(/^(오전|오후)\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?/);
  if (m2) {
    const ap = m2[1];
    let hh = Number(m2[2]);
    const mm = Number(m2[3] || 0);
    if (ap === "오후" && hh < 12) hh += 12;
    if (ap === "오전" && hh === 12) hh = 0;
    const H = String(hh).padStart(2, "0");
    const M = String(mm).padStart(2, "0");
    return `${dateStr}T${H}:${M}:00+09:00`;
  }

  const m3 = t.match(/^(\d{1,2})시$/);
  if (m3) return `${dateStr}T${String(m3[1]).padStart(2, "0")}:00:00+09:00`;
  return base;
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00+09:00`);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
}

function shortText(text, max = 10) {
  const s = String(text || "-").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function fmtMoney(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString("ko-KR") : "-";
}

export default function calendarRouter({ supabase }) {
  const router = Router();
  const requireAny = requireRoleJwtFactory({ supabase, allowRoles: ["admin", "driver"] });

  router.get("/", requireAny, async (req, res) => {
    try {
      const from = String(req.query.from || "").trim();
      const to = String(req.query.to || "").trim();
      const status = String(req.query.status || "").trim();

      if (!from || !to) return res.status(400).json({ error: "FROM_TO_REQUIRED" });

      const toPlus = addDays(to, 1);

      let q = supabase
        .from("jobs")
        .select("id, chat_id, status, ops_status, move_date, time_slot_label, from_address, to_address, customer_name, assigned_driver_id, quote_amount, deposit_amount, balance_amount")
        .gte("move_date", from)
        .lt("move_date", toPlus)
        .order("move_date", { ascending: true });

      if (status) q = q.eq("status", status);
      if (req.role === "driver") q = q.eq("assigned_driver_id", req.user_id);

      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });

      const events = (data || [])
        .filter((j) => !!j.move_date)
        .map((j) => {
          const startAt = toKstIso(String(j.move_date), j.time_slot_label);
          const start = new Date(startAt);
          const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
          const route = `${shortText(j.from_address)} → ${shortText(j.to_address)}`;
          const title = req.role === "driver"
            ? `${route} / 운임 ${fmtMoney(j.balance_amount)}원`
            : `${route} / 예약 ${fmtMoney(j.deposit_amount)} / 잔금 ${fmtMoney(j.balance_amount)}`;

          return {
            id: j.id,
            chat_id: j.chat_id,
            start_at: start.toISOString(),
            end_at: end.toISOString(),
            status: j.status,
            ops_status: j.ops_status,
            title,
            assigned_driver_id: j.assigned_driver_id || null,
          };
        });

      return res.json({ data: events });
    } catch (e) {
      return res.status(500).json({ error: e?.message || String(e) });
    }
  });

  return router;
}