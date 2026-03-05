// apps/auth/app.js
const $ = (id) => document.getElementById(id);

function setMsg(text, ok = null) {
  const el = $("msg");
  if (!el) return;
  el.textContent = text || "-";
  el.className = "msg" + (ok === true ? " ok" : ok === false ? " bad" : "");
}

async function boot() {
  try {
    if (!window.DDLOGI_AUTH) throw new Error("DDLOGI_AUTH_NOT_LOADED");

    const ctx = await window.DDLOGI_AUTH.requireRole(null);
    if (ctx.ok) {
      if (ctx.role === "admin") location.replace("/apps/admin/");
      else if (ctx.role === "driver") location.replace("/apps/driver/");
      else setMsg(`알 수 없는 role=${ctx.role}`, false);
      return;
    }

    if (ctx.reason === "NO_SESSION") setMsg("로그인 해주세요.", false);
    else setMsg(ctx.detail || ctx.reason || "로그인 필요", false);
  } catch (e) {
    setMsg(e?.message || String(e), false);
  }
}

async function onLogin() {
  const email = ($("email")?.value || "").trim();
  const password = $("pw")?.value || "";
  if (!email || !password) return setMsg("이메일/비밀번호를 입력해줘", false);

  setMsg("로그인 중…", null);

  try {
    await window.DDLOGI_AUTH.signInWithPassword(email, password);

    const ctx = await window.DDLOGI_AUTH.requireRole(null);
    if (!ctx.ok) return setMsg("로그인은 됐지만 권한 확인 실패 (profiles 확인)", false);

    setMsg("로그인 성공. 이동합니다…", true);

    if (ctx.role === "admin") location.replace("/apps/admin/");
    else if (ctx.role === "driver") location.replace("/apps/driver/");
    else setMsg(`알 수 없는 role=${ctx.role}`, false);
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

document.addEventListener("DOMContentLoaded", () => {
  $("btnLogin")?.addEventListener("click", onLogin);
  $("btnLogout")?.addEventListener("click", onLogout);
  $("pw")?.addEventListener("keydown", (e) => e.key === "Enter" && onLogin());
  boot();
});
