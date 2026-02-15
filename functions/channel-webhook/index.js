// index.js (ESM / Node 20+)
// ✅ ChannelTalk Webhook 수신 → webhook_logs 저장(항상) → chat_id 기준 누적판단 → jobs upsert
// ✅ statuses: draft / quoted / pending_confirm / confirmed / canceled
// ✅ Render 로그: aggregatedStatus / messageId / chatId / preview(마스킹)
// ✅ 포함사항(통합):
// 1) confirmed_at 최초값 보존
// 2) 입금 strong/weak 분리 + 부정문 필터
// 3) canceled 상태 추가 (취소는 예외적으로 상태 전이 허용)
// 4) 견적문 마커(DDLOGI_QUOTE_V1) 지원 + 기존 키워드 fallback
// 5) person_type 엄격 분리(user/bot만 판정), others는 판정 제외
// 6) 최신값 우선 추출(로그 최신→과거 스캔)
// 7) messageId 중복 저장 방지(서버단 멱등, + DB unique 있으면 더 좋음)
// 8) 웹훅 보호 토큰 헤더(X-DDLOGI-TOKEN) 검증 (env: DDLOGI_WEBHOOK_TOKEN)
// 9) 로그 출력 마스킹(전화번호)
// 10) (선택) DB unique(message_id) 있으면 insert 충돌에도 안전하도록 서버단 멱등 처리
// 11) hasQuote 보강: limit 확장(기본 120) + 견적문이 앞에 있어도 인식
// 12) 상태 전이 정책: downgrade 방지 + canceled 예외 처리

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
   Webhook 보호 토큰 (권장)
   - ChannelTalk에서 Webhook 헤더에 X-DDLOGI-TOKEN을 넣는 방식
   - Render env: DDLOGI_WEBHOOK_TOKEN
========================= */
const WEBHOOK_TOKEN = process.env.DDLOGI_WEBHOOK_TOKEN || "";

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

function maskPhoneInText(text) {
  const t = String(text || "");
  // 01012345678 → 010****5678 / 010-1234-5678 → 010-****-5678
  return t.replace(/01[016789][\s-]?\d{3,4}[\s-]?\d{4}/g, (m) => {
    const digits = m.replace(/[\s-]/g, "");
    if (digits.length === 11) return digits.slice(0, 3) + "****" + digits.slice(7);
    if (digits.length === 10) return digits.slice(0, 3) + "***" + digits.slice(6);
    return "01*********";
  });
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
  return payload?.entity?.personType || null; // "user" | "bot" | ...
}

/* =========================
   Quote block detection
   - 4) 마커 우선: DDLOGI_QUOTE_V1
   - fallback: 기존 키워드 조합
========================= */
const QUOTE_MARKER = "DDLOGI_QUOTE_V1";
function isQuoteBlock(text) {
  const t = String(text || "");
  if (t.includes(QUOTE_MARKER)) return true;
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
   - canceled는 "예외 처리"로 전이 허용(아래 로직에서 처리)
========================= */
function getStatusPriority(status) {
  const map = {
    draft: 0,
    quoted: 1,
    pending_confirm: 2,
    confirmed: 3,
    // canceled는 우선순위로만 다루면 애매해서(confirmed 후 취소),
    // 다운그레이드 비교에서는 별도로 처리
    canceled: 2, // 참고값(실제는 예외 처리)
  };
  return map[status] ?? 0;
}

/* =========================
   최신값 우선 추출 (logs 최신→과거 스캔)
   - user/bot만 대상으로 값 추출
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
    // 입금/진행 의사(강도)
    hasDepositWeak: false,
    hasDepositStrong: false,
    hasProceed: false,
    // 부정/취소
    negDeposit: false,
    negProceed: false,
    hasCancel: false,
  };

  // 취소/보류 키워드(정책)
  const cancelKeywords = ["취소", "취소할게", "취소하겠", "취소합니다", "예약 취소", "진행 취소"];
  const proceedKeywords = ["그대로 진행", "네 진행", "진행할게요", "진행하겠습니다", "확정", "예약", "진행 부탁", "부탁드립니다"];
  const proceedNegKeywords = ["취소", "보류", "잠시", "다음에", "나중에", "진행 안", "안 할", "중단"];

  // 입금 strong/weak + 부정문
  const depositStrong = ["입금완료", "입금 완료", "송금완료", "송금 완료", "이체완료", "이체 완료", "보냈어요", "보냈습니다", "송금했", "이체했"];
  const depositWeak = ["입금", "송금", "이체", "보낼게요", "입금할게요", "입금 예정", "송금 예정", "이체 예정"];
  const depositNeg = ["미입금", "입금 전", "입금전", "아직 입금", "아직 안", "안 했", "못했", "보류", "나중에 입금", "입금 못", "입금 안"];

  // 최신→과거
  for (const row of logs) {
    const pt = row.person_type;
    const txt = String(row.plain_text || row.text || "").trim();
    if (!txt) continue;

    // 견적문은 bot에서 주로 오지만, 혹시 몰라 bot/user 둘 다 체크
    if (!latest.hasQuote && (pt === "bot" || pt === "user") && isQuoteBlock(txt)) {
      latest.hasQuote = true;
    }

    // 금액은 bot 텍스트에서 우선 추출(최신 견적문이 있으면 그걸 쓰게)
    if (pt === "bot") {
      if (latest.quoteAmount == null) {
        const v = extractMoney(txt, "예상금액");
        if (v != null) latest.quoteAmount = v;
      }
      if (latest.depositAmount == null) {
        const v = extractMoney(txt, "예약금(20%)") ?? extractMoney(txt, "예약금");
        if (v != null) latest.depositAmount = v;
      }
      if (latest.balanceAmount == null) {
        const v = extractMoney(txt, "잔금(80%)") ?? extractMoney(txt, "잔금");
        if (v != null) latest.balanceAmount = v;
      }
    }

    // 고객 의사/정보는 user에서만 판정(상담사/어드민 섞이는 거 방지)
    if (pt !== "user") continue;

    // 취소 의사
    if (!latest.hasCancel && containsKeyword(txt, cancelKeywords)) latest.hasCancel = true;

    // 진행 의사
    if (!latest.hasProceed && containsKeyword(txt, proceedKeywords)) latest.hasProceed = true;
    if (!latest.negProceed && containsKeyword(txt, proceedNegKeywords)) latest.negProceed = true;

    // 입금 의사 strong/weak + 부정
    if (!latest.hasDepositStrong && containsKeyword(txt, depositStrong)) latest.hasDepositStrong = true;
    if (!latest.hasDepositWeak && containsKeyword(txt, depositWeak)) latest.hasDepositWeak = true;
    if (!latest.negDeposit && containsKeyword(txt, depositNeg)) latest.negDeposit = true;

    // 전화/이름/주소: 최신값 우선(처음 발견한 값이 최신)
    if (!latest.phone) {
      const p = normalizePhone(txt);
      if (p) latest.phone = p;
    }
    if (!latest.name) {
      const n = extractName(txt);
      if (n) latest.name = n;
    }

    if (!latest.fromAddress || !latest.toAddress) {
      const fromLabel = extractAddressLine(txt, "출발지");
      const toLabel = extractAddressLine(txt, "도착지");
      const loose = extractFromToLoose(txt);

      if (!latest.fromAddress) latest.fromAddress = fromLabel || loose.from || null;
      if (!latest.toAddress) latest.toAddress = toLabel || loose.to || null;
    }

    // 충분히 다 모였으면 조기 종료(성능)
    if (
      latest.phone &&
      latest.fromAddress &&
      latest.toAddress &&
      latest.hasQuote &&
      (latest.hasDepositStrong || latest.hasProceed || latest.hasCancel)
    ) {
      // 그래도 부정문/금액은 더 앞에서 올 수 있으니 완전 break는 안 함
      // 하지만 대화가 길 경우 이게 효율적이어서 여기선 종료
      break;
    }
  }

  return latest;
}

/* =========================
   누적판단: chat_id 기준 최근 로그를 합쳐 상태 결정
========================= */
function aggregateFromLogs(logs) {
  // 5) person_type 엄격 분리: 판정은 bot/user만
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

  // 6) 최신값 우선 facts
  const facts = extractLatestFactsFromLogs(logs);

  const phone = facts.phone || normalizePhone(allUser) || null;
  const name = facts.name || extractName(allUser) || null;
  const fromAddress = facts.fromAddress || extractAddressLine(allUser, "출발지") || extractFromToLoose(allUser).from || null;
  const toAddress = facts.toAddress || extractAddressLine(allUser, "도착지") || extractFromToLoose(allUser).to || null;

  const hasQuote = facts.hasQuote || botTexts.some((t) => isQuoteBlock(t));

  // 금액은 bot에서 우선
  const quoteAmount = facts.quoteAmount ?? extractMoney(allBot, "예상금액");
  const depositAmount = facts.depositAmount ?? (extractMoney(allBot, "예약금(20%)") ?? extractMoney(allBot, "예약금"));
  const balanceAmount = facts.balanceAmount ?? (extractMoney(allBot, "잔금(80%)") ?? extractMoney(allBot, "잔금"));

  // 2) 입금 strong/weak + 부정문 필터
  const hasDepositStrong = facts.hasDepositStrong && !facts.negDeposit;
  const hasDepositWeak = facts.hasDepositWeak && !facts.negDeposit;

  // 진행 의사 + 부정문 필터
  const hasProceed = facts.hasProceed && !facts.negProceed;

  // 3) 취소(부정/보류보다 강함)
  const hasCancel = facts.hasCancel;

  // ✅ 상태 규칙
  // 0) 견적문 없으면 draft
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

  // 3) 취소는 예외 상태(견적문이 있는 채팅에서 취소 의사면 canceled)
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

  // 1) confirmed: 입금 "완료형(Strong)" + 전화 + 출/도착
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

  // 2) pending_confirm: 진행 의사 OR 입금 약한 의사(예정/할게요)
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

  // 3) quoted
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

// 7) messageId 중복 저장 방지: 서버단 멱등(있으면 skip)
async function webhookLogExists(messageId) {
  if (!supabase || !messageId) return false;
  const { data, error } = await supabase
    .from("webhook_logs")
    .select("id")
    .eq("message_id", messageId)
    .limit(1);

  if (error) return false;
  return (data || []).length > 0;
}

// webhook_logs 저장
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

  // 중복 방지(서버단)
  if (messageId) {
    const exists = await webhookLogExists(messageId);
    if (exists) return;
  }

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

// 11) 견적문이 앞쪽에 있어도 인식되게 limit 확장(기본 120)
async function fetchRecentLogsByChatId(chatId, limit = 120) {
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

async function getExistingJob(chatId) {
  if (!supabase || !chatId) return null;

  const { data, error } = await supabase
    .from("jobs")
    .select("id, status, confirmed_at")
    .eq("chat_id", chatId)
    .maybeSingle();

  if (error) {
    console.warn("⚠️ 기존 job 조회 실패:", error.message);
    return null;
  }
  return data || null;
}

// jobs upsert
async function upsertJobByChat({ chatId, lastPayload, lastMessageId, agg, mergedText, existingJob }) {
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

  // 1) confirmed_at 최초값 보존
  // - 기존 confirmed_at이 있으면 유지
  // - 없다면 confirmed 전이 순간에만 기록
  if (agg.status === "confirmed") {
    if (existingJob?.confirmed_at) {
      row.confirmed_at = existingJob.confirmed_at;
    } else {
      row.confirmed_at = new Date().toISOString();
    }
  } else {
    // 이미 confirmed였던 건이 다른 상태로 바뀌어도(취소 포함),
    // confirmed_at은 유지(운영상 추적용)
    if (existingJob?.confirmed_at) row.confirmed_at = existingJob.confirmed_at;
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
  // 8) 웹훅 보호 토큰
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
  // 9) 로그 마스킹
  console.log("textPreview:", maskPhoneInText(String(plainText || "").slice(0, 180)));

  try {
    // 7) 무조건 webhook_logs 저장(중복이면 skip)
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

    // 11) chat_id 기준 최근 로그 조회(기본 120) → 누적판단
    const logs = await fetchRecentLogsByChatId(chatId, 120);
    const agg = aggregateFromLogs(logs);

    // 기존 job 조회
    const existingJob = await getExistingJob(chatId);
    const existingStatus = existingJob?.status || null;

    // 12) 상태 전이 정책
    // - downgrade 방지: 기존이 더 높은 상태면 유지
    // - 단, canceled는 예외로 허용(취소 의사 오면 취소로 전이 가능)
    if (
      agg.status !== "canceled" &&
      existingStatus &&
      getStatusPriority(existingStatus) > getStatusPriority(agg.status)
    ) {
      console.log("⛔ status downgrade blocked:", existingStatus, "→", agg.status);
      agg.status = existingStatus;
      agg.reason = "status_downgrade_blocked";
    }

    // canceled 예외: confirmed에서 canceled로 가는 건 허용
    if (agg.status === "canceled" && existingStatus === "confirmed") {
      agg.reason = "canceled_after_confirmed";
    }

    // jobs upsert: draft는 생성/업데이트 하지 않음
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
        existingJob,
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
