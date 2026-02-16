// functions/channel-webhook/index.js (ESM / Node 20+)
// ✅ ChannelTalk Webhook 수신 → webhook_logs 저장(항상, PII-safe)
// ✅ (권장) B안: jobs 상태 전이/업데이트는 Supabase(DB 트리거/함수)가 전담
//    - 기본값: USE_DB_STATE_MACHINE=1(또는 미설정)
//    - 예전 방식(서버가 jobs upsert) 쓰려면 USE_DB_STATE_MACHINE=0

import express from "express";
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

import jobsRouter from "./routes/jobs.js";

/* =========================
   App
========================= */
const app = express();
app.use(express.json({ limit: "2mb", type: "*/*" }));

/* =========================
   Env / Flags
========================= */
const WEBHOOK_TOKEN = process.env.DDLOGI_WEBHOOK_TOKEN || ""; // webhook 보호(선택)
const JOBS_RL_MAX = parseInt(process.env.JOBS_RL_MAX || "120", 10);

// ✅ B안: DB 상태머신이 jobs 담당 (기본 ON)
const USE_DB_STATE_MACHINE = String(process.env.USE_DB_STATE_MACHINE || "1") !== "0";

// 기본: raw_text 저장 안 함. 필요할 때만 1로 켬(마스킹 후 저장)
const STORE_MASKED_RAW_TEXT = String(process.env.STORE_MASKED_RAW_TEXT || "0") === "1";

// CORS
const ADMIN_ALLOWED_ORIGINS = String(process.env.ADMIN_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const IS_PROD = String(process.env.NODE_ENV || "").toLowerCase() === "production";

/* =========================
   Supabase (서버 전용)
========================= */
const hasSupabaseEnv =
  !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!hasSupabaseEnv) {
  console.warn("⚠️ Missing env: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = hasSupabaseEnv
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

/* =========================
   CORS (Admin only)
========================= */
function isAllowedOrigin(origin) {
  if (!origin) return false;

  // ✅ prod에서 미설정이면 차단(사고 방지)
  if (IS_PROD && ADMIN_ALLOWED_ORIGINS.length === 0) return false;

  // dev 편의
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
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-DDLOGI-TOKEN, X-ADMIN-TOKEN"
    );
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
   Rate Limit (for /jobs only)
========================= */
const RL_WINDOW_MS = 60 * 1000;
const rlMap = new Map();

function getClientIp(req) {
  const xf = (req.headers["x-forwarded-for"] || "").toString();
  if (xf) return xf.split(",")[0].trim();
  return req.ip || req.connection?.remoteAddress || "unknown";
}

function rateLimitJobs(req, res, next) {
  if (req.method === "OPTIONS") return next();
  if (!req.path.startsWith("/jobs")) return next();

  const ip = getClientIp(req);
  const now = Date.now();
  const rec = rlMap.get(ip);

  if (!rec || now - rec.ts > RL_WINDOW_MS) {
    rlMap.set(ip, { ts: now, count: 1 });
    return next();
  }

  rec.count += 1;
  rlMap.set(ip, rec);

  if (rec.count > JOBS_RL_MAX) {
    return res.status(429).json({ error: "Too many requests" });
  }

  next();
}
app.use(rateLimitJobs);

/* =========================
   PII-safe helpers
========================= */
function sha256(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function clampText(s, max = 1200) {
  const str = String(s || "");
  return str.length > max ? str.slice(0, max) + "…" : str;
}

function maskPII(text) {
  let t = String(text || "");

  // 전화번호 마스킹
  t = t.replace(/01[016789][\s-]?\d{3,4}[\s-]?\d{4}/g, (m) => {
    const digits = m.replace(/[\s-]/g, "");
    if (digits.length === 11) return digits.slice(0, 3) + "****" + digits.slice(7);
    if (digits.length === 10) return digits.slice(0, 3) + "***" + digits.slice(6);
    return "01*********";
  });

  // 이메일 마스킹
  t = t.replace(
    /\b([A-Z0-9._%+-]{1,64})@([A-Z0-9.-]{1,255}\.[A-Z]{2,24})\b/gi,
    (m) => {
      const [u, d] = m.split("@");
      const uu = u.length <= 2 ? "*".repeat(u.length) : u.slice(0, 2) + "***";
      return `${uu}@${d}`;
    }
  );

  // 계좌처럼 보이는 숫자-숫자-숫자 마스킹(보수)
  t = t.replace(/\b(\d{2,6})-(\d{2,8})-(\d{2,8})\b/g, "$1-****-$3");

  // 주소: 시/도 + 구/군/시 + 동/읍/면까지만 남기고 뒤는 줄임(보수)
  t = t.replace(
    /\b(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)\s+([^\n]{0,30}?(구|군|시))\s+([^\n]{0,30}?(동|읍|면))([^\n]*)/g,
    (m, p1, p2, _g, p4) => `${p1} ${p2} ${p4} …`
  );

  return t;
}

/* =========================
   Utils (기존 로직 유지)
========================= */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsKeyword(text, keywords) {
  const t = String(text || "");
  return keywords.some((k) => t.includes(k));
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
  const safe = escapeRegExp(label);
  const re = new RegExp(`${safe}[:\\s]*([^\\n]+)`, "m");
  const match = String(text || "").match(re);
  if (!match) return null;
  const addr = String(match[1] || "").trim();
  return addr.length >= 3 ? addr : null;
}

function extractMoney(text, label) {
  const safe = escapeRegExp(label);
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
    deposit: [
      /예약금[^\d]*([0-9]{1,3}(?:,[0-9]{3})+)\s*원/i,
      /예약금\s*20%[^\d]*([0-9]{1,3}(?:,[0-9]{3})+)\s*원/i,
    ],
    balance: [
      /잔금[^\d]*([0-9]{1,3}(?:,[0-9]{3})+)\s*원/i,
      /잔금\s*80%[^\d]*([0-9]{1,3}(?:,[0-9]{3})+)\s*원/i,
    ],
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

function extractFromToLoose(text) {
  const t = String(text || "");
  const from = t.match(/출발지\s*([^\n]+?)(?=\s*도착지|$)/);
  const to = t.match(/도착지\s*([^\n]+?)(?=\s*(연락처|전화|번호|$))/);
  return {
    from: from ? from[1].trim() : null,
    to: to ? to[1].trim() : null,
  };
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

/**
 * ✅ FIX: ChannelTalk payload 버전에 따라 chatId가 달라져서
 * 후보 경로를 넓혀 안정적으로 추출
 */
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

/**
 * ✅ PII 없이 "어느 키에서 잡혔는지"만 표시하는 디버그
 */
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
  return payload?.entity?.personType || null;
}

/* =========================
   Quote block detection
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

/* =========================
   Status priority
========================= */
function getStatusPriority(status) {
  const map = { draft: 0, quoted: 1, pending_confirm: 2, confirmed: 3, canceled: 2 };
  return map[status] ?? 0;
}

/* =========================
   최신값 우선 추출 (기존 로직 유지)
========================= */
function extractLatestFactsFromLogs(logs) {
  let latest = {
    phone: null,
    name: null,
    fromAddress: null,
    toAddress: null,
    quoteAmount: null,
    depositAmount: null,
    balanceAmount: null,
    hasQuote: false,
    hasDepositWeak: false,
    hasDepositStrong: false,
    hasProceed: false,
    negDeposit: false,
    negProceed: false,
    hasCancel: false,
  };

  const cancelKeywords = ["취소", "취소할게", "취소하겠", "취소합니다", "예약 취소", "진행 취소"];
  const proceedKeywords = ["그대로 진행", "네 진행", "진행할게요", "진행하겠습니다", "확정", "예약", "진행 부탁", "부탁드립니다"];
  const proceedNegKeywords = ["취소", "보류", "잠시", "다음에", "나중에", "진행 안", "안 할", "중단"];

  const depositStrong = ["입금완료", "입금 완료", "송금완료", "송금 완료", "이체완료", "이체 완료", "보냈어요", "보냈습니다", "송금했", "이체했", "입금 했", "입금했습니다"];
  const depositWeak = ["입금", "송금", "이체", "보낼게요", "입금할게요", "입금 예정", "송금 예정", "이체 예정"];
  const depositNeg = ["미입금", "입금 전", "입금전", "아직 입금", "아직 안", "안 했", "못했", "보류", "나중에 입금", "입금 못", "입금 안"];

  for (const row of logs) {
    const pt = row.person_type;
    const txt = String(row.preview || "").trim(); // ✅ preview만
    if (!txt) continue;

    if (!latest.hasQuote && (pt === "bot" || pt === "user") && isQuoteBlock(txt)) {
      latest.hasQuote = true;
    }

    if (pt === "bot") {
      if (latest.quoteAmount == null) {
        const v = extractMoney(txt, "예상금액") ?? extractMoneyLoose(txt, "quote");
        if (v != null) latest.quoteAmount = v;
      }
      if (latest.depositAmount == null) {
        const v =
          extractMoney(txt, "예약금(20%)") ??
          extractMoney(txt, "예약금") ??
          extractMoneyLoose(txt, "deposit");
        if (v != null) latest.depositAmount = v;
      }
      if (latest.balanceAmount == null) {
        const v =
          extractMoney(txt, "잔금(80%)") ??
          extractMoney(txt, "잔금") ??
          extractMoneyLoose(txt, "balance");
        if (v != null) latest.balanceAmount = v;
      }
    }

    if (pt !== "user") continue;

    if (!latest.hasCancel && containsKeyword(txt, cancelKeywords)) latest.hasCancel = true;

    if (!latest.hasProceed && containsKeyword(txt, proceedKeywords)) latest.hasProceed = true;
    if (!latest.negProceed && containsKeyword(txt, proceedNegKeywords)) latest.negProceed = true;

    if (!latest.hasDepositStrong && containsKeyword(txt, depositStrong)) latest.hasDepositStrong = true;
    if (!latest.hasDepositWeak && containsKeyword(txt, depositWeak)) latest.hasDepositWeak = true;
    if (!latest.negDeposit && containsKeyword(txt, depositNeg)) latest.negDeposit = true;

    if (!latest.phone) {
      const p = normalizePhone(txt);
      if (p) latest.phone = p;
    }
    if (!latest.name) {
      const n = extractName(txt) || extractNameLoose(txt);
      if (n) latest.name = n;
    }

    if (!latest.fromAddress || !latest.toAddress) {
      const fromLabel = extractAddressLine(txt, "출발지");
      const toLabel = extractAddressLine(txt, "도착지");
      const loose = extractFromToLoose(txt);

      if (!latest.fromAddress) latest.fromAddress = fromLabel || loose.from || null;
      if (!latest.toAddress) latest.toAddress = toLabel || loose.to || null;
    }

    if (
      latest.phone &&
      latest.fromAddress &&
      latest.toAddress &&
      latest.hasQuote &&
      (latest.hasDepositStrong || latest.hasProceed || latest.hasCancel)
    ) {
      break;
    }
  }

  return latest;
}

/* =========================
   누적판단 (서버 jobs upsert 모드에서만 사용)
========================= */
function aggregateFromLogs(logs) {
  const botTexts = logs
    .filter((x) => x.person_type === "bot")
    .map((x) => x.preview || "")
    .filter((s) => String(s).trim().length > 0);

  const userTexts = logs
    .filter((x) => x.person_type === "user")
    .map((x) => x.preview || "")
    .filter((s) => String(s).trim().length > 0);

  const allBot = botTexts.join("\n");
  const allUser = userTexts.join("\n");

  const facts = extractLatestFactsFromLogs(logs);

  const phone = facts.phone || normalizePhone(allUser) || null;
  const name = facts.name || extractName(allUser) || extractNameLoose(allUser) || null;

  const fromAddress =
    facts.fromAddress ||
    extractAddressLine(allUser, "출발지") ||
    extractFromToLoose(allUser).from ||
    null;

  const toAddress =
    facts.toAddress ||
    extractAddressLine(allUser, "도착지") ||
    extractFromToLoose(allUser).to ||
    null;

  const hasQuote = facts.hasQuote || botTexts.some((t) => isQuoteBlock(t));

  const quoteAmount =
    facts.quoteAmount ?? (extractMoney(allBot, "예상금액") ?? extractMoneyLoose(allBot, "quote"));

  const depositAmount =
    facts.depositAmount ??
    (extractMoney(allBot, "예약금(20%)") ??
      extractMoney(allBot, "예약금") ??
      extractMoneyLoose(allBot, "deposit"));

  const balanceAmount =
    facts.balanceAmount ??
    (extractMoney(allBot, "잔금(80%)") ??
      extractMoney(allBot, "잔금") ??
      extractMoneyLoose(allBot, "balance"));

  const hasDepositStrong = facts.hasDepositStrong && !facts.negDeposit;
  const hasDepositWeak = facts.hasDepositWeak && !facts.negDeposit;
  const hasProceed = facts.hasProceed && !facts.negProceed;
  const hasCancel = facts.hasCancel;

  if (!hasQuote) {
    return {
      status: "draft",
      reason: "no_quote_block_in_chat",
      phone,
      name,
      fromAddress,
      toAddress,
      quoteAmount,
      depositAmount,
      balanceAmount,
    };
  }

  if (hasCancel) {
    return {
      status: "canceled",
      reason: "cancel_intent (chat aggregated)",
      phone,
      name,
      fromAddress,
      toAddress,
      quoteAmount,
      depositAmount,
      balanceAmount,
    };
  }

  if (hasDepositStrong && phone && fromAddress && toAddress) {
    return {
      status: "confirmed",
      reason: "deposit_strong+phone+from/to (chat aggregated)",
      phone,
      name,
      fromAddress,
      toAddress,
      quoteAmount,
      depositAmount,
      balanceAmount,
    };
  }

  if (hasProceed || hasDepositWeak) {
    return {
      status: "pending_confirm",
      reason: hasProceed ? "proceed_intent (chat aggregated)" : "deposit_weak_intent (chat aggregated)",
      phone,
      name,
      fromAddress,
      toAddress,
      quoteAmount,
      depositAmount,
      balanceAmount,
    };
  }

  return {
    status: "quoted",
    reason: "quote_exists_only",
    phone,
    name,
    fromAddress,
    toAddress,
    quoteAmount,
    depositAmount,
    balanceAmount,
  };
}

/* =========================
   DB helpers (PII-safe)
========================= */
async function saveWebhookLogSafe({ messageId, inferredStatus, text, chatId, personType, userId, plainText }) {
  if (!supabase) return;

  const raw = plainText || text || "";
  const masked = maskPII(raw);

  const row = {
    provider: "channeltalk",
    event_type: "message",

    // ✅ 누적판단/매칭을 위해 chat_id 유지 (원문이 아니라 ID)
    chat_id: chatId || null,
    message_id: messageId || null,

    // ✅ 중복/검색용 해시
    chat_id_hash: chatId ? sha256(chatId) : null,
    message_id_hash: messageId ? sha256(messageId) : null,

    // ✅ preview만 저장(PII 마스킹 + 길이 제한)
    preview: clampText(masked, personType === "bot" ? 2000 : 1200),

    inferred_status: inferredStatus || "draft",

    // ✅ 최소 메타만
    meta: {
      person_type: personType || null,
      user_id: userId || null,
      text_len: String(raw).length,
      v: "SAFELOG_V1",
    },
  };

  const { error } = await supabase.from("webhook_logs").insert(row);

  // UNIQUE 충돌이면 무시(중복 race 해결)
  if (error) {
    const msg = String(error.message || "").toLowerCase();
    if (msg.includes("duplicate") || msg.includes("unique")) return;
    console.warn("⚠️ webhook_logs 저장 실패:", error.message);
  }
}

// 아래 3개는 USE_DB_STATE_MACHINE=0(서버 jobs upsert 모드)에서만 사용
async function fetchRecentLogsByChatId(chatId, limit = 120) {
  if (!supabase || !chatId) return [];
  const { data, error } = await supabase
    .from("webhook_logs")
    .select("created_at, message_id, inferred_status, preview, chat_id, meta")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.warn("⚠️ webhook_logs 조회 실패:", error.message);
    return [];
  }

  return (data || []).map((x) => ({
    created_at: x.created_at,
    message_id: x.message_id,
    status: x.inferred_status,
    preview: x.preview,
    chat_id: x.chat_id,
    person_type: x?.meta?.person_type || null,
    user_id: x?.meta?.user_id || null,
  }));
}

async function getExistingJob(chatId) {
  if (!supabase || !chatId) return null;

  const { data, error } = await supabase
    .from("jobs")
    .select(
      "id, status, ops_status, confirmed_at, customer_name, customer_phone, from_address, to_address, quote_amount, deposit_amount, balance_amount, raw_text"
    )
    .eq("chat_id", chatId)
    .maybeSingle();

  if (error) {
    console.warn("⚠️ 기존 job 조회 실패:", error.message);
    return null;
  }
  return data || null;
}

function keepExisting(existingValue, newValue) {
  return newValue != null && String(newValue).trim() !== "" ? newValue : (existingValue ?? null);
}

async function upsertJobByChat({ chatId, lastMessageId, agg, mergedText, existingJob }) {
  if (!supabase) return null;

  const customer_name = keepExisting(existingJob?.customer_name, agg.name);
  const customer_phone = keepExisting(existingJob?.customer_phone, agg.phone);
  const from_address = keepExisting(existingJob?.from_address, agg.fromAddress);
  const to_address = keepExisting(existingJob?.to_address, agg.toAddress);

  const quote_amount = (agg.quoteAmount ?? null) ?? existingJob?.quote_amount ?? null;
  const deposit_amount = (agg.depositAmount ?? null) ?? existingJob?.deposit_amount ?? null;
  const balance_amount = (agg.balanceAmount ?? null) ?? existingJob?.balance_amount ?? null;

  const row = {
    source: "channeltalk",
    chat_id: chatId,
    source_message_id: lastMessageId,

    customer_name,
    customer_phone,
    from_address,
    to_address,

    raw_text: STORE_MASKED_RAW_TEXT
      ? clampText(maskPII(mergedText || ""), 6000)
      : (existingJob?.raw_text ?? null),

    status: agg.status,
    status_reason: agg.reason,

    quote_amount,
    deposit_amount,
    balance_amount,
  };

  if (existingJob?.confirmed_at) {
    row.confirmed_at = existingJob.confirmed_at;
  } else if (agg.status === "confirmed") {
    row.confirmed_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from("jobs")
    .upsert(row, { onConflict: "chat_id" })
    .select("id, status, ops_status")
    .single();

  if (error) throw error;
  return data;
}

/* =========================
   Routes
========================= */
app.get("/", (req, res) => {
  res.json({ ok: true, service: "ddlogi-channel-webhook", time: new Date().toISOString() });
});

// ✅ adminToken 주입 제거 (인증은 middlewares/adminAuth.js에서만)
if (supabase) {
  app.use("/jobs", jobsRouter({ supabase }));
} else {
  console.warn("⚠️ Supabase client missing: /jobs API disabled");
}

app.post("/webhook/channel", async (req, res) => {
  if (WEBHOOK_TOKEN) {
    const got = String(req.headers["x-ddlogi-token"] || "");
    if (got !== WEBHOOK_TOKEN) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
  }

  const payload = req.body || {};

  const text = pickText(payload);
  const messageId = extractMessageId(payload);
  const chatId = extractChatId(payload);
  const chatIdSource = debugChatIdSource(payload);
  const userId = extractUserId(payload);
  const personType = extractPersonType(payload);
  const plainText = payload?.entity?.plainText || text;

  const singleStatus = "draft";

  // ✅ 콘솔에는 PII 출력 금지 (해시/길이/소스만)
  console.log("\n========================");
  console.log("📩 메시지 수신");
  console.log("messageIdHash:", messageId ? sha256(messageId).slice(0, 16) : null);
  console.log("chatIdSource:", chatIdSource);
  console.log("chatIdHash:", chatId ? sha256(chatId).slice(0, 16) : null);
  console.log("personType:", personType);
  console.log("textLen:", String(plainText || "").length);
  console.log("USE_DB_STATE_MACHINE:", USE_DB_STATE_MACHINE ? "ON" : "OFF");

  try {
    await saveWebhookLogSafe({
      messageId,
      inferredStatus: singleStatus,
      text,
      chatId,
      personType,
      userId,
      plainText,
    });

    if (!chatId) {
      // chatId 못 잡으면 DB 상태머신도 매칭 불가 → 로그 저장만 하고 종료
      return res.json({ ok: true, status: "draft", reason: "no_chatId", chatIdSource });
    }

    // ✅ B안: DB가 jobs를 전담한다면 여기서 종료 (webhook_logs insert 후 트리거가 jobs 반영)
    if (USE_DB_STATE_MACHINE) {
      return res.json({ ok: true, status: "logged", reason: "db_state_machine", chatIdSource });
    }

    // -------------------------------------------------
    // (옵션) A안 호환: 서버에서 누적판단 + jobs upsert
    // USE_DB_STATE_MACHINE=0 일 때만 동작
    // -------------------------------------------------
    const logs = await fetchRecentLogsByChatId(chatId, 120);
    const agg = aggregateFromLogs(logs);

    const existingJob = await getExistingJob(chatId);
    const existingStatus = existingJob?.status || null;

    // ✅ confirmed→quoted 같은 다운그레이드 방지
    if (
      agg.status !== "canceled" &&
      existingStatus &&
      getStatusPriority(existingStatus) > getStatusPriority(agg.status)
    ) {
      console.log("⛔ status downgrade blocked:", existingStatus, "→", agg.status);
      agg.status = existingStatus;
      agg.reason = "status_downgrade_blocked";
    }

    if (agg.status === "canceled" && existingStatus === "confirmed") {
      agg.reason = "canceled_after_confirmed";
    }

    if (agg.status !== "draft") {
      const mergedText = logs
        .slice()
        .reverse()
        .map((x) => `[${x.person_type}] ${(x.preview || "").trim()}`)
        .filter((s) => s.replace(/\[.*?\]\s*/, "").trim().length > 0)
        .join("\n");

      const job = await upsertJobByChat({
        chatId,
        lastMessageId: messageId,
        agg,
        mergedText,
        existingJob,
      });

      console.log("✅ jobs upsert:", job);
    }

    console.log("➡️ aggregatedStatus:", agg.status, "| reason:", agg.reason);
    return res.json({ ok: true, status: agg.status, reason: agg.reason, chatIdSource });
  } catch (e) {
    console.error("❌ 처리 실패:", e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* =========================
   Server
========================= */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Channel Webhook Server Running on port ${PORT}`);
  if (ADMIN_ALLOWED_ORIGINS.length > 0) console.log("✅ ADMIN_ALLOWED_ORIGINS:", ADMIN_ALLOWED_ORIGINS.join(", "));
  else
    console.log(
      IS_PROD
        ? "⛔ ADMIN_ALLOWED_ORIGINS missing in prod (CORS blocks)."
        : "⚠️ ADMIN_ALLOWED_ORIGINS not set (dev allows all origins)."
    );
});
