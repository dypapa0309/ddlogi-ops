// index.js (ESM / Node 20+)
// ✅ ChannelTalk Webhook 수신 → webhook_logs 저장(항상) → chat_id 기준 누적판단 → jobs upsert(confirmed/pending/quoted)
// ✅ Render 로그: status / messageId / chatId / preview 출력

import express from "express";
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

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
   유틸
========================= */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsKeyword(text, keywords) {
  return keywords.some((k) => text.includes(k));
}

function normalizePhone(text) {
  // 010 1234 5678 / 010-1234-5678 / 01012345678 → 01012345678
  const m = String(text || "").match(/01[016789][\s-]?\d{3,4}[\s-]?\d{4}/);
  return m ? m[0].replace(/[\s-]/g, "") : null;
}

function extractName(text) {
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
  const safe = escapeRegExp(label);
  const re = new RegExp(`\\[${safe}\\]\\s*₩?([0-9,]+)`, "i");
  const m = String(text || "").match(re);
  if (!m) return null;
  return parseInt(m[1].replace(/,/g, ""), 10);
}

// “출발지/도착지”를 라벨 없이 짧게 쓴 고객 메시지에서 뽑는 용도
function extractFromToLoose(text) {
  const t = String(text || "");
  const from = t.match(/출발지\s*([^\n]+?)(?=\s*도착지|$)/);
  const to = t.match(/도착지\s*([^\n]+?)(?=\s*연락처|전화|$)/);
  return {
    from: from ? from[1].trim() : null,
    to: to ? to[1].trim() : null,
  };
}

/* =========================
   ChannelTalk payload 파싱
========================= */
function pickText(payload) {
  // ChannelTalk는 entity.plainText가 제일 정확함
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
  // 실제 user id
  return payload?.refers?.user?.id || payload?.entity?.personId || null;
}

function extractPersonType(payload) {
  return payload?.entity?.personType || null; // "user" | "bot"
}

/* =========================
   “견적문(봇)” 판별
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
   누적판단: chat_id 기준 최근 로그를 합쳐서 상태 결정
========================= */
function aggregateFromLogs(logs) {
  // logs: 최신순(내림차순)이라고 가정
  // 봇/유저 분리
  const botTexts = logs
    .filter((x) => x.person_type === "bot")
    .map((x) => x.plain_text || x.text || "")
    .filter(Boolean);

  const userTexts = logs
    .filter((x) => x.person_type === "user")
    .map((x) => x.plain_text || x.text || "")
    .filter(Boolean);

  const allBot = botTexts.join("\n");
  const allUser = userTexts.join("\n");
  const all = `${allBot}\n${allUser}`;

  const hasQuote = botTexts.some((t) => isQuoteBlock(t));

  // 고객 의사
  const hasProceed = containsKeyword(allUser, ["그대로 진행", "네 진행", "진행할게요", "확정", "예약"]);
  const hasDeposit = containsKeyword(allUser, ["입금", "입금완료", "입금 완료", "보냈", "송금", "이체"]);

  // 연락처/이름/주소
  const phone = normalizePhone(allUser) || normalizePhone(all);
  const name = extractName(allUser) || extractName(all);

  // 라벨형 주소(봇이 요구한 폼) + 느슨한 주소(출발지/도착지 ~) 둘 다 대응
  const fromLabel = extractAddressLine(allUser, "출발지") || extractAddressLine(all, "출발지");
  const toLabel = extractAddressLine(allUser, "도착지") || extractAddressLine(all, "도착지");
  const loose = extractFromToLoose(allUser);

  const fromAddress = fromLabel || loose.from;
  const toAddress = toLabel || loose.to;

  // 금액은 대부분 “봇 견적문”에 있으니 bot 쪽에서 뽑는 게 정확
  const quoteAmount = extractMoney(allBot, "예상금액");
  const depositAmount = extractMoney(allBot, "예약금(20%)") ?? extractMoney(allBot, "예약금");
  const balanceAmount = extractMoney(allBot, "잔금(80%)") ?? extractMoney(allBot, "잔금");

  // ✅ 상태 규칙 (현실 흐름에 맞춤)
  // 1) 견적문이 있어야 quoted/pending/confirmed가 의미 있음
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

  // 2) 유저가 “그대로 진행” 하면 pending_confirm
  // 3) 유저가 “입금” + (전화) + (출/도착) 있으면 confirmed
  //    (이름은 ‘필수’로 잡으면 누락이 많아서 선택값으로 둠)
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
   DB: webhook_logs 저장 / chat logs 조회 / jobs upsert
========================= */

// webhook_logs 컬럼(권장)
// source(text), message_id(text), status(text), text(text), payload(jsonb),
// chat_id(text), person_type(text), user_id(text), plain_text(text), created_at(timestamptz default now())

async function saveWebhookLog({ payload, messageId, status, text, chatId, personType, userId, plainText }) {
  if (!supabase) return;

  const { error } = await supabase.from("webhook_logs").insert({
    source: "channeltalk",
    message_id: messageId,
    status,
    text: text || null,
    payload,
    chat_id: chatId,
    person_type: personType,
    user_id: userId,
    plain_text: plainText || null,
  });

  if (error) console.warn("⚠️ webhook_logs 저장 실패:", error.message);
}

async function fetchRecentLogsByChatId(chatId, limit = 30) {
  if (!supabase) return [];

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

// jobs 컬럼(예시)
// id(uuid), source, chat_id, source_message_id, customer_name, customer_phone,
// from_address, to_address, raw_text, payload, status, status_reason, confirmed_at,
// quote_amount, deposit_amount, balance_amount

async function upsertJobByChat({ chatId, lastPayload, lastMessageId, agg, mergedText }) {
  if (!supabase) return null;

  const row = {
    source: "channeltalk",
    chat_id: chatId,
    source_message_id: lastMessageId, // 마지막 메시지 id
    customer_name: agg.name || null,
    customer_phone: agg.phone || null,
    from_address: agg.fromAddress || null,
    to_address: agg.toAddress || null,

    raw_text: mergedText || null,
    payload: lastPayload, // 최신 payload 하나라도 넣어두면 추적 가능(원하면 null로 해도 됨)

    status: agg.status,
    status_reason: agg.reason,

    quote_amount: agg.quoteAmount ?? null,
    deposit_amount: agg.depositAmount ?? null,
    balance_amount: agg.balanceAmount ?? null,
  };

  if (agg.status === "confirmed") {
    row.confirmed_at = new Date().toISOString();
  }

  // ✅ chat_id 기준으로 1개로 관리하고 싶으면 onConflict를 chat_id로
  // jobs에 UNIQUE(chat_id) 권장
  const { data, error } = await supabase
    .from("jobs")
    .upsert(row, { onConflict: "chat_id" })
    .select("id, status")
    .single();

  if (error) throw error;
  return data;
}

/* =========================
   엔드포인트
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

  // “단일 메시지 status”는 참고용으로만 저장 (실제 판정은 chat 누적으로 할 거라서)
  const singleStatus = "draft";

  console.log("\n========================");
  console.log("📩 메시지 수신");
  console.log("messageId:", messageId);
  console.log("chatId:", chatId);
  console.log("personType:", personType);
  console.log("textPreview:", (plainText || "").slice(0, 180));

  try {
    // 1) 무조건 webhook_logs 저장
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

    // chatId 없으면 여기까지만
    if (!chatId) {
      return res.json({ ok: true, status: "draft", note: "no_chatId" });
    }

    // 2) chat_id 기준 최근 로그 조회 → 누적판단
    const logs = await fetchRecentLogsByChatId(chatId, 30);
    const agg = aggregateFromLogs(logs);

    // 3) jobs upsert (draft면 jobs까지 만들지 말지 선택 가능)
    //    일단은 quoted 이상일 때만 만들도록
    if (agg.status !== "draft") {
      const mergedText = logs
        .slice()
        .reverse()
        .map((x) => `[${x.person_type}] ${x.plain_text || x.text || ""}`)
        .filter((s) => s.trim().length > 0)
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

    res.json({ ok: true, status: agg.status, reason: agg.reason });
  } catch (e) {
    console.error("❌ 처리 실패:", e?.message || e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* =========================
   서버 실행
========================= */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Channel Webhook Server Running on port ${PORT}`);
});
