// apps/driver/app.js
const $ = (id) => document.getElementById(id);

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
  el.className = "hint " + (ok ? "ok" : "bad");
}

function pad2(n){ return String(n).padStart(2,"0"); }
function ymd(d){ return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }
function monthKey(d){ return `${d.getFullYear()}-${pad2(d.getMonth()+1)}`; }
function startOfMonth(d){ return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d){ return new Date(d.getFullYear(), d.getMonth()+1, 0); }
function addDays(d, n){ const x = new Date(d); x.setDate(x.getDate()+n); return x; }
function toLocalDateStr(iso){ return ymd(new Date(iso)); }
function fmtTime(iso){ const d = new Date(iso); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function fmtMoney(n){ const v = Number(n); return Number.isFinite(v) ? v.toLocaleString("ko-KR") : "-"; }

function normalizeBase(str) { return String(str || "").trim().replace(/\/+$/, ""); }
function getApiBase() { return normalizeBase(window.DDLOGI_CONFIG?.apiBaseDefault || ""); }

async function apiRequest(path, method = "GET", body){
  const base = getApiBase();
  if (!base) throw new Error("API base missing (config.js apiBaseDefault)");
  const token = await window.DDLOGI_AUTH.getAccessToken();
  if (!token) throw new Error("세션 없음(로그인 필요)");

  const res = await fetch(base + path, {
    method,
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });

  const json = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error("401 (세션 만료/토큰 오류)");
  if (res.status === 403) throw new Error("403 (권한 또는 CORS)");
  if (!res.ok) throw new Error(json?.error || `${res.status} ${res.statusText}`);
  return json;
}
const apiGet = (path) => apiRequest(path, "GET");
const apiPatch = (path, body) => apiRequest(path, "PATCH", body);

let CUR = new Date();
let EVENTS = [];
let SELECTED_DATE = ymd(new Date());
let SELECTED_EVENT = null;

function visibleRangeForMonth(d){
  const first = startOfMonth(d);
  const last = endOfMonth(d);
  const start = addDays(first, -first.getDay());
  const end = addDays(last, 6 - last.getDay());
  return { start, end };
}

function renderMonth(){
  const grid = $("monthGrid");
  grid.innerHTML = "";
  $("monthTitle").textContent = `${CUR.getFullYear()}년 ${CUR.getMonth()+1}월`;

  const { start, end } = visibleRangeForMonth(CUR);
  const total = Math.round((end - start)/(24*60*60*1000)) + 1;

  const byDate = new Map();
  for (const e of EVENTS) {
    const ds = toLocalDateStr(e.start_at);
    byDate.set(ds, (byDate.get(ds) || 0) + 1);
  }

  for (let i=0;i<total;i++){
    const day = addDays(start, i);
    const ds = ymd(day);
    const cell = document.createElement("button");
    cell.className = "cell " + (ds === SELECTED_DATE ? "is-selected" : "");
    if (monthKey(day) !== monthKey(CUR)) cell.classList.add("is-muted");
    if (ds === ymd(new Date())) cell.classList.add("is-today");
    const n = byDate.get(ds) || 0;
    cell.innerHTML = `<div class="cellTop"><span>${day.getDate()}</span><span class="badge">${n}</span></div>`;
    cell.onclick = () => {
      SELECTED_DATE = ds;
      SELECTED_EVENT = null;
      $("detailBox").textContent = "{}";
      renderMonth();
      renderSide();
    };
    grid.appendChild(cell);
  }
  renderSide();
}

function buildDriverSheet(job = {}) {
  const parser = window.DDLOGI_ORDER_PARSER;
  if (parser?.parseOrderText && job.raw_text) {
    const parsed = parser.parseOrderText(job.raw_text);
    return parser.buildDriverPreviewText({
      ...parsed,
      move_date: parsed.move_date || job.move_date,
      time_slot_label: parsed.time_slot_label || job.time_slot_label,
      from_address: parsed.from_address || job.from_address,
      to_address: parsed.to_address || job.to_address,
      driver_amount: job.balance_amount ?? parsed.balance_amount,
    });
  }

  const lines = [];
  if (job.move_date || job.time_slot_label) lines.push(`일정: ${job.move_date || '-'} / ${job.time_slot_label || '-'}`);
  if (job.from_address) lines.push(`출발지: ${job.from_address}`);
  if (job.to_address) lines.push(`도착지: ${job.to_address}`);
  if (job.balance_amount != null) lines.push(`운임비: ₩${fmtMoney(job.balance_amount)}`);
  return lines.join('\n');
}

async function loadJobDetail(chatId){
  try {
    const json = await apiGet(`/jobs/${encodeURIComponent(chatId)}`);
    const job = json?.data || json;
    $("detailBox").textContent = buildDriverSheet(job);
  } catch {
    $("detailBox").textContent = "{}";
  }
}

function renderSide(){
  $("sideTitle").textContent = `${SELECTED_DATE} 일정`;
  const list = $("sideList");
  list.innerHTML = "";

  const items = EVENTS.filter(e => toLocalDateStr(e.start_at) === SELECTED_DATE);

  if (!items.length){
    const div = document.createElement("div");
    div.className = "muted";
    div.textContent = "일정이 없습니다.";
    list.appendChild(div);
    return;
  }

  for (const e of items){
    const row = document.createElement("button");
    row.className = "eventRow " + (SELECTED_EVENT?.id === e.id ? "is-selected" : "");
    row.innerHTML = `
      <div class="eventTime">${fmtTime(e.start_at)}–${fmtTime(e.end_at)}</div>
      <div class="eventTitle">${e.title || "-"}</div>
      <div class="eventMeta">ops=${e.ops_status || '-'} </div>
    `;
    row.onclick = async () => {
      SELECTED_EVENT = e;
      await loadJobDetail(e.chat_id);
      renderSide();
    };
    list.appendChild(row);
  }
}

async function refresh(){
  try {
    setConn(false, "불러오는 중");
    setStatus("캘린더 데이터 불러오는 중…", true);

    const { start, end } = visibleRangeForMonth(CUR);
    const from = ymd(start);
    const to = ymd(end);
    const status = ($("statusFilter")?.value || "").trim();

    const qs = new URLSearchParams();
    qs.set("from", from);
    qs.set("to", to);
    if (status) qs.set("status", status);

    const json = await apiGet(`/calendar?${qs.toString()}`);
    EVENTS = Array.isArray(json?.data) ? json.data : [];

    setConn(true, "연결됨");
    setStatus(`OK (events=${EVENTS.length})`, true);
    renderMonth();
  } catch (e) {
    setConn(false, "연결 끊김");
    setStatus(e?.message || String(e), false);
    if (String(e?.message||"").includes("401")) location.href = "/apps/auth/";
  }
}

async function updateOps(){
  try {
    if (!SELECTED_EVENT?.chat_id) throw new Error("이벤트 선택 필요");
    const ops = ($("opsSelect")?.value || "").trim();
    if (!ops) throw new Error("ops_status 선택 필요");

    await apiPatch(`/jobs/${encodeURIComponent(SELECTED_EVENT.chat_id)}/ops_status`, { ops_status: ops });
    setStatus("ops_status 업데이트 완료", true);
    await loadJobDetail(SELECTED_EVENT.chat_id);
  } catch (e) {
    setStatus(e?.message || String(e), false);
  }
}

async function boot(){
  setConn(false, "권한 확인중");
  if (!window.DDLOGI_AUTH) { setStatus("auth.js 로드 실패", false); return; }

  const ctx = await window.DDLOGI_AUTH.requireRole("driver");
  if (!ctx.ok) { location.href = "/apps/auth/"; return; }

  $("btnPrev").onclick = () => { CUR = new Date(CUR.getFullYear(), CUR.getMonth()-1, 1); refresh(); };
  $("btnNext").onclick = () => { CUR = new Date(CUR.getFullYear(), CUR.getMonth()+1, 1); refresh(); };
  $("btnToday").onclick = () => { CUR = new Date(); refresh(); };
  $("btnRefresh").onclick = refresh;
  $("statusFilter").onchange = refresh;
  $("btnUpdateOps").onclick = updateOps;

  await refresh();

  const btnLogoutEl = $("btnLogout");
  if (btnLogoutEl) {
    btnLogoutEl.onclick = async () => {
      await window.DDLOGI_AUTH.signOut();
      location.href = "/apps/auth/";
    };
  }
}

document.addEventListener("DOMContentLoaded", boot);