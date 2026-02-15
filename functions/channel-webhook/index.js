import express from "express";
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

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
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

/* =========================
   유틸
========================= */
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
  const re = new RegExp(`${label}[:\\s]*([^\\n]+)`, "m");
  const match = text.match(re);
  if (!match) return null;
  const addr = String(match[1] || "").trim();
  return addr.length >= 6 ? addr : null;
}

function extractMoney(text, label) {
  const re = new RegExp(`\\[${label}\\]\\s*₩?([0-9,]+)`, "i");
  const m = text.match(re);
  if (!m) return null;
  return parseInt(m[1].replace(/,/g, ""), 10);
}

/**
 * ✅ payload 어디에 있든 "문자열 본문"을 최대한 찾아오는 함수
 * - 흔한 키들 우선 탐색
 * - 없으면 객체 전체를 DFS로 훑어서 길이 있는 문자열을 찾음
 */
function pickText(payload) {
  const directCandidates = [
    payload?.message,
    payload?.text,
    payload?.content,
    payload?.data?.message,
    payload?.data?.text,
    payload?.data?.content,
    payload?.event?.message,
    payload?.event?.text,
    payload?.event?.content,
    payload?.data?.event?.message,
    payload?.data?.event?.text,
    payload?.message?.text,
    payload?.message?.content,
    payload?.message?.plainText,
    payload?.message?.body,
  ]
    .filter((v) => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);

  if (directCandidates.length) return directCandidates[0];

  // DFS로 객체를 훑어서 "길이 있는 문자열" 찾기
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
        // 너무 짧거나 의미 없는 것 제외(원하면 조정)
        if (s.length >= 20 && !["https://", "http://"].some((p) => s.startsWith(p))) {
          return s;
        }
      } else if (v && typeof v === "object") {
        stack.push(v);
      }
    }
  }

  return "";
}

/**
 * messageId도 여러 후보를 훑기
 */
function extractMessageId(payload) {
  return (
    payload?.message?.id ||
    payload?.data?.message?.id ||
    payload?.event?.message?.id ||
    payload?.messageId ||
    payload?.id ||
    payload?.event_id ||
    payload?.eventId ||
    payload?.data?.eventId ||
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
    text.includes("거리") &&
    text.includes("일정") &&
    text.includes("출발지") &&
    text.includes("도착지") &&
    text.includes("예상금액") &&
    text.includes("예약금") &&
    text.includes("잔금");

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
   DB 저장 (confirmed 시점)
========================= */
async function saveConfirmedJob({ payload, text }) {
  if (!supabase) throw new Error("Supabase env missing");

  const messageId = extractMessageId(payload);

  const name = extractName(text);
  const phone = extractPhone(text);
  const fromAddress = extractAddress(text, "출발지");
  const toAddress = extractAddress(text, "도착지");

  const quoteAmount = extractMoney(text, "예상금액");
  const depositAmount = extractMoney(text, "예약금(20%)") ?? extractMoney(text, "예약금");
  const balanceAmount = extractMoney(text, "잔금(80%)") ?? extractMoney(text, "잔금");

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
    return data.id;
  } else {
    const { data, error } = await supabase.from("jobs").insert(row).select("id").single();
    if (error) throw error;
    return data.id;
  }
}

/* =========================
   웹훅 엔드포인트
========================= */
app.post("/webhook/channel", async (req, res) => {
  const payload = req.body || {};

  const text = pickText(payload);
  const status = determineStatus(text);
  const messageId = extractMessageId(payload);

  console.log("\n========================");
  console.log("📩 메시지 수신");
  console.log("status:", status);
  console.log("messageId:", messageId);
  console.log("textPreview:", text.slice(0, 120)); // 너무 길면 앞부분만

  try {
    if (status === "confirmed") {
      const jobId = await saveConfirmedJob({ payload, text });
      console.log("✅ jobs 저장 완료:", jobId);
      console.log("📌 job_events는 DB 트리거로 자동 기록됨");
    }
    res.json({ ok: true, status });
  } catch (e) {
    console.error("❌ 처리 실패:", e?.message || e);
    res.status(500).json({ ok: false, status, error: String(e?.message || e) });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Channel Webhook Server Running: http://localhost:${PORT}`);
});
