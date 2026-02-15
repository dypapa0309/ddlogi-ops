const $ = (id) => document.getElementById(id);

const LS_BASE = "ddlogi_admin_base";
const LS_TOKEN = "ddlogi_admin_token";

function setStatus(msg, ok=true){
  const el = $("statusText");
  el.textContent = msg;
  el.className = "mono " + (ok ? "ok" : "bad");
}

function loadSaved(){
  const base = localStorage.getItem(LS_BASE) || $("baseUrl").value.trim();
  const token = sessionStorage.getItem(LS_TOKEN) || ""; // 토큰은 세션만
  $("baseUrl").value = base;
  $("token").value = token;
}

function save(){
  const base = $("baseUrl").value.trim().replace(/\/+$/, "");
  const token = $("token").value.trim();
  if(!base) return setStatus("Base URL이 비었습니다", false);
  localStorage.setItem(LS_BASE, base);
  if(token) sessionStorage.setItem(LS_TOKEN, token);
  setStatus("저장됨 (base: localStorage / token: sessionStorage)", true);
}

function clearToken(){
  sessionStorage.removeItem(LS_TOKEN);
  $("token").value = "";
  setStatus("토큰 삭제됨", true);
}

function getConfig(){
  const base = ($("baseUrl").value || "").trim().replace(/\/+$/, "");
  const token = ($("token").value || "").trim();
  return { base, token };
}

async function apiGet(path){
  const { base, token } = getConfig();
  if(!base) throw new Error("Base URL empty");
  if(!token) throw new Error("Token empty");

  const url = base + path;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json"
    },
    credentials: "omit"
  });

  if(res.status === 401){
    throw new Error("401 Unauthorized (토큰 확인)");
  }
  if(res.status === 403){
    throw new Error("403 CORS forbidden (ADMIN_ALLOWED_ORIGINS 확인)");
  }
  if(!res.ok){
    const txt = await res.text().catch(()=> "");
    throw new Error(`${res.status} ${res.statusText} ${txt}`.trim());
  }
  return res.json();
}

function fmtMoney(n){
  if(n == null) return "-";
  try { return Number(n).toLocaleString("ko-KR"); } catch { return String(n); }
}

function td(text, cls=""){
  const el = document.createElement("td");
  el.textContent = text;
  if(cls) el.className = cls;
  return el;
}

function pill(status){
  const span = document.createElement("span");
  span.className = "pill";
  span.textContent = status || "-";
  return span;
}

async function refresh(){
  try{
    setStatus("불러오는 중…", true);

    const limit = $("limit").value;
    const status = $("statusFilter").value;

    const qs = new URLSearchParams();
    qs.set("limit", limit);
    if(status) qs.set("status", status);

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
      tr.appendChild(td(`Q:${fmtMoney(row.quote_amount)} / D:${fmtMoney(row.deposit_amount)} / B:${fmtMoney(row.balance_amount)}`, "mono"));
      tr.appendChild(td(row.confirmed_at || "-", "mono"));

      tbody.appendChild(tr);
    });

    setStatus("OK (200)", true);
  } catch(e){
    setStatus(e.message || String(e), false);
  }
}

async function openDetail(chatId){
  try{
    if(!chatId) return;
    setStatus(`상세 조회 중… (${chatId})`, true);
    const json = await apiGet(`/jobs/${encodeURIComponent(chatId)}`);
    $("detail").textContent = JSON.stringify(json.data || json, null, 2);
    $("detailCard").style.display = "block";
    setStatus("상세 OK", true);
  } catch(e){
    setStatus(e.message || String(e), false);
  }
}

function closeDetail(){
  $("detailCard").style.display = "none";
  $("detail").textContent = "";
}

$("saveBtn").addEventListener("click", save);
$("clearBtn").addEventListener("click", clearToken);
$("refreshBtn").addEventListener("click", refresh);
$("closeDetail").addEventListener("click", closeDetail);

loadSaved();
setStatus("토큰 입력 후 새로고침을 누르세요", true);
