import express from "express";
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "1mb" }));

/* =========================
   환경변수 체크 (정식 배포 안정장치)
========================= */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn(
    "⚠️ Missing env: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. " +
      "Render에서는 Environment Variables에 반드시 넣어야 함."
  );
}

/* =========================
   Supabase (서버 전용)
========================= */
const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

/* =========================
   헬스체크 (Render용)
========================= */
app.get("/health", (req, res) => res.status(200).send("ok"));

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
  // label: "출발지" | "도착지"
  // "출발지: ...." 라인 전체를 주소로 봄 (줄바꿈 전까지)
  const re = new RegExp(`${label}[:\\s]*([^\\n]+)`, "m");
  const match = text.match(re);
  if (!match) return null;

  const addr = String(match[1] || "").trim();
  return addr.length >= 6 ? addr : null;
}

function extractMessageId(payload) {
  // 채널톡 payload 구조 편차 대응
  return (
    payload?.message?.id ||
    payload?.messageId ||
    payload?.id ||
    payload?.event_id ||
    payload?.eventId ||
    payload?.message?.messageId ||
    null
  );
}

function extractMoney(text, label) {
  // 예: "[예상금액] ₩234,000"
  const re = new RegExp(`\\[${label}\\]\\s*₩?\\s*([0-9,]+)`, "i");
  const m = text.match(re);
  if (!m) return null;
  const n = parseInt(String(m[1]).replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function extractTextFromPayload(payload) {
  // 채널톡 실제 payload는 형태가 다양해서 우선순위로 뽑음
  // 너가 지금 쓰는 payload.message / payload.text 그대로 커버 + 보강
  return String(
    payload?.message ||
      payload?.text ||
      payload?.content ||
      payload?.event?.message ||
      payload?.event?.text ||
      ""
  );
}

/* =========================
   상태 판단 로직
   - 우선순위: confirmed > pending_confirm > quoted > draft
   - ✅ 안전장치 A: 입금완료 + 이름 + 전화 + 출발/도착 주소 완결일 때만 confirmed
   - ❌ 슬롯 중복 방지 없음(정책)
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
  const hasDeposit = containsKeyword(text, [
    "입금",
    "입금완료",
    "보냈어요",
    "송금",
    "이체",
  ]);

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
  if (!supabase) {
    throw new Error("Supabase client not initialized (missing env vars).");
  }

  const messageId = extractMessageId(payload);

  const name = extractName(text);
  const phone = extractPhone(text);
  const fromAddress = extractAddress(text, "출발지");
  const toAddress = extractAddress(text, "도착지");

  const quoteAmount = extractMoney(text, "예상금액");
  const depositAmount = extractMoney(text, "예약금");
  const balanceAmount = extractMoney(text, "잔금");

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

  // ✅ 중복 저장 방지:
  // - source_message_id가 있으면 upsert (onConflict)
  // - source_message_id가 null이면 insert (중복 가능성 있음)
  if (messageId) {
    const { data, error } = await supabase
      .from("jobs")
      .upsert(row, { onConflict: "source_message_id" })
      .select("id")
      .single();

    if (error) throw error;
    return data.id;
  } else {
    const { data, error } = await supabase
      .from("jobs")
      .insert(row)
      .select("id")
      .single();

    if (error) throw error;
    return data.id;
  }
}

/* =========================
   웹훅 엔드포인트
========================= */
app.post("/webhook/channel", async (req, res) => {
  const payload = req.body || {};
  const text = extractTextFromPayload(payload);

  const status = determineStatus(text);

  console.log("\n========================");
  console.log("📩 메시지 수신");
  console.log("status:", status);
  console.log("messageId:", extractMessageId(payload));
  console.log("textPreview:", text.slice(0, 120).replace(/\n/g, " "));

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

/* =========================
   Render 배포용 PORT 리슨
========================= */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Channel Webhook Server Running: http://localhost:${PORT}`);
});
