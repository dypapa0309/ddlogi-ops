// apps/admin/app.js
const $ = (id) => document.getElementById(id);

const LS_BASE = "ddlogi_admin_base";

let ACCESS_TOKEN = ""; // ✅ Supabase 세션에서 자동으로 채워짐

function setStatus(msg, ok = true) {
  const el = $("statusText");
  if (!el) return;
  el.textContent = msg;
  el.className = "mono " + (ok ? "ok" : "bad");
}

function loadSavedBase() {
  const baseEl = $("baseUrl");
  if (!baseEl) return;

  const base = localStorage.getItem(LS_BASE) || baseEl.value.trim();
  baseEl.value = base;
}

function saveBase() {
  const baseEl = $("baseUrl");
  if (!baseEl) return;

  const base = baseEl.value.trim().replace(/\/+$/, "");
  if (!base) return setStatus("Base URL이 비었습니다", false);

  localStorage.setItem(LS_BASE, base);
  setStatus("Base URL 저장됨", true);
}

function getBase() {
  const baseEl = $("baseUrl");
  const base = (baseEl?.value || "").trim().replace(/\/+$/, "");
  return base;
}

async function apiGet(path) {
  const base = getBase();
  if (!base) throw new Error("Base URL empty");
  if (!ACCESS_TOKEN) throw new Error("No session token. 로그인 상태 확인 필요");

  const url = base + path;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": "Bearer " + ACCESS_TOKEN,
      "Content-Type": "application/json",
    },
    credentials: "omit",
  });

  if (res.status === 401) {
    throw new Error("401 Unauthorized (로그인/토큰 만료)");
  }
  if (res.status === 403) {
    // 서버에서 role=admin 체크/Origin 체크에 걸릴 때
    throw new Error("403 Forbidden (관리자 권한/허용 Origin 확인)");
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText} ${txt}`.trim());
  }
  return res.json();
}

function fmtMoney(n) {
  if (n == null) return "-";
  try {
    return Number(n).toLocaleString("ko-KR");
  } catch {
    return String(n);
  }
}

function td(text, cls = "") {
  const el = document.createElement("td");
  el.textContent = text;
  if (cls) el.className = cls;
  return el;
}

function pill(status) {
  const span = document.createElement("span");
  span.className = "pill";
  span.textContent = status || "-";
  return span;
}

async function refresh() {
  try {
    setStatus("불러오는 중…", true);

    // base url 바뀌었을 수 있으니 저장
    saveBase();

    const limit = $("limit").value;
    const status = $("statusFilter").value;

    const qs = new URLSearchParams();
    qs.set("limit", limit);
    if (status) qs.set("status", status);

    const json = await apiGet(`/jobs?${qs.toString()}`);

    $("count").textContent = String(json?.count ?? 0);

    const tbody = $("tbody");
    tbody.innerHTML = "";

    (json.data || []).forEach((row) => {
      const tr = document.createElement("tr");

      tr.appendChild(td(row.updated_at || "-", "mono"));

      const s = document.createElement("td");
      s.appendChild(pill(row.status));
      tr.appendChild(s);

      const chatTd = document.createElement("td");
      chatTd.textContent = row.chat_id || "-";
      chatTd.className = "mono click";
      chatTd.title = "클릭해서 상세 조회";
      chatTd.onclick = () => openDetail(row.chat_id);
      tr.appendChild(chatTd);

      tr.appendChild(td(`${row.from_address || "-"} → ${row.to_address || "-"}`));
      tr.appendChild(
        td(
          `Q:${fmtMoney(row.quote_amount)} / D:${fmtMoney(row.deposit_amount)} / B:${fmtMoney(row.balance_amount)}`,
          "mono"
        )
      );
      tr.appendChild(td(row.confirmed_at || "-", "mono"));

      tbody.appendChild(tr);
    });

    setStatus("OK (200)", true);
  } catch (e) {
    setStatus(e.message || String(e), false);
  }
}

async function openDetail(chatId) {
  try {
    if (!chatId) return;
    setStatus(`상세 조회 중… (${chatId})`, true);
    const json = await apiGet(`/jobs/${encodeURIComponent(chatId)}`);
    $("detail").textContent = JSON.stringify(json.data || json, null, 2);
    $("detailCard").style.display = "block";
    setStatus("상세 OK", true);
  } catch (e) {
    setStatus(e.message || String(e), false);
  }
}

function closeDetail() {
  $("detailCard").style.display = "none";
  $("detail").textContent = "";
}

(async function boot() {
  try {
    setStatus("로그인/권한 확인 중…", true);

    // ✅ shared/auth.js가 제공하는 가드 사용 (admin만 통과)
    const ctx = await window.DDLOGI_AUTH.requireRole("admin");
    if (!ctx) return; // 가드가 알아서 로그인 페이지로 보냄

    ACCESS_TOKEN = ctx.session.access_token;

    loadSavedBase();

    // 이벤트 바인딩
    $("refreshBtn").addEventListener("click", refresh);
    $("closeDetail").addEventListener("click", closeDetail);

    setStatus("준비 완료. 새로고침을 누르세요", true);
  } catch (e) {
    setStatus(e.message || String(e), false);
  }
})();
