// functions/channel-webhook/routes/jobs.js
import express from "express";
import { adminAuth } from "../middlewares/adminAuth.js";

const ALLOWED_STATUS = new Set([
  "draft",
  "quoted",
  "pending_confirm",
  "confirmed",
  "canceled",
]);

// Supabase .or() 문자열 깨짐 방지(최소 방어)
// - 콤마(,), 괄호, 따옴표 등은 Supabase or 문법에 영향 줄 수 있음
function sanitizeForOrLike(input) {
  return String(input || "")
    .trim()
    .replace(/[,\(\)]/g, " ")  // or() 문법 깨는 문자 최소 제거
    .replace(/\s+/g, " ")
    .slice(0, 80);            // 과도한 길이 제한(DoS 방지)
}

export default function jobsRouter({ supabase }) {
  const router = express.Router();

  /*
    GET /jobs
    Query:
      - status (draft|quoted|pending_confirm|confirmed|canceled)
      - q (통합검색)
      - page (default 1)
      - limit (default 20, max 100)
      - from (YYYY-MM-DD)
      - to   (YYYY-MM-DD)
      - date_field (created_at|confirmed_at)  // ✅ 추가: 날짜 필터 기준 선택(기본 created_at)
  */
  router.get("/", adminAuth, async (req, res) => {
    try {
      const page = Math.max(parseInt(req.query.page || "1", 10), 1);
      const limitRaw = parseInt(req.query.limit || "20", 10);
      const limit = Math.min(Math.max(limitRaw, 1), 100);

      const fromIdx = (page - 1) * limit;
      const toIdx = fromIdx + limit - 1;

      const status = String(req.query.status || "").trim();
      const qRaw = String(req.query.q || "").trim();
      const from = String(req.query.from || "").trim();
      const to = String(req.query.to || "").trim();

      // ✅ 날짜 필터 기준 선택: 기본은 created_at(모든 상태에 공통)
      const dateField = String(req.query.date_field || "created_at").trim();
      const dateCol = dateField === "confirmed_at" ? "confirmed_at" : "created_at";

      // status 유효성 체크(빈 값은 허용)
      if (status && !ALLOWED_STATUS.has(status)) {
        return res.status(400).json({ error: "invalid status" });
      }

      let query = supabase
        .from("jobs")
        .select(
          `
          chat_id,
          status,
          status_reason,
          customer_name,
          customer_phone,
          from_address,
          to_address,
          quote_amount,
          deposit_amount,
          balance_amount,
          confirmed_at,
          created_at,
          raw_text
          `,
          { count: "exact" }
        );

      // 상태 필터
      if (status) query = query.eq("status", status);

      // 날짜 필터
      // - created_at: 전체 상태 공통 필터로 안정적
      // - confirmed_at: confirmed에서만 의미 있음(null 많음)
      if (from && to) {
        query = query
          .gte(dateCol, `${from}T00:00:00+09:00`)
          .lte(dateCol, `${to}T23:59:59+09:00`);
      } else if (from) {
        query = query.gte(dateCol, `${from}T00:00:00+09:00`);
      } else if (to) {
        query = query.lte(dateCol, `${to}T23:59:59+09:00`);
      }

      // 통합 검색
      if (qRaw) {
        const q = sanitizeForOrLike(qRaw);
        if (q) {
          const like = `%${q}%`;
          query = query.or(
            [
              `customer_name.ilike.${like}`,
              `customer_phone.ilike.${like}`,
              `from_address.ilike.${like}`,
              `to_address.ilike.${like}`,
              `raw_text.ilike.${like}`,
              `chat_id.ilike.${like}`,
            ].join(",")
          );
        }
      }

      // 정렬 (최신순)
      query = query.order("created_at", { ascending: false }).range(fromIdx, toIdx);

      const { data, error, count } = await query;

      if (error) {
        console.error("GET /jobs error:", error);
        return res.status(500).json({ error: "Database error" });
      }

      return res.json({
        page,
        limit,
        total: count || 0,
        items: data || [],
      });
    } catch (err) {
      console.error("GET /jobs exception:", err);
      return res.status(500).json({ error: "Server error" });
    }
  });

  /*
    GET /jobs/:chatId
  */
  router.get("/:chatId", adminAuth, async (req, res) => {
    try {
      const chatId = String(req.params.chatId || "").trim();
      if (!chatId) return res.status(400).json({ error: "chatId required" });

      const { data, error } = await supabase
        .from("jobs")
        .select("*")
        .eq("chat_id", chatId)
        .maybeSingle();

      if (error) {
        console.error("GET /jobs/:chatId error:", error);
        return res.status(500).json({ error: "Database error" });
      }

      if (!data) return res.status(404).json({ error: "Not found" });

      return res.json(data);
    } catch (err) {
      console.error("GET /jobs/:chatId exception:", err);
      return res.status(500).json({ error: "Server error" });
    }
  });

  return router;
}
