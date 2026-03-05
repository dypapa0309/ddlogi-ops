// apps/driver/open.js

const $ = (id) => document.getElementById(id);

function setConn(ok, text) {
  const pill = $('connPill');
  if (!pill) return;
  pill.textContent = text || (ok ? '연결됨' : '연결 끊김');
  pill.className = 'pill ' + (ok ? 'pill-ok' : 'pill-bad');
}

function setStatus(msg, ok = true) {
  const el = $('statusText');
  if (!el) return;
  el.textContent = msg;
  el.className = 'hint ' + (ok ? 'ok' : 'bad');
}

function normalizeBase(str) {
  return String(str || '').trim().replace(/\/+/g, '/').replace(/\/$/, '');
}

function getApiBase() {
  return normalizeBase(window.DDLOGI_CONFIG?.apiBaseDefault || '');
}

async function apiGet(path) {
  const base = getApiBase();
  if (!base) throw new Error('API base missing (config.js apiBaseDefault)');
  const token = await window.DDLOGI_AUTH.getAccessToken();
  if (!token) throw new Error('세션 없음(로그인 필요)');
  const res = await fetch(base + path, {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
  });
  if (res.status === 401) throw new Error('401 (세션 만료/토큰 오류)');
  if (res.status === 403) throw new Error('403 (권한 또는 CORS)');
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function apiPost(path, body) {
  const base = getApiBase();
  if (!base) throw new Error('API base missing (config.js apiBaseDefault)');
  const token = await window.DDLOGI_AUTH.getAccessToken();
  if (!token) throw new Error('세션 없음(로그인 필요)');
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error('401 (세션 만료/토큰 오류)');
  if (res.status === 403) throw new Error('403 (권한 또는 CORS)');
  if (!res.ok) {
    throw new Error(json?.error || `${res.status} ${res.statusText}`);
  }
  return json;
}

async function loadOpenJobs() {
  try {
    setConn(false, '불러오는 중');
    setStatus('오픈 오더 불러오는 중…', true);
    const json = await apiGet('/jobs/open');
    const list = $('openList');
    list.innerHTML = '';
    const rows = Array.isArray(json?.data) ? json.data : [];
    if (!rows.length) {
      const div = document.createElement('div');
      div.className = 'muted';
      div.textContent = '현재 픽업 가능한 오더가 없습니다.';
      list.appendChild(div);
      setConn(true, '연결됨');
      setStatus('오더 0건', true);
      return;
    }
    rows.forEach((job) => {
      const card = document.createElement('div');
      card.className = 'card mt10';
      card.innerHTML =
        '<div class="row between">' +
        '<div>' +
        '<div><strong>' + (job.move_date || '') + '</strong></div>' +
        '<div class="small">' + (job.from_address || '') + ' → ' + (job.to_address || '') + '</div>' +
        '</div>' +
        '<div class="row gap10">' +
        '<button class="btn btn-primary" data-chat-id="' + job.chat_id + '">픽업</button>' +
        '</div>' +
        '</div>';
      list.appendChild(card);
    });
    // Attach pick handlers
    list.querySelectorAll('button[data-chat-id]').forEach((btn) => {
      btn.onclick = async (e) => {
        const chatId = e.currentTarget.getAttribute('data-chat-id');
        if (!chatId) return;
        try {
          setStatus('픽업 처리 중…', true);
          await apiPost(`/jobs/${encodeURIComponent(chatId)}/pick`, {});
          setStatus('픽업 성공', true);
          await loadOpenJobs();
        } catch (err) {
          setStatus(err?.message || String(err), false);
        }
      };
    });
    setConn(true, '연결됨');
    setStatus(`오더 ${rows.length}건`, true);
  } catch (e) {
    setConn(false, '연결 끊김');
    setStatus(e?.message || String(e), false);
    if (String(e?.message || '').includes('401')) location.href = '/apps/auth/';
  }
}

async function boot() {
  setConn(false, '권한 확인중');
  if (!window.DDLOGI_AUTH) {
    setStatus('auth.js 로드 실패', false);
    return;
  }
  const ctx = await window.DDLOGI_AUTH.requireRole('driver');
  if (!ctx.ok) {
    location.href = '/apps/auth/';
    return;
  }
  $('#btnRefresh').onclick = loadOpenJobs;
  // Logout handler
  const btnLogoutEl = $('#btnLogout');
  if (btnLogoutEl) {
    btnLogoutEl.onclick = async () => {
      await window.DDLOGI_AUTH.signOut();
      location.href = '/apps/auth/';
    };
  }
  await loadOpenJobs();
}

document.addEventListener('DOMContentLoaded', boot);