// index.js (ESM / Node 20+)
// ✅ ChannelTalk Webhook 수신 → 본문/ID 추출(해시 제외) → 모든 payload를 webhook_logs에 저장
// ✅ confirmed이면 jobs에 저장 (upsert)
// ✅ Render에서 디버깅 편하게: textPreview + messageId + status 출력

import express from "express";
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const app = express();

// ✅ Content-Type이 애매해도 body 읽기 + payload 큰 경우 대비
app.use(express.json({ limit: "2mb", type: "*/*" }));

/* =========================
   Supabase (서버 전용)
========================= */
const hasSupabaseEnv =
  !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!hasSupabaseEnv) {
  console.warn(
    "⚠️ Missing env: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Render Environment Variables에 반드시 넣어야 함."
  );
}

const supabase = hasSupabaseEnv
  ? createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    )
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

function extractPhone(text) {
  const match = text.match(/01[016789]-?\d{3,4}-?\d{4}/);
  return match ? match[0].replace(/-/g, "") : null;
}

function extractName(text) {
  const match = text.match(/이름[:\s]*([가-힣]{2,4})/);
  return match ? match[1] : null;
}

function extractAddress(text, label) {
  const safe = escapeRegExp(label);
  const re = new RegExp(`${safe}[:\\s]*([^\\n]+)`, "m");
  const match = text.match(re);
  if (!match) return null;
  const addr = String(match[1] || "").trim();
  return addr.length >= 6 ? addr : null;
}

function extractMoney(text, label) {
  const safe = escapeRegExp(label);
  const re = new RegExp(`\\[${safe}\\]\\s*₩?([0-9,]+)`, "i");
  const m = text.match(re);
  if (!m) return null;
  return parseInt(m[1].replace(/,/g, ""), 10);
}

function looksLikeIdString(s) {
  const v = String(s || "").trim();
  if (!v) return true;
  // 해시/hex/uuid/긴 토큰류 제외
  if (/^[a-f0-9]{16,}$/i.test(v)) return true;
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  )
    return true;
  // 너무 짧은 것도 제외
  if (v.length <= 3) return true;
  return false;
}

/**
 * ✅ payload에서 "본문"만 최대한 정확히 뽑기
 * - 본문 키 우선 탐색
 * - 없으면 DFS (단, id/해시처럼 보이는 문자열 제외 + 키 이름이 text 계열일 때만)
 */
function pickText(payload) {
  const preferred = [
    payload?.entity?.plainText,
    payload?.entity?.text,
    payload?.message?.plainText,
    payload?.message?.text,
    payload?.message?.content,
    payload?.data?.message?.plainText,
    payload?.data?.message?.text,
    payload?.event?.message?.plainText,
    payload?.event?.message?.text,
  ]
    .filter((v) => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v && !looksLikeIdString(v));

  if (preferred.length) return preferred[0];

  const seen = new Set();
  const stack = [payload];

  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);

    for (const [k, v] of Object.entries(cur)) {
      if (typeof v === "string") {
        const s = v.trim();
        const key = String(k).toLowerCase();
        const keyLooksText = ["text", "plaintext", "content", "body", "message"].some(
          (t) => key.includes(t)
        );

        if (keyLooksText && s.length >= 5 && !looksLikeIdString(s)) return s;
      } else if (v && typeof v === "object") {
        stack.push(v);
      }
    }
  }

  return "";
}

/**
 * ✅ messageId 후보 확장
 */
function extractMessageId(payload) {
  return (
    payload?.entity?.id ||
    payload?.entity?.messageId ||
    payload?.message?.id ||
    payload?.data?.message?.id ||
    payload?.event?.id ||
    payload?.event?.message?.id ||
    payload?.eventId ||
    payload?.messageId ||
    payload?.id ||
    payload?.event_id ||
    null
  );
}

/* =========================
   상태 판단 로직
========================= */
function determineStatus(text) {
  const hasOrder =
    text.includes("이사 방식") &&
    text.includes("차량") &&
    text.includes("일정") &&
    text.includes("출발지") &&
    text.includes("도착지");

  if (!hasOrder) return "draft";

  const hasProceed = containsKeyword(text, ["네", "진행", "그대로", "확정"]);
  const hasDeposit = containsKeyword(text, ["입금", "입금완료", "보냈어요", "송금", "이체"]);

  const phone = extractPhone(text);
  const name = extractName(text);
  const fromAddress = extractAddress(text, "출발지");
  const toAddress = extractAddress(text, "도착지");

  if (hasDeposit && name && phone && fromAddress && toAddress) return "confirmed";
  if (hasProceed) return "pending_confirm";
  return "quoted";
}

/* =========================
   DB 저장
========================= */

// ✅ 모든 웹훅을 raw로 저장 (디버깅 핵심)
// 테이블: webhook_logs (payload jsonb, text text, message_id text, status text, created_at default now())
async function saveWebhookLog({ payload, text, status }) {
  if (!supabase) return;

  const messageId = extractMessageId(payload);

  const { error } = await supabase.from("webhook_logs").insert({
    source: "channeltalk",
    message_id: messageId,
    status,
    text: text || null,
    payload,
  });

  if (error) console.warn("⚠️ webhook_logs 저장 실패:", error.message);
}

// ✅ confirmed 시점에 jobs 저장
async function saveConfirmedJob({ payload, text }) {
  if (!supabase) throw new Error("Supabase env missing");

  const messageId = extractMessageId(payload);

  const name = extractName(text);
  const phone = extractPhone(text);
  const fromAddress = extractAddress(text, "출발지");
  const toAddress = extractAddress(text, "도착지");

  const quoteAmount = extractMoney(text, "예상금액");
  const depositAmount =
    extractMoney(text, "예약금(20%)") ?? extractMoney(text, "예약금");
  const balanceAmount =
    extractMoney(text, "잔금(80%)") ?? extractMoney(text, "잔금");

  const row = {
    source: "channeltalk",
    source_message_id: messageId,

    customer_name: name,
    customer_phone: phone,
    from_address: fromAddress,
    to_address: toAddress,

    raw_text: text,
    payload,

    status: "confirmed",
    status_reason: "SafetyA: deposit+name+phone+from/to address",
    confirmed_at: new Date().toISOString(),

    quote_amount: quoteAmount,
    deposit_amount: depositAmount,
    balance_amount: balanceAmount,
  };

  if (messageId) {
    const { data, error } = await supabase
      .from("jobs")
      .upsert(row, { onConflict: "source_message_id" })
      .select("id")
      .single();
    if (error) throw error;
    return data?.id;
  }

  const { data, error } = await supabase.from("jobs").insert(row).select("id").single();
  if (error) throw error;
  return data?.id;
}

/* =========================
   엔드포인트
========================= */

// 헬스체크
app.get("/", (req, res) => {
  res.json({ ok: true, service: "ddlogi-channel-webhook", time: new Date().toISOString() });
});

// 웹훅
app.post("/webhook/channel", async (req, res) => {
  const payload = req.body || {};

  // (선택) Render 로그 과도하면 주석 처리
  // console.log("\n===== RAW PAYLOAD START =====");
  // try { console.log(JSON.stringify(payload, null, 2)); } catch { console.log(payload); }
  // console.log("===== RAW PAYLOAD END =====\n");

  const text = pickText(payload);
  const status = determineStatus(text);
  const messageId = extractMessageId(payload);

  console.log("\n========================");
  console.log("📩 메시지 수신");
  console.log("status:", status);
  console.log("messageId:", messageId);
  console.log("textPreview:", (text || "").slice(0, 220));

  try {
    // ✅ 1) 무조건 raw 저장 (여기서 payload 구조 확정 가능)
    await saveWebhookLog({ payload, text, status });

    // ✅ 2) confirmed면 jobs 저장
    if (status === "confirmed") {
      const jobId = await saveConfirmedJob({ payload, text });
      console.log("✅ jobs 저장 완료:", jobId);
    }

    res.json({ ok: true, status });
  } catch (e) {
    console.error("❌ 처리 실패:", e?.message || e);
    res.status(500).json({ ok: false, status, error: String(e?.message || e) });
  }
});

/* =========================
   서버 실행
========================= */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Channel Webhook Server Running: http://localhost:${PORT}`);
});


