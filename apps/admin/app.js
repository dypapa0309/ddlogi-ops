// /apps/admin/app.js
const $ = (id) => document.getElementById(id);

const LS_BASE = "ddlogi_admin_base";
const LS_ADMIN_TOKEN = "ddlogi_admin_api_token";

let ACTIVE_TAB = "all";
let RAW = [];
let VIEW = [];

// ------------------------------
// UI 매핑
// ------------------------------
const STATUS_LABEL = {
  draft: "접수중",
  quoted: "견적완료",
  pending_confirm: "예약대기",
  confirmed: "예약확정",
  canceled: "취소",
};

function statusBadge(status) {
  const s = status || "draft";
  const el = document.createElement("span");
  el.className =
    "badge " +
    (s === "quoted"
      ? "badge-quoted"
      : s === "pending_confirm"
      ? "badge-pending"
      : s === "confirmed"
      ? "badge-confirmed"
      : s === "canceled"
      ? "badge-canceled"
      : "badge-draft");
  el.textContent = STATUS_LABEL[s] || s;
  return el;
}

function setConn(ok, text) {
  const pill = $("connPill");
  if (!pill) return;
  pill.textContent = text || (ok ? "연결됨" : "연결 끊김");
  pill.className = "pill " + (ok ? "pill-ok" : "pill-bad");
}

function setStatus(msg, ok = true) {
  const el = $("statusText");
  if (!el) return;
  el.textContent = msg;
  el.className = "mono " + (ok ? "ok" : "bad");
}

function showAuthHelp(html) {
  const box = $("authHelp");
  if (!box) return;
  box.style.display = "block";
  box.innerHTML = html;
}

// ------------------------------
// Base URL 설정
// ------------------------------
function normalizeBase(str) {
  return String(str || "").trim().replace(/\/+$/, "");
}

function loadSavedBase() {
  const el = $("baseUrl");
  if (!el) return;
  const def = (window.DDLOGI_CONFIG?.apiBaseDefault || el.value || "").trim();
  const base = localStorage.getItem(LS_BASE) || def;
  el.value = normalizeBase(base);
}

function saveBase() {
  const el = $("baseUrl");
  if (!el) return;
  const base = normalizeBase(el.value);
  if (!base) return setStatus("Base URL이 비었습니다", false);
  localStorage.setItem(LS_BASE, base);
  return base;
}

function resetBase() {
  const el = $("baseUrl");
  if (!el) return;
  el.value = window.DDLOGI_CONFIG?.apiBaseDefault || "https://ddlogi-ops.onrender.com";
  saveBase();
}

function getBase() {
  return normalizeBase($("baseUrl")?.value);
}

// ------------------------------
// ADMIN_API_TOKEN 설정
// ------------------------------
function loadSavedAdminToken() {
  const el = $("adminToken");
  if (!el) return;
  el.value = localStorage.getItem(LS_ADMIN_TOKEN) || "";
}

function getAdminApiToken() {
  return (localStorage.getItem(LS_ADMIN_TOKEN) || "").trim();
}

// ------------------------------
// API (Render /jobs는 ADMIN_API_TOKEN로 인증)
// ------------------------------
async function apiGet(path) {
  const base = getBase();
  if (!base) throw new Error("Base URL empty");

  const adminToken = getAdminApiToken();
  if (!adminToken) throw new Error("ADMIN_API_TOKEN이 없습니다. 설정(⚙️)에서 입력 후 저장하세요.");

  const res = await fetch(base + path, {
    method: "GET",
    headers: {
      "Authorization": "Bearer " + adminToken,
      "Content-Type": "application/json",
    },
    credentials: "omit",
  });

  if (res.status === 401) throw new Error("401 (ADMIN_API_TOKEN 불일치)");
  if (res.status === 403) throw new Error("403 (CORS/허용 Origin 확인: ADMIN_ALLOWED_ORIGINS)");

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText} ${txt}`.trim());
  }
  return res.json();
}

// ------------------------------
// 포맷터
// ------------------------------
function fmtMoney(n) {
  if (n == null) return "-";
  const num = Number(n);
  if (Number.isNaN(num)) return String(n);
  return num.toLocaleString("ko-KR") + "원";
}

function maskPhone(s) {
  const t = String(s || "").replace(/\s+/g, "");
  const m = t.match(/(01[016789])[-]?(\d{3,4})[-]?(\d{4})/);
  if (!m) return s || "-";
  return `${m[1]}-${m[2][0]}***-${m[3]}`;
}

function relTime(iso) {
  if (!iso) return "-";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "-";
  const diff = Date.now() - ts;

  const sec = Math.floor(diff / 1000);
  if (sec < 10) return "방금";
  if (sec < 60) return `${sec}초 전`;

  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;

  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;

  const day = Math.floor(hr / 24);
  return `${day}일 전`;
}

function fmtSchedule(row) {
  const date = row?.move_date || row?.date || row?.schedule_date || row?.reserved_date || "";
  const time = row?.time_slot_label || row?.time_slot || row?.reserved_time || row?.move_time || "";
  if (!date && !time) return "-";
  return `${date || ""} ${time || ""}`.trim();
}

function routeText(row) {
  const from = row?.from_address || row?.from || "-";
  const to = row?.to_address || row?.to || "-";
  return `${from} → ${to}`;
}

function optionsText(row) {
  const parts = [];

  const box = row?.box_count || row?.boxes || row?.box_range || row?.items_box || "";
  if (box) parts.push(`박스: ${box}`);

  const throwUsed = row?.throw_used ?? row?.throw ?? row?.trash ?? "";
  if (throwUsed !== "" && throwUsed != null) {
    const v = String(throwUsed).toLowerCase();
    if (v === "true" || v === "1" || v === "yes" || v === "사용") parts.push("버려주세요: 사용");
    else if (v === "false" || v === "0" || v === "no" || v === "미사용") parts.push("버려주세요: 미사용");
  }

  const workFrom = row?.work_from ?? row?.from_work ?? row?.from_help ?? "";
  const workTo = row?.work_to ?? row?.to_work ?? row?.to_help ?? "";
  if (workFrom || workTo) parts.push(`작업: 출발(${workFrom || "-"}) / 도착(${workTo || "-"})`);

  const appliances = row?.appliances || row?.items_appliances || "";
  const furn = row?.furniture || row?.items_furniture || "";
  const sum = row?.items_summary || row?.items || "";
  if (sum) parts.push(`품목: ${sum}`);
  else {
    if (appliances) parts.push(`가전: ${appliances}`);
    if (furn) parts.push(`가구: ${furn}`);
  }

  return parts.length ? parts.join(" · ") : "-";
}

function moneyText(row) {
  return `총액 ${fmtMoney(row?.quote_amount)}  /  예약금 ${fmtMoney(row?.deposit_amount)}  /  잔금 ${fmtMoney(row?.balance_amount)}`;
}

function matchesQuery(row, q) {
  if (!q) return true;
  const hay = [
    row?.customer_name,
    row?.name,
    row?.phone,
    row?.customer_phone,
    row?.from_address,
    row?.to_address,
    row?.items_summary,
    row?.memo,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return hay.includes(q.toLowerCase());
}

function isTodayByRow(row) {
  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, "0");
  const d = String(today.getDate()).padStart(2, "0");
  const todayStr = `${y}-${m}-${d}`;

  const date = row?.move_date || row?.date || row?.schedule_date || row?.reserved_date || "";
  if (!date) return false;
  return String(date).startsWith(todayStr);
}

function sortRows(rows) {
  const mode = $("sort")?.value || "updated_desc";
  const cloned = [...rows];

  if (mode === "schedule_asc") {
    cloned.sort((a, b) => {
      const ad = Date.parse((a?.move_date || a?.date || a?.schedule_date || a?.reserved_date || "") + " " + (a?.time_slot || a?.reserved_time || ""));
      const bd = Date.parse((b?.move_date || b?.date || b?.schedule_date || b?.reserved_date || "") + " " + (b?.time_slot || b?.reserved_time || ""));
      if (Number.isNaN(ad) && Number.isNaN(bd)) return 0;
      if (Number.isNaN(ad)) return 1;
      if (Number.isNaN(bd)) return -1;
      return ad - bd;
    });
    return cloned;
  }

  cloned.sort((a, b) => {
    const at = Date.parse(a?.updated_at || a?.created_at || "");
    const bt = Date.parse(b?.updated_at || b?.created_at || "");
    return (Number.isNaN(bt) ? 0 : bt) - (Number.isNaN(at) ? 0 : at);
  });
  return cloned;
}

// ------------------------------
// 렌더
// ------------------------------
function setKpi(rows) {
  const todayMode = $("dateFilter")?.value !== "all";
  const base = todayMode ? rows.filter(isTodayByRow) : rows;

  const by = (s) => base.filter((r) => (r?.status || "draft") === s).length;

  $("kpiConfirmed").textContent = String(by("confirmed"));
  $("kpiPending").textContent = String(by("pending_confirm"));
  $("kpiQuoted").textContent = String(by("quoted"));
  $("kpiCanceled").textContent = String(by("canceled"));
}

function renderTable(rows) {
  const tbody = $("tbody");
  tbody.innerHTML = "";

  $("count").textContent = String(rows.length);

  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 7;
    td.className = "muted";
    td.style.padding = "18px 14px";
    td.textContent = "표시할 항목이 없습니다.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  rows.forEach((row) => {
    const tr = document.createElement("tr");

    const sTd = document.createElement("td");
    sTd.appendChild(statusBadge(row.status));
    tr.appendChild(sTd);

    const schTd = document.createElement("td");
    schTd.innerHTML = `<div>${fmtSchedule(row)}</div><div class="small">${row?.confirmed_at ? "확정: " + String(row.confirmed_at).slice(0,16).replace("T"," ") : ""}</div>`;
    tr.appendChild(schTd);

    const cTd = document.createElement("td");
    const nm = row?.customer_name || row?.name || "-";
    const ph = maskPhone(row?.phone || row?.customer_phone || "");
    cTd.innerHTML = `<div><b>${nm}</b></div><div class="small">${ph || "-"}</div>`;
    tr.appendChild(cTd);

    const rTd = document.createElement("td");
    rTd.textContent = routeText(row);
    tr.appendChild(rTd);

    const oTd = document.createElement("td");
    oTd.textContent = optionsText(row);
    tr.appendChild(oTd);

    const mTd = document.createElement("td");
    mTd.className = "mono";
    mTd.textContent = moneyText(row);
    tr.appendChild(mTd);

    const uTd = document.createElement("td");
    uTd.className = "small";
    uTd.textContent = relTime(row?.updated_at || row?.created_at);
    tr.appendChild(uTd);

    tr.onclick = () => openDetail(row);
    tbody.appendChild(tr);
  });
}

function applyView() {
  const q = ($("q")?.value || "").trim();
  const dateMode = $("dateFilter")?.value || "today";

  let rows = [...RAW];

  if (ACTIVE_TAB !== "all") {
    rows = rows.filter((r) => (r?.status || "draft") === ACTIVE_TAB);
  }

  if (dateMode !== "all") {
    rows = rows.filter(isTodayByRow);
  }

  if (q) rows = rows.filter((r) => matchesQuery(r, q));

  rows = sortRows(rows);

  VIEW = rows;

  setKpi(RAW);
  renderTable(VIEW);
}

// ------------------------------
// Drawer
// ------------------------------
function openDrawer(id) {
  const el = $(id);
  el.classList.add("is-open");
  el.setAttribute("aria-hidden", "false");
}
function closeDrawer(id) {
  const el = $(id);
  el.classList.remove("is-open");
  el.setAttribute("aria-hidden", "true");
}

function openDetail(row) {
  const chatId = row?.chat_id || row?.chatId || row?.id || "-";
  $("drawerSub").textContent = `내부 ID: ${chatId}`;

  $("dStatus").textContent = STATUS_LABEL[row?.status] || row?.status || "-";
  $("dSchedule").textContent = fmtSchedule(row);

  const nm = row?.customer_name || row?.name || "-";
  const ph = maskPhone(row?.phone || row?.customer_phone || "");
  $("dCustomer").textContent = `${nm} (${ph || "-"})`;

  $("dRoute").textContent = routeText(row);
  $("dOptions").textContent = optionsText(row);
  $("dMoney").textContent = moneyText(row);

  $("dJson").textContent = JSON.stringify(row, null, 2);
  openDrawer("drawer");

  if (row?.chat_id) {
    apiGet(`/jobs/${encodeURIComponent(row.chat_id)}`)
      .then((json) => {
        const data = json?.data || json;
        $("dJson").textContent = JSON.stringify(data, null, 2);
      })
      .catch(() => {});
  }
}

// ------------------------------
// 데이터 로드
// ------------------------------
async function refresh() {
  try {
    setStatus("불러오는 중…", true);

    const limit = $("limit")?.value || "50";
    const tabStatus = ACTIVE_TAB === "all" ? "" : ACTIVE_TAB;

    const qs = new URLSearchParams();
    qs.set("limit", limit);
    if (tabStatus) qs.set("status", tabStatus);

    const json = await apiGet(`/jobs?${qs.toString()}`);

    RAW = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
    setConn(true, "연결됨");
    setStatus("OK", true);

    $("diag").textContent = `rows=${RAW.length} / tab=${ACTIVE_TAB} / base=${getBase()} / token=${getAdminApiToken() ? "saved" : "empty"}`;

    applyView();
  } catch (e) {
    setConn(false, "연결 끊김");
    setStatus(e.message || String(e), false);
  }
}

// ------------------------------
// 탭/이벤트
// ------------------------------
function setActiveTab(tab) {
  ACTIVE_TAB = tab;

  document.querySelectorAll(".tab").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.tab === tab);
  });

  refresh();
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach((b) => {
    b.addEventListener("click", () => setActiveTab(b.dataset.tab));
  });

  $("q")?.addEventListener("input", () => applyView());
  $("dateFilter")?.addEventListener("change", () => applyView());
  $("sort")?.addEventListener("change", () => applyView());
  $("limit")?.addEventListener("change", () => refresh());

  $("btnRefresh")?.addEventListener("click", refresh);

  $("drawerClose")?.addEventListener("click", () => closeDrawer("drawer"));
  $("drawerBack")?.addEventListener("click", () => closeDrawer("drawer"));

  $("btnSettings")?.addEventListener("click", () => openDrawer("settings"));
  $("settingsClose")?.addEventListener("click", () => closeDrawer("settings"));
  $("settingsBack")?.addEventListener("click", () => closeDrawer("settings"));

  $("btnSaveBase")?.addEventListener("click", () => {
    saveBase();
    $("diag").textContent = `base=${getBase()} / token=${getAdminApiToken() ? "saved" : "empty"}`;
    setStatus("Base URL 저장됨", true);
  });

  $("btnResetBase")?.addEventListener("click", () => {
    resetBase();
    $("diag").textContent = `base=${getBase()} / token=${getAdminApiToken() ? "saved" : "empty"}`;
    setStatus("Base URL 기본값으로 복원", true);
  });

  // ✅ ADMIN_API_TOKEN 저장/삭제
  $("btnSaveAdminToken")?.addEventListener("click", () => {
    const v = ($("adminToken")?.value || "").trim();
    if (!v) return setStatus("ADMIN_API_TOKEN이 비었습니다", false);
    localStorage.setItem(LS_ADMIN_TOKEN, v);
    $("diag").textContent = `base=${getBase()} / token=saved`;
    setStatus("ADMIN_API_TOKEN 저장됨", true);
  });

  $("btnClearAdminToken")?.addEventListener("click", () => {
    localStorage.removeItem(LS_ADMIN_TOKEN);
    if ($("adminToken")) $("adminToken").value = "";
    $("diag").textContent = `base=${getBase()} / token=empty`;
    setStatus("ADMIN_API_TOKEN 삭제됨", true);
  });
}

// ------------------------------
// Boot
// ------------------------------
(async function boot() {
  try {
    setConn(false, "연결 확인중");
    setStatus("로그인/권한 확인 중…", true);

    loadSavedBase();
    loadSavedAdminToken();
    bindEvents();

    // ✅ shared/auth.js 로드 확인
    if (!window.DDLOGI_AUTH || typeof window.DDLOGI_AUTH.getSession !== "function") {
      showAuthHelp(
        `auth.js 로드에 실패했어요.<br/>
         1) <b>/shared/auth.js</b>가 실제로 존재하는지 확인<br/>
         2) index.html 스크립트 경로가 <b>/shared/auth.js</b>인지 확인`
      );
      setStatus("auth.js 미로드 (DDLOGI_AUTH 없음)", false);
      return;
    }

    // ✅ 세션 없으면(=Supabase 로그인 안됨) auth 앱으로 보내는 구조라면 여기서 이동
    // 지금은 '문지기' 역할만: 세션 없으면 안내만
    const session = await window.DDLOGI_AUTH.getSession();
    if (!session) {
      setStatus("Supabase 로그인 필요 (auth 앱에서 로그인 후 재접속)", false);
      // 필요하면 여기서 이동:
      // location.href = "/apps/auth/?next=/apps/admin/";
      return;
    }

    // ✅ admin role 체크(문지기)
    const ctx = await window.DDLOGI_AUTH.requireRole("admin");
    if (!ctx) {
      setStatus("관리자 권한이 아닙니다 (profiles.role 확인)", false);
      return;
    }

    // ✅ 실제 API 호출은 ADMIN_API_TOKEN이 담당
    if (!getAdminApiToken()) {
      setStatus("⚙️ 설정에서 ADMIN_API_TOKEN 저장 후 사용하세요", false);
      return;
    }

    $("diag").textContent = `ready / base=${getBase()} / token=saved`;
    setStatus("준비 완료", true);

    await refresh();
  } catch (e) {
    setConn(false, "연결 끊김");
    setStatus(e.message || String(e), false);
  }
})();
