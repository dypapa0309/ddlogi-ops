
const $ = (id) => document.getElementById(id);

const LS_BASE = "ddlogi_admin_base";
let ACCESS_TOKEN = "";
let ACTIVE_TAB = "all";
let RAW = [];      // 서버에서 받은 원본 목록
let VIEW = [];     // 화면에 보여줄 가공 목록

// ------------------------------
// UI 매핑 (사람 용어)
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
// Base URL 설정 (설정 drawer 안에 숨김)
// ------------------------------
function loadSavedBase() {
  const el = $("baseUrl");
  if (!el) return;
  const base = localStorage.getItem(LS_BASE) || el.value.trim();
  el.value = base;
}

function normalizeBase(str) {
  return String(str || "").trim().replace(/\/+$/, "");
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
  el.value = "https://ddlogi-ops.onrender.com";
  saveBase();
}

function getBase() {
  const el = $("baseUrl");
  return normalizeBase(el?.value);
}

// ------------------------------
// API
// ------------------------------
async function apiGet(path) {
  const base = getBase();
  if (!base) throw new Error("Base URL empty");
  if (!ACCESS_TOKEN) throw new Error("No session token. 로그인 상태 확인 필요");

  const res = await fetch(base + path, {
    method: "GET",
    headers: {
      "Authorization": "Bearer " + ACCESS_TOKEN,
      "Content-Type": "application/json",
    },
    credentials: "omit",
  });

  if (res.status === 401) throw new Error("401 (로그인/토큰 만료)");
  if (res.status === 403) throw new Error("403 (관리자 권한/허용 Origin 확인)");

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
  // 01012341234 / 010-1234-1234 형태 대충 커버
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
  // 너 DB 필드가 아직 확정 전이라 가능한 후보를 넓게 잡음
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
  // 아직 필드가 유동적이라 후보형으로 모아줌 (없으면 -)
  const parts = [];

  // 박스/짐양
  const box = row?.box_count || row?.boxes || row?.box_range || row?.items_box || "";
  if (box) parts.push(`박스: ${box}`);

  // 버려주세요
  const throwUsed = row?.throw_used ?? row?.throw ?? row?.trash ?? "";
  if (throwUsed !== "" && throwUsed != null) {
    const v = String(throwUsed).toLowerCase();
    if (v === "true" || v === "1" || v === "yes" || v === "사용") parts.push("버려주세요: 사용");
    else if (v === "false" || v === "0" || v === "no" || v === "미사용") parts.push("버려주세요: 미사용");
  }

  // 작업(상하차 도움)
  const workFrom = row?.work_from ?? row?.from_work ?? row?.from_help ?? "";
  const workTo = row?.work_to ?? row?.to_work ?? row?.to_help ?? "";
  if (workFrom || workTo) parts.push(`작업: 출발(${workFrom || "-"}) / 도착(${workTo || "-"})`);

  // 가전/가구 요약
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
  // date 후보 필드들 중 하나라도 오늘과 같으면 오늘로 처리
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

  // updated 최신순 (기본)
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

    // 상태
    const sTd = document.createElement("td");
    sTd.appendChild(statusBadge(row.status));
    tr.appendChild(sTd);

    // 일정
    const schTd = document.createElement("td");
    schTd.innerHTML = `<div>${fmtSchedule(row)}</div><div class="small">${row?.confirmed_at ? "확정: " + String(row.confirmed_at).slice(0,16).replace("T"," ") : ""}</div>`;
    tr.appendChild(schTd);

    // 고객
    const cTd = document.createElement("td");
    const nm = row?.customer_name || row?.name || "-";
    const ph = maskPhone(row?.phone || row?.customer_phone || "");
    cTd.innerHTML = `<div><b>${nm}</b></div><div class="small">${ph || "-"}</div>`;
    tr.appendChild(cTd);

    // 출발 → 도착
    const rTd = document.createElement("td");
    rTd.textContent = routeText(row);
    tr.appendChild(rTd);

    // 옵션
    const oTd = document.createElement("td");
    oTd.textContent = optionsText(row);
    tr.appendChild(oTd);

    // 금액
    const mTd = document.createElement("td");
    mTd.className = "mono";
    mTd.textContent = moneyText(row);
    tr.appendChild(mTd);

    // 업데이트
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

  // 탭 필터
  if (ACTIVE_TAB !== "all") {
    rows = rows.filter((r) => (r?.status || "draft") === ACTIVE_TAB);
  }

  // 날짜 필터
  if (dateMode !== "all") {
    rows = rows.filter(isTodayByRow);
  }

  // 검색
  if (q) rows = rows.filter((r) => matchesQuery(r, q));

  // 정렬
  rows = sortRows(rows);

  VIEW = rows;

  setKpi(RAW);
  renderTable(VIEW);
}

// ------------------------------
// 상세 Drawer
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
  // chat_id는 화면에 숨기되, detail sub에만 표시(내부 확인용)
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

  // 단건 조회가 필요하면 여기서 /jobs/:chatId 호출도 가능
  // 지금은 원본 row를 우선 보여주고, chatId가 있으면 추가로 불러옴
  $("dJson").textContent = JSON.stringify(row, null, 2);

  openDrawer("drawer");

  // 가능하면 단건 상세 조회(서버가 /jobs/:chatId 지원)
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

    // 서버 응답 형태: { count, data: [...] } 예상
    RAW = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
    setConn(true, "연결됨");
    setStatus("OK", true);

    $("diag").textContent = `rows=${RAW.length} / tab=${ACTIVE_TAB} / base=${getBase()}`;

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

  // 탭 변경 시 즉시 refresh (서버 status 필터도 적용)
  refresh();
}

function bindEvents() {
  // 탭
  document.querySelectorAll(".tab").forEach((b) => {
    b.addEventListener("click", () => setActiveTab(b.dataset.tab));
  });

  // 필터
  $("q").addEventListener("input", () => applyView());
  $("dateFilter").addEventListener("change", () => applyView());
  $("sort").addEventListener("change", () => applyView());
  $("limit").addEventListener("change", () => refresh());

  // 상단
  $("btnRefresh").addEventListener("click", refresh);

  // 상세 drawer
  $("drawerClose").addEventListener("click", () => closeDrawer("drawer"));
  $("drawerBack").addEventListener("click", () => closeDrawer("drawer"));

  // 설정 drawer
  $("btnSettings").addEventListener("click", () => openDrawer("settings"));
  $("settingsClose").addEventListener("click", () => closeDrawer("settings"));
  $("settingsBack").addEventListener("click", () => closeDrawer("settings"));
  $("btnSaveBase").addEventListener("click", () => {
    saveBase();
    $("diag").textContent = `base=${getBase()}`;
    setStatus("Base URL 저장됨", true);
  });
  $("btnResetBase").addEventListener("click", () => {
    resetBase();
    $("diag").textContent = `base=${getBase()}`;
    setStatus("Base URL 기본값으로 복원", true);
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
    bindEvents();

    // ✅ auth 로드 체크
    if (!window.DDLOGI_AUTH || typeof window.DDLOGI_AUTH.getSession !== "function") {
      showAuthHelp(
        `auth.js 로드에 실패했어요.<br/>
         1) 배포 후 <b>/shared/auth.js</b>가 200인지 확인<br/>
         2) index.html에서 <b>&lt;script src="/shared/auth.js"&gt;</b> 경로 확인<br/>
         3) Netlify redirects에 <b>/apps/* → /apps/:splat (200)</b> 규칙이 있어야 새로고침 404가 안 납니다.`
      );
      setStatus("auth.js 미로드 (DDLOGI_AUTH 없음)", false);
      location.href = "/apps/auth/?next=/apps/admin/";
      return;
    }

    // ✅ 세션 확인 → 없으면 로그인으로
    const session = await window.DDLOGI_AUTH.getSession();
    if (!session) {
      location.href = "/apps/auth/?next=/apps/admin/";
      return;
    }

    // ✅ 권한 체크 (admin)
    if (typeof window.DDLOGI_AUTH.requireRole !== "function") {
      setStatus("requireRole 없음 (auth.js 수정 필요)", false);
      location.href = "/apps/auth/?next=/apps/admin/";
      return;
    }

    const ctx = await window.DDLOGI_AUTH.requireRole("admin");
    if (!ctx?.session?.access_token) {
      setStatus("requireRole이 session을 반환하지 않음 (auth.js 수정 필요)", false);
      return;
    }

    ACCESS_TOKEN = ctx.session.access_token;

    $("diag").textContent = `ready / base=${getBase()}`;
    setStatus("준비 완료", true);

    await refresh();
  } catch (e) {
    setConn(false, "연결 끊김");
    setStatus(e.message || String(e), false);
  }
})();

