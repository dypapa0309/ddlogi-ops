// index.js (ESM / Node 20+)
// ✅ ChannelTalk Webhook 수신 → webhook_logs 저장(항상) → chat_id 기준 누적판단 → jobs upsert(confirmed/pending_confirm/quoted)
// ✅ Render 로그: aggregatedStatus / messageId / chatId / preview 출력
// ✅ 2단계 적용: confirmed(상위 상태) 다운그레이드 방지

import express from "express";
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

/* =========================
   App
========================= */
const app = express();
app.use(express.json({ limit: "2mb", type: "*/*" }));

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
      auth: { persistSession: false },
    })
  : null;

/* =========================
   Utils
========================= */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsKeyword(text, keywords) {
  const t = String(text || "");
  return keywords.some((k) => t.includes(k));
}

function normalizePhone(text) {
  // 010 1234 5678 / 010-1234-5678 / 01012345678 → 01012345678
  const m = String(text || "").match(/01[016789][\s-]?\d{3,4}[\s-]?\d{4}/);
  return m ? m[0].replace(/[\s-]/g, "") : null;
}

function extractName(text) {
  // "이름: 홍길동" / "이름 홍길동"
  const m = String(text || "").match(/이름[:\s]*([가-힣]{2,4})/);
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
  // "[예상금액] ₩234,000" 형태를 우선
  const safe = escapeRegExp(label);
  const re = new RegExp(`\\[${safe}\\]\\s*₩?([0-9,]+)`, "i");
  const m = String(text || "").match(re);
  if (!m) return null;
  const n = parseInt(String(m[1]).replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

// 고객이 라벨 없이 "출발지 ... 도착지 ..."로 보낸 경우
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
  // ChannelTalk는 entity.plainText가 제일 정확
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
  return payload?.entity?.chatId || payload?.refers?.userChat?.id || null;
}

function extractUserId(payload) {
  return payload?.refers?.user?.id || payload?.entity?.personId || null;
}

function extractPersonType(payload) {
  return payload?.entity?.personType || null; // "user" | "bot"
}

/* =========================
   Quote block (bot) detection
========================= */
function isQuoteBlock(text) {
  const t = String(text || "");
  return (
    t.includes("이사 방식") &&
    t.includes("차량") &&
    t.includes("일정") &&
    t.includes("출발지") &&
    t.includes("도착지") &&
    (t.includes("[예상금액]") || t.includes("예상금액"))
  );
}

/* =========================
   Status priority (downgrade 방지)
========================= */
function getStatusPriority(status) {
  const map = {
    draft: 0,
    quoted: 1,
    pending_confirm: 2,
    confirmed: 3,
  };
  return map[status] ?? 0;
}

/* =========================
   Accumulated 판단 (chat_id 기준)
========================= */
function aggregateFromLogs(logs) {
  // logs는 최신순(desc)이라고 가정
  const botTexts = logs
    .filter((x) => x.person_type === "bot")
    .map((x) => x.plain_text || x.text || "")
    .filter((s) => String(s).trim().length > 0);

  const userTexts = logs
    .filter((x) => x.person_type === "user")
    .map((x) => x.plain_text || x.text || "")
    .filter((s) => String(s).trim().length > 0);

  const allBot = botTexts.join("\n");
  const allUser = userTexts.join("\n");
  const all = `${allBot}\n${allUser}`;

  const hasQuote = botTexts.some((t) => isQuoteBlock(t));

  // 고객 의사 키워드
  const hasProceed = containsKeyword(allUser, [
    "그대로 진행",
    "네 진행",
    "진행할게요",
    "진행하겠습니다",
    "확정",
    "예약",
    "진행 부탁",
    "부탁드립니다",
  ]);

  const hasDeposit = containsKeyword(allUser, [
    "입금",
    "입금완료",
    "입금 완료",
    "보냈",
    "송금",
    "이체",
    "완료했",
    "완료했습니다",
  ]);

  // 연락처/이름/주소
  const phone = normalizePhone(allUser) || normalizePhone(all);
  const name = extractName(allUser) || extractName(all);

  // 라벨형 + 느슨한 형태 둘 다 대응
  const fromLabel =
    extractAddressLine(allUser, "출발지") || extractAddressLine(all, "출발지");
  const toLabel =
    extractAddressLine(allUser, "도착지") || extractAddressLine(all, "도착지");

  const loose = extractFromToLoose(allUser);
  const fromAddress = fromLabel || loose.from;
  const toAddress = toLabel || loose.to;

  // 금액은 보통 봇 견적문에 존재
  const quoteAmount = extractMoney(allBot, "예상금액");
  const depositAmount =
    extractMoney(allBot, "예약금(20%)") ?? extractMoney(allBot, "예약금");
  const balanceAmount =
    extractMoney(allBot, "잔금(80%)") ?? extractMoney(allBot, "잔금");

  // ✅ 상태 규칙 (현실형)
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

  if (hasDeposit && phone && fromAddress && toAddress) {
    return {
      status: "confirmed",
      reason: "deposit+phone+from/to (chat aggregated)",
      phone,
      name,
      fromAddress,
      toAddress,
      quoteAmount,
      depositAmount,
      balanceAmount,
    };
  }

  if (hasProceed) {
    return {
      status: "pending_confirm",
      reason: "proceed_intent (chat aggregated)",
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
   DB helpers
========================= */
async function saveWebhookLog({
  payload,
  messageId,
  status,
  text,
  chatId,
  personType,
  userId,
  plainText,
}) {
  if (!supabase) return;

  const { error } = await supabase.from("webhook_logs").insert({
    source: "channeltalk",
    message_id: messageId,
    status: status || "draft",
    text: text || null,
    plain_text: plainText || null,
    chat_id: chatId || null,
    person_type: personType || null,
    user_id: userId || null,
    payload,
  });

  if (error) console.warn("⚠️ webhook_logs 저장 실패:", error.message);
}

async function fetchRecentLogsByChatId(chatId, limit = 30) {
  if (!supabase || !chatId) return [];

  const { data, error } = await supabase
    .from("webhook_logs")
    .select("created_at, message_id, status, text, plain_text, chat_id, person_type, user_id")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.warn("⚠️ webhook_logs 조회 실패:", error.message);
    return [];
  }
  return data || [];
}

async function getExistingJobStatus(chatId) {
  if (!supabase || !chatId) return null;

  const { data, error } = await supabase
    .from("jobs")
    .select("status")
    .eq("chat_id", chatId)
    .maybeSingle();

  if (error) {
    console.warn("⚠️ 기존 job 조회 실패:", error.message);
    return null;
  }
  return data?.status || null;
}

async function upsertJobByChat({ chatId, lastPayload, lastMessageId, agg, mergedText }) {
  if (!supabase) return null;

  const row = {
    source: "channeltalk",
    chat_id: chatId,
    source_message_id: lastMessageId,

    customer_name: agg.name || null,
    customer_phone: agg.phone || null,
    from_address: agg.fromAddress || null,
    to_address: agg.toAddress || null,

    raw_text: mergedText || null,
    payload: lastPayload,

    status: agg.status,
    status_reason: agg.reason,

    quote_amount: agg.quoteAmount ?? null,
    deposit_amount: agg.depositAmount ?? null,
    balance_amount: agg.balanceAmount ?? null,
  };

  if (agg.status === "confirmed") {
    row.confirmed_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from("jobs")
    .upsert(row, { onConflict: "chat_id" })
    .select("id, status")
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

app.post("/webhook/channel", async (req, res) => {
  const payload = req.body || {};

  const text = pickText(payload);
  const messageId = extractMessageId(payload);
  const chatId = extractChatId(payload);
  const userId = extractUserId(payload);
  const personType = extractPersonType(payload);
  const plainText = payload?.entity?.plainText || text;

  // 단일 메시지 기준 status는 참고용(항상 draft로 저장)
  const singleStatus = "draft";

  console.log("\n========================");
  console.log("📩 메시지 수신");
  console.log("messageId:", messageId);
  console.log("chatId:", chatId);
  console.log("personType:", personType);
  console.log("textPreview:", String(plainText || "").slice(0, 180));

  try {
    // 1) 항상 webhook_logs 저장
    await saveWebhookLog({
      payload,
      messageId,
      status: singleStatus,
      text,
      chatId,
      personType,
      userId,
      plainText,
    });

    // chatId가 없으면 누적판단 불가 → draft 반환
    if (!chatId) {
      return res.json({ ok: true, status: "draft", reason: "no_chatId" });
    }

    // 2) chat_id 기준 최근 로그 조회 → 누적판단
    const logs = await fetchRecentLogsByChatId(chatId, 30);
    const agg = aggregateFromLogs(logs);

    // 2.5) ✅ 다운그레이드 방지 (기존 상태가 더 높으면 유지)
    const existingStatus = await getExistingJobStatus(chatId);
    if (
      existingStatus &&
      getStatusPriority(existingStatus) > getStatusPriority(agg.status)
    ) {
      console.log("⛔ status downgrade blocked:", existingStatus, "→", agg.status);
      agg.status = existingStatus;
      agg.reason = "status_downgrade_blocked";
    }

    // 3) jobs upsert: draft는 생성/업데이트 하지 않음
    if (agg.status !== "draft") {
      const mergedText = logs
        .slice()
        .reverse() // 오래된 → 최신
        .map((x) => `[${x.person_type}] ${(x.plain_text || x.text || "").trim()}`)
        .filter((s) => s.replace(/\[.*?\]\s*/, "").trim().length > 0)
        .join("\n");

      const job = await upsertJobByChat({
        chatId,
        lastPayload: payload,
        lastMessageId: messageId,
        agg,
        mergedText,
      });

      console.log("✅ jobs upsert:", job);
    }

    console.log("➡️ aggregatedStatus:", agg.status, "| reason:", agg.reason);

    return res.json({ ok: true, status: agg.status, reason: agg.reason });
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
});
