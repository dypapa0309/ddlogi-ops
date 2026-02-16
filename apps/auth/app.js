// /apps/auth/app.js
const $ = (id) => document.getElementById(id);

function setMsg(text, ok = null) {
  const el = $("msg");
  el.textContent = text || "-";
  el.className = "msg" + (ok === true ? " ok" : ok === false ? " bad" : "");
}

function getNext() {
  const p = new URLSearchParams(location.search);
  return p.get("next") || "/apps/admin/";
}

async function boot() {
  try {
    // 이미 로그인되어 있으면 role 체크 후 바로 보내기
    const ctx = await window.DDLOGI_AUTH.requireRole("admin");
    if (ctx) {
      setMsg("이미 로그인됨. 대시보드로 이동합니다.", true);
      location.href = getNext();
      return;
    }
  } catch (e) {
    setMsg(e?.message || String(e), false);
  }
}

async function onLogin() {
  const email = $("email").value.trim();
  const password = $("pw").value.trim();
  if (!email || !password) return setMsg("이메일/비밀번호를 입력해줘", false);

  setMsg("로그인 중...", null);

  try {
    const { data, error } = await window.DDLOGI_AUTH.signInWithPassword(email, password);
    if (error) throw error;

    // 세션 생긴 뒤 role 확인
    const ctx = await window.DDLOGI_AUTH.requireRole("admin");
    if (!ctx) return;

    setMsg("로그인 성공. 이동합니다.", true);
    location.href = getNext();
  } catch (e) {
    setMsg(e?.message || String(e), false);
  }
}

async function onLogout() {
  try {
    await window.DDLOGI_AUTH.signOut();
    setMsg("로그아웃 완료", true);
  } catch (e) {
    setMsg(e?.message || String(e), false);
  }
}

$("btnLogin").addEventListener("click", onLogin);
$("btnLogout").addEventListener("click", onLogout);

boot();
