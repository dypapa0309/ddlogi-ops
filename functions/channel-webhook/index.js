// functions/channel-webhook/index.js
import express from "express";
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

import jobsRouter from "./routes/jobs.js";
import calendarRouter from "./routes/calendar.js";
import driversRouter from "./routes/drivers.js";

/* =========================
   App
========================= */
const app = express();
app.use(express.json({ limit: "2mb", type: "*/*" }));

/* =========================
   Env
========================= */
const WEBHOOK_TOKEN = process.env.DDLOGI_WEBHOOK_TOKEN || "";
const ADMIN_ALLOWED_ORIGINS = String(process.env.ADMIN_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const IS_PROD = String(process.env.NODE_ENV || "").toLowerCase() === "production";

/* =========================
   Supabase (server-only)
========================= */
const hasSupabaseEnv = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = hasSupabaseEnv
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

if (!supabase) console.warn("⚠️ Missing env: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

/* =========================
   CORS
========================= */
function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (IS_PROD && ADMIN_ALLOWED_ORIGINS.length === 0) return false;
  if (!IS_PROD && ADMIN_ALLOWED_ORIGINS.length === 0) return true;
  return ADMIN_ALLOWED_ORIGINS.includes(origin);
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = origin && isAllowedOrigin(origin);

  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-DDLOGI-TOKEN");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
  }

  if (req.method === "OPTIONS") {
    if (allowed) return res.status(204).end();
    return res.status(403).json({ error: "CORS forbidden" });
  }

  next();
});

/* =========================
   Helpers
========================= */
function sha256(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function clampText(s, max = 1200) {
  const str = String(s || "");
  return str.length > max ? str.slice(0, max) + "…" : str;
}

// PII masking (conservative)
function maskPII(text) {
  let t = String(text || "");

  // phone
  t = t.replace(/01[016789][\s-]?\d{3,4}[\s-]?\d{4}/g, (m) => {
    const digits = m.replace(/[\s-]/g, "");
    if (digits.length === 11) return digits.slice(0, 3) + "****" + digits.slice(7);
    if (digits.length === 10) return digits.slice(0, 3) + "***" + digits.slice(6);
    return "01*********";
  });

  // email
  t = t.replace(/\b([A-Z0-9._%+-]{1,64})@([A-Z0-9.-]{1,255}\.[A-Z]{2,24})\b/gi, (m) => {
    const [u, d] = m.split("@");
    const uu = u.length <= 2 ? "*".repeat(u.length) : u.slice(0, 2) + "***";
    return `${uu}@${d}`;
  });

  // address (rough)
  t = t.replace(
    /\b(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)\s+([^\n]{0,30}?(구|군|시))\s+([^\n]{0,30}?(동|읍|면))([^\n]*)/g,
    (m, p1, p2, _g, p4) => `${p1} ${p2} ${p4} …`
  );

  return t;
}

/* =========================
   ChannelTalk payload parsing
========================= */
function pickText(payload) {
  const s =
    payload?.entity?.plainText ||
    payload?.entity?.text ||
    payload?.message?.plainText ||
    payload?.message?.text ||
    "";
  return typeof s === "string" ? s.trim() : "";
}

function extractMessageId(payload) {
  return payload?.entity?.id || payload?.message?.id || payload?.id || null;
}

function extractChatId(payload) {
  return (
    payload?.entity?.chatId ||
    payload?.entity?.chat?.id ||
    payload?.entity?.chat?.chatId ||
    payload?.refers?.userChat?.id ||
    payload?.refers?.chat?.id ||
    payload?.chatId ||
    payload?.chat_id ||
    null
  );
}

function debugChatIdSource(payload) {
  const candidates = [
    ["entity.chatId", payload?.entity?.chatId],
    ["entity.chat.id", payload?.entity?.chat?.id],
    ["entity.chat.chatId", payload?.entity?.chat?.chatId],
    ["refers.userChat.id", payload?.refers?.userChat?.id],
    ["refers.chat.id", payload?.refers?.chat?.id],
    ["chatId", payload?.chatId],
    ["chat_id", payload?.chat_id],
  ];
  const hit = candidates.find(([, v]) => !!v);
  return hit ? hit[0] : "NONE";
}

function extractUserId(payload) {
  return payload?.refers?.user?.id || payload?.entity?.personId || null;
}

function extractPersonType(payload) {
  return payload?.entity?.personType || null; // bot/manager/user
}

/* =========================
   Status helpers
========================= */
const QUOTE_MARKER = "DDLOGI_QUOTE_V1";

function isQuoteBlock(text) {
  const t = String(text || "");
  if (t.includes(QUOTE_MARKER)) return true;

  const legacy =
    t.includes("이사 방식") &&
    t.includes("차량") &&
    t.includes("일정") &&
    t.includes("출발지") &&
    t.includes("도착지") &&
    (t.includes("[예상금액]") || t.includes("예상금액"));

  if (legacy) return true;

  const naturalQuote =
    (t.includes("총 예상 금액") || t.includes("예상 금액")) &&
    (t.includes("예약금") || t.includes("20%")) &&
    (t.includes("잔금") || t.includes("80%")) &&
    (t.includes("그대로 진행") || t.includes("수정/추가") || t.includes("진행을 원하시면"));

  return naturalQuote;
}

function containsAny(text, keywords) {
  const t = String(text || "");
  return keywords.some((k) => t.includes(k));
}

function priority(status) {
  const map = { draft: 0, quoted: 1, pending_confirm: 2, confirmed: 3, canceled: 2 };
  return map[status] ?? 0;
}

function normalizePhone(text) {
  const m = String(text || "").match(/01[016789][\s-]?\d{3,4}[\s-]?\d{4}/);
  return m ? m[0].replace(/[\s-]/g, "") : null;
}

function extractName(text) {
  const m = String(text || "").match(/이름[:\s]*([가-힣]{2,4})/);
  return m ? m[1] : null;
}

function extractNameLoose(text) {
  const t = String(text || "").trim();
  const m = t.match(
    /^([가-힣]{2,4})\s*(?:님|입니다|이에요|요|입금|입금완료|입금 완료|송금|이체|완료|완료했|완료했습니다)\b/
  );
  return m ? m[1] : null;
}

function extractAddressLine(text, label) {
  const safe = String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${safe}[:\\s]*([^\\n]+)`, "m");
  const match = String(text || "").match(re);
  if (!match) return null;
  const addr = String(match[1] || "").trim();
  return addr.length >= 3 ? addr : null;
}

function extractFromToLoose(text) {
  const t = String(text || "");
  const from = t.match(/출발지\s*([^\n]+?)(?=\s*도착지|$)/);
  const to = t.match(/도착지\s*([^\n]+?)(?=\s*(연락처|전화|번호|$))/);
  return { from: from ? from[1].trim() : null, to: to ? to[1].trim() : null };
}

function extractMoney(text, label) {
  const safe = String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\[${safe}\\]\\s*₩?([0-9,]+)`, "i");
  const m = String(text || "").match(re);
  if (!m) return null;
  const n = parseInt(String(m[1]).replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function extractMoneyLoose(text, kind) {
  const t = String(text || "");
  const patterns = {
    quote: [
      /총\s*예상\s*금액[^\d]*([0-9]{1,3}(?:,[0-9]{3})+)\s*원/i,
      /예상\s*금액[^\d]*([0-9]{1,3}(?:,[0-9]{3})+)\s*원/i,
      /총\s*금액[^\d]*([0-9]{1,3}(?:,[0-9]{3})+)\s*원/i,
    ],
    deposit: [/예약금[^\d]*([0-9]{1,3}(?:,[0-9]{3})+)\s*원/i, /예약금\s*20%[^\d]*([0-9]{1,3}(?:,[0-9]{3})+)\s*원/i],
    balance: [/잔금[^\d]*([0-9]{1,3}(?:,[0-9]{3})+)\s*원/i, /잔금\s*80%[^\d]*([0-9]{1,3}(?:,[0-9]{3})+)\s*원/i],
  };

  const list = patterns[kind] || [];
  for (const re of list) {
    const m = t.match(re);
    if (m && m[1]) {
      const n = parseInt(String(m[1]).replace(/,/g, ""), 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function extractMoveDate(text) {
  const t = String(text || "");
  const m = t.match(/\b(20\d{2})[-.\/](\d{1,2})[-.\/](\d{1,2})\b/);
  if (!m) return null;
  const y = m[1];
  const mm = String(parseInt(m[2], 10)).padStart(2, "0");
  const dd = String(parseInt(m[3], 10)).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

function extractTimeLabel(text) {
  const t = String(text || "");
  const m1 = t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m1) return `${String(m1[1]).padStart(2, "0")}:${m1[2]}`;

  const m2 = t.match(/\b(오전|오후)\s*([0-9]{1,2})\s*시(?:\s*([0-9]{1,2})\s*분)?\b/);
  if (m2) {
    const ap = m2[1];
    let h = parseInt(m2[2], 10);
    const mi = m2[3] ? parseInt(m2[3], 10) : 0;
    if (ap === "오후" && h < 12) h += 12;
    if (ap === "오전" && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
  }

  if (t.includes("오전")) return "09:00";
  if (t.includes("오후")) return "13:00";
  return null;
}

function buildKstTimestamp(dateStr, timeHHMM) {
  if (!dateStr) return null;
  const time = timeHHMM || "09:00";
  return `${dateStr}T${time}:00+09:00`;
}

/* =========================
   DB helpers
========================= */
async function saveWebhookLogSafe({ messageId, inferredStatus, chatId, personType, userId, plainText }) {
  if (!supabase) return;

  const raw = String(plainText || "");
  const masked = maskPII(raw);

  const row = {
    provider: "channeltalk",
    event_type: "message",
    chat_id: chatId || null,
    message_id: messageId || null,
    chat_id_hash: chatId ? sha256(chatId) : null,
    message_id_hash: messageId ? sha256(messageId) : null,

    // IMPORTANT: these are the columns you were querying; must be populated
    person_type: personType || null,
    text: clampText(masked, 2000),

    preview: clampText(masked, personType === "bot" ? 2000 : 1200),
    inferred_status: inferredStatus || "draft",

    meta: {
      user_id: userId || null,
      text_len: raw.length,
      v: "SAFELOG_V4",
    },
  };

  const { error } = await supabase.from("webhook_logs").insert(row);
  if (error) {
    const msg = String(error.message || "").toLowerCase();
    if (msg.includes("duplicate") || msg.includes("unique")) return; // dedupe
    console.warn("⚠️ webhook_logs insert failed:", error.message);
  }
}

async function upsertJobAndEvent({ chatId, messageId, personType, text }) {
  if (!supabase || !chatId) return null;

  const cancelKeywords = ["취소", "취소할게", "취소하겠", "취소합니다", "예약 취소", "진행 취소"];
  const proceedKeywords = ["그대로 진행", "네 진행", "진행할게요", "진행하겠습니다", "확정", "예약", "진행 부탁", "부탁드립니다"];

  const depositStrong = ["입금완료", "입금 완료", "송금완료", "송금 완료", "이체완료", "이체 완료", "보냈어요", "보냈습니다", "송금했", "이체했", "입금 했", "입금했습니다"];
  const depositWeak = ["입금", "송금", "이체", "보낼게요", "입금할게요", "입금 예정", "송금 예정", "이체 예정"];
  const depositNeg = ["미입금", "입금 전", "입금전", "아직 입금", "아직 안", "안 했", "못했", "보류", "나중에 입금", "입금 못", "입금 안"];

  const isUser = personType === "user";
  const isBot = personType === "bot";
  const isRelevant = isUser || isBot; // prevent manager/internal notes from mutating customer/job facts

  const hasCancel = isUser && containsAny(text, cancelKeywords);
  const hasProceed = isUser && containsAny(text, proceedKeywords);

  const hasDepositStrong = isUser && containsAny(text, depositStrong) && !containsAny(text, depositNeg);
  const hasDepositWeak = isUser && containsAny(text, depositWeak) && !containsAny(text, depositNeg);

  const quoteDetected = isRelevant && isQuoteBlock(text);

  // Extract only from relevant messages
  const phone = isUser ? normalizePhone(text) : null;
  const name = isUser ? (extractName(text) || extractNameLoose(text)) : null;

  const fromAddress = isRelevant ? (extractAddressLine(text, "출발지") || extractFromToLoose(text).from) : null;
  const toAddress = isRelevant ? (extractAddressLine(text, "도착지") || extractFromToLoose(text).to) : null;

  const moveDate = isRelevant ? extractMoveDate(text) : null;
  const timeHHMM = isRelevant ? extractTimeLabel(text) : null;

  const quoteAmount = quoteDetected ? (extractMoney(text, "예상금액") ?? extractMoneyLoose(text, "quote")) : null;
  const depositAmount = quoteDetected ? (extractMoney(text, "예약금(20%)") ?? extractMoney(text, "예약금") ?? extractMoneyLoose(text, "deposit")) : null;
  const balanceAmount = quoteDetected ? (extractMoney(text, "잔금(80%)") ?? extractMoney(text, "잔금") ?? extractMoneyLoose(text, "balance")) : null;

  const { data: existing, error: exErr } = await supabase.from("jobs").select("*").eq("chat_id", chatId).maybeSingle();
  if (exErr) throw exErr;

  const merged = {
    customer_name: name ?? existing?.customer_name ?? null,
    customer_phone: phone ?? existing?.customer_phone ?? null,
    from_address: fromAddress ?? existing?.from_address ?? null,
    to_address: toAddress ?? existing?.to_address ?? null,

    move_date: moveDate ?? existing?.move_date ?? null,
    time_slot_label: timeHHMM ?? existing?.time_slot_label ?? null,

    scheduled_at:
      (moveDate || existing?.move_date)
        ? buildKstTimestamp(
            (moveDate ?? String(existing?.move_date || "").slice(0, 10)) || null,
            timeHHMM ?? existing?.time_slot_label ?? "09:00"
          )
        : existing?.scheduled_at ?? null,

    quote_amount: quoteAmount ?? existing?.quote_amount ?? null,
    deposit_amount: depositAmount ?? existing?.deposit_amount ?? null,
    balance_amount: balanceAmount ?? existing?.balance_amount ?? null,
  };

  const existingStatus = existing?.status || "draft";
  let nextStatus = existingStatus;
  let reason = existing?.status_reason || null;

  if (hasCancel) {
    // 취소 의도
    nextStatus = "canceled";
    reason = existingStatus === "confirmed" ? "canceled_after_confirmed" : "cancel_intent";
  } else if (priority(existingStatus) < priority("quoted") && quoteDetected) {
    // 봇 견적서 인식
    nextStatus = "quoted";
    reason = "quote_detected";
  } else if (priority(existingStatus) < priority("pending_confirm") && (hasProceed || hasDepositWeak)) {
    // 진행 의사/약한 입금 표현
    nextStatus = "pending_confirm";
    reason = hasProceed ? "proceed_intent" : "deposit_weak_intent";
  } else if (priority(existingStatus) < priority("confirmed") && hasDepositStrong) {
    // 강한 입금 표현이 있고, 필수 정보가 모두 채워졌는지 여부에 따라 confirmed 또는 pending_confirm 유지
    const requiredFields = ["customer_name", "customer_phone", "from_address", "to_address", "move_date"];
    const missingFields = requiredFields.filter((key) => !merged[key]);
    const hasAll = missingFields.length === 0;
    if (hasAll) {
      nextStatus = "confirmed";
      reason = "deposit_strong+required_fields";
    } else {
      nextStatus = "pending_confirm";
      reason = `deposit_strong_but_missing_fields:${missingFields.join(",")}`;
    }
  }

  if (nextStatus !== "canceled" && priority(existingStatus) > priority(nextStatus)) {
    nextStatus = existingStatus;
    reason = "status_downgrade_blocked";
  }

  const nowIso = new Date().toISOString();

  const jobRow = {
    source: "channeltalk",
    chat_id: chatId,
    chat_id_hash: sha256(chatId),
    source_message_id: messageId || existing?.source_message_id || null,

    status: nextStatus,
    status_reason: reason,

    ops_status: existing?.ops_status || "unassigned",
    last_message_at: nowIso,

    customer_name: merged.customer_name,
    customer_phone: merged.customer_phone,
    from_address: merged.from_address,
    to_address: merged.to_address,

    move_date: merged.move_date,
    time_slot_label: merged.time_slot_label,
    scheduled_at: merged.scheduled_at,

    quote_amount: merged.quote_amount,
    deposit_amount: merged.deposit_amount,
    balance_amount: merged.balance_amount,
  };

  // 최초로 confirmed 상태가 될 때 confirmed_at을 기록하고 ops_status를 open으로 변경한다.
  if (!existing?.confirmed_at && nextStatus === "confirmed") {
    jobRow.confirmed_at = nowIso;
    jobRow.ops_status = "open";
  }
  // 이미 confirmed_at이 있으면 그대로 유지
  if (existing?.confirmed_at) jobRow.confirmed_at = existing.confirmed_at;
  // 취소되면 canceled_at을 기록한다.
  if (nextStatus === "canceled") jobRow.canceled_at = nowIso;

  const { data: job, error: upErr } = await supabase
    .from("jobs")
    .upsert(jobRow, { onConflict: "chat_id" })
    .select("*")
    .maybeSingle();

  if (upErr) throw upErr;

  // Calendar sync
  if (job?.chat_id) {
    if (job.status === "confirmed") {
      const dateStr = job.scheduled_at || buildKstTimestamp(String(job.move_date || "").slice(0, 10), job.time_slot_label || "09:00");
      if (dateStr) {
        const start = new Date(dateStr);
        const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);

        const title = `${job.customer_name || "고객"} | ${String(job.from_address || "-").slice(0, 18)} → ${String(
          job.to_address || "-"
        ).slice(0, 18)}`;

        await supabase.from("job_events").upsert(
          {
            chat_id: job.chat_id,
            start_at: start.toISOString(),
            end_at: end.toISOString(),
            status: "confirmed",
            title,
            assigned_driver_id: job.assigned_driver_id || null,
          },
          { onConflict: "chat_id" }
        );
      }
    }

    if (job.status === "canceled") {
      await supabase.from("job_events").update({ status: "canceled" }).eq("chat_id", job.chat_id);
    }
  }

  return job;
}

/* =========================
   Routes
========================= */
app.get("/", (req, res) => {
  res.json({ ok: true, service: "ddlogi-ops", time: new Date().toISOString() });
});

if (supabase) {
  app.use("/jobs", jobsRouter({ supabase }));
  app.use("/calendar", calendarRouter({ supabase }));
  app.use("/drivers", driversRouter({ supabase }));
} else {
  console.warn("⚠️ Supabase client missing: APIs disabled");
}

app.post("/webhook/channel", async (req, res) => {
  if (WEBHOOK_TOKEN) {
    const got = String(req.headers["x-ddlogi-token"] || "");
    if (got !== WEBHOOK_TOKEN) return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const payload = req.body || {};
  const messageId = extractMessageId(payload);
  const chatId = extractChatId(payload);
  const chatIdSource = debugChatIdSource(payload);
  const userId = extractUserId(payload);
  const personType = extractPersonType(payload);
  const plainText = payload?.entity?.plainText || pickText(payload);

  console.log("\n========================");
  console.log("📩 webhook received");
  console.log("messageIdHash:", messageId ? sha256(messageId).slice(0, 16) : null);
  console.log("chatIdSource:", chatIdSource);
  console.log("chatIdHash:", chatId ? sha256(chatId).slice(0, 16) : null);
  console.log("personType:", personType);
  console.log("textLen:", String(plainText || "").length);

  try {
    // First: upsert job/event (best-effort)
    let job = null;
    if (chatId) {
      job = await upsertJobAndEvent({ chatId, messageId, personType, text: plainText });
    }

    // Always: log the message (masked) with inferred_status = job.status if available
    await saveWebhookLogSafe({
      messageId,
      inferredStatus: job?.status || "draft",
      chatId,
      personType,
      userId,
      plainText,
    });

    return res.json({ ok: true, job: job || null, chatIdSource });
  } catch (e) {
    console.error("❌ webhook error:", e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* =========================
   Server
========================= */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server Running on port ${PORT}`);
  if (ADMIN_ALLOWED_ORIGINS.length > 0) console.log("✅ ADMIN_ALLOWED_ORIGINS:", ADMIN_ALLOWED_ORIGINS.join(", "));
  else
    console.log(
      IS_PROD
        ? "⛔ ADMIN_ALLOWED_ORIGINS missing in prod (CORS blocks)."
        : "⚠️ ADMIN_ALLOWED_ORIGINS not set (dev allows all origins)."
    );
});