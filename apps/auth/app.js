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

async function signIn(email, password) {
  // ✅ shared/supabase-client.js가 window.DDLOGI_SUPABASE를 만들어둠
  const supabase = window.DDLOGI_SUPABASE;
  if (!supabase) throw new Error("Supabase client not initialized. supabase-client.js 포함 확인");

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.session;
}

async function ensureAdmin() {
  // shared/auth.js의 requireRole 재사용
  const ctx = await window.DDLOGI_AUTH.requireRole("admin");
  if (!ctx) throw new Error("권한 확인 실패 (admin만 가능)");
  return ctx;
}

(async function boot() {
  try {
    setMsg("세션 확인 중…");

    if (!window.DDLOGI_AUTH) throw new Error("DDLOGI_AUTH not ready. auth.js 포함 확인");

    const session = await window.DDLOGI_AUTH.getSession?.();
    if (session) {
      await ensureAdmin();
      setMsg("이미 로그인 되어있습니다. 이동합니다…", true);
      location.href = getNext();
      return;
    }

    setMsg("로그인 정보를 입력하세요.");
  } catch (e) {
    setMsg(e.message || String(e), false);
  }
})();

$("btnLogin").addEventListener("click", async () => {
  try {
    const email = $("email").value.trim();
    const pw = $("pw").value;

    if (!email || !pw) return setMsg("이메일/비밀번호를 입력하세요.", false);

    setMsg("로그인 중…");
    await signIn(email, pw);

    setMsg("권한 확인 중…");
    await ensureAdmin();

    setMsg("완료. 이동합니다…", true);
    location.href = getNext();
  } catch (e) {
    setMsg(e.message || String(e), false);
  }
});

$("btnLogout").addEventListener("click", async () => {
  try {
    const supabase = window.DDLOGI_SUPABASE;
    if (!supabase) throw new Error("Supabase client not initialized.");

    await supabase.auth.signOut();
    setMsg("로그아웃 완료", true);
  } catch (e) {
    setMsg(e.message || String(e), false);
  }
});
