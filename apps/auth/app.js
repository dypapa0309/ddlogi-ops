// /apps/auth/app.js
const $ = (id) => document.getElementById(id);

function setMsg(text, ok = null) {
  const el = $("msg");
  if (!el) return;
  el.textContent = text || "-";
  el.className = "msg" + (ok === true ? " ok" : ok === false ? " bad" : "");
}

function getNext() {
  const p = new URLSearchParams(location.search);
  return p.get("next") || "/apps/admin/";
}

function getReason() {
  const p = new URLSearchParams(location.search);
  return p.get("reason") || "";
}

async function boot() {
  try {
    if (!window.DDLOGI_AUTH) throw new Error("DDLOGI_AUTH_NOT_LOADED");

    const reason = getReason();
    if (reason) setMsg(`로그인이 필요합니다. (${reason})`, false);
    else setMsg("세션 확인 중…", null);

    const ctx = await window.DDLOGI_AUTH.requireRole("admin");
    if (ctx?.ok) {
      setMsg("이미 로그인되어 있습니다. 이동합니다…", true);
      sessionStorage.removeItem("ddlogi_redirecting");
      location.replace(getNext());
      return;
    }

    if (ctx?.reason === "FORBIDDEN") setMsg("관리자 권한이 없습니다. (profiles.role 확인)", false);
    else if (ctx?.reason === "NO_SESSION") setMsg("로그인이 필요합니다.", false);
    else setMsg("로그인 해주세요.", null);
  } catch (e) {
    console.error(e);
    setMsg(e?.message || String(e), false);
  }
}

async function onLogin() {
  const email = ($("email")?.value || "").trim();
  const password = $("pw")?.value || "";
  if (!email || !password) return setMsg("이메일/비밀번호를 입력해줘", false);
  if (!window.DDLOGI_AUTH) return setMsg("DDLOGI_AUTH_NOT_LOADED", false);

  setMsg("로그인 중…", null);

  try {
    await window.DDLOGI_AUTH.signInWithPassword(email, password);

    const ctx = await window.DDLOGI_AUTH.requireRole("admin");
    if (!ctx?.ok) {
      if (ctx?.reason === "FORBIDDEN") {
        setMsg("로그인은 됐는데 관리자 권한이 없습니다. (profiles.role='admin' 필요)", false);
        return;
      }
      setMsg("권한 확인 실패. 다시 시도해줘.", false);
      return;
    }

    setMsg("로그인 성공. 이동합니다…", true);
    sessionStorage.removeItem("ddlogi_redirecting");
    location.replace(getNext());
  } catch (e) {
    console.error(e);
    setMsg(e?.message || String(e), false);
  }
}

async function onLogout() {
  try {
    if (!window.DDLOGI_AUTH) throw new Error("DDLOGI_AUTH_NOT_LOADED");
    await window.DDLOGI_AUTH.signOut();
    setMsg("로그아웃 완료", true);
  } catch (e) {
    console.error(e);
    setMsg(e?.message || String(e), false);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  $("btnLogin")?.addEventListener("click", onLogin);
  $("btnLogout")?.addEventListener("click", onLogout);

  $("pw")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onLogin();
  });

  boot();
});
