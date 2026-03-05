// apps/admin/app.js
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

function normalizeBase(str) { return String(str || "").trim().replace(/\/+$/, ""); }
function getApiBase() { return normalizeBase(window.DDLOGI_CONFIG?.apiBaseDefault || ""); }

async function apiGet(path){
  const base = getApiBase();
  if (!base) throw new Error("API base missing (config.js apiBaseDefault)");
  const token = await window.DDLOGI_AUTH.getAccessToken();
  if (!token) throw new Error("세션 없음(로그인 필요)");

  const res = await fetch(base + path, {
    method: "GET",
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" }
  });

  if (res.status === 401) throw new Error("401 (세션 만료/토큰 오류)");
  if (res.status === 403) throw new Error("403 (권한 또는 CORS)");
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function apiPatch(path, body){
  const base = getApiBase();
  if (!base) throw new Error("API base missing (config.js apiBaseDefault)");
  const token = await window.DDLOGI_AUTH.getAccessToken();
  if (!token) throw new Error("세션 없음(로그인 필요)");

  const res = await fetch(base + path, {
    method: "PATCH",
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });

  if (res.status === 401) throw new Error("401 (세션 만료/토큰 오류)");
  if (res.status === 403) throw new Error("403 (권한 또는 CORS)");
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

let CUR = new Date();
let EVENTS = [];
let SELECTED_DATE = ymd(new Date());
let DRIVERS = [];
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

async function loadJobDetail(chatId){
  try {
    const json = await apiGet(`/jobs/${encodeURIComponent(chatId)}`);
    $("detailBox").textContent = JSON.stringify(json?.data || json, null, 2);
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
      <div class="eventMeta">status=${e.status} / driver=${e.assigned_driver_id ? "assigned" : "none"}</div>
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

async function loadDrivers(){
  try {
    const json = await apiGet("/drivers");
    DRIVERS = Array.isArray(json?.data) ? json.data : [];

    const sel = $("driverSelect");
    sel.innerHTML =
      `<option value="">기사 선택</option>` +
      DRIVERS.map(d => `<option value="${d.user_id}">${(d.name || d.user_id)}</option>`).join("");

    setStatus(`기사 ${DRIVERS.length}명 로드됨`, true);
  } catch (e) {
    setStatus(e?.message || String(e), false);
  }
}

async function assignDriver(){
  try {
    if (!SELECTED_EVENT?.chat_id) throw new Error("이벤트 선택 필요");
    const driverId = ($("driverSelect")?.value || "").trim();
    if (!driverId) throw new Error("기사 선택 필요");

    await apiPatch(`/jobs/${encodeURIComponent(SELECTED_EVENT.chat_id)}/assign_driver`, {
      driver_user_id: driverId
    });

    setStatus("기사 배정 완료", true);
    await refresh();
  } catch (e) {
    setStatus(e?.message || String(e), false);
  }
}

async function updateOps(){
  try {
    if (!SELECTED_EVENT?.chat_id) throw new Error("이벤트 선택 필요");
    const ops = ($("opsSelect")?.value || "").trim();
    if (!ops) throw new Error("ops_status 선택 필요");

    await apiPatch(`/jobs/${encodeURIComponent(SELECTED_EVENT.chat_id)}/ops_status`, {
      ops_status: ops
    });

    setStatus("ops_status 업데이트 완료", true);
    await loadJobDetail(SELECTED_EVENT.chat_id);
  } catch (e) {
    setStatus(e?.message || String(e), false);
  }
}

async function boot(){
  setConn(false, "권한 확인중");
  if (!window.DDLOGI_AUTH) { setStatus("auth.js 로드 실패", false); return; }

  const ctx = await window.DDLOGI_AUTH.requireRole("admin");
  if (!ctx.ok) { location.href = "/apps/auth/"; return; }

  $("btnPrev").onclick = () => { CUR = new Date(CUR.getFullYear(), CUR.getMonth()-1, 1); refresh(); };
  $("btnNext").onclick = () => { CUR = new Date(CUR.getFullYear(), CUR.getMonth()+1, 1); refresh(); };
  $("btnToday").onclick = () => { CUR = new Date(); refresh(); };
  $("btnRefresh").onclick = refresh;
  $("statusFilter").onchange = refresh;

  $("btnLoadDrivers").onclick = loadDrivers;
  $("btnAssignDriver").onclick = assignDriver;
  $("btnUpdateOps").onclick = updateOps;

  await refresh();
}

document.addEventListener("DOMContentLoaded", boot);
