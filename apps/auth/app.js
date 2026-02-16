// apps/auth/app.js
(async () => {
  const $ = (s) => document.querySelector(s);
  const msg = $("#msg");

  const { supabase, getSession, getMyRole, signOut } = window.DDLOGI_AUTH;

  // 이미 로그인돼 있으면 역할에 맞게 보내기
  const existing = await getSession().catch(() => null);
  if (existing) {
    const role = await getMyRole().catch(() => null);
    if (role === "admin") location.href = "/apps/admin/";
    else if (role === "driver") location.href = "/apps/driver/";
  }

  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    msg.textContent = "";

    const email = $("#email").value.trim();
    const password = $("#password").value;

    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;

      const role = await getMyRole();
      if (role === "admin") location.href = "/apps/admin/";
      else location.href = "/apps/driver/";
    } catch (err) {
      msg.textContent = `로그인 실패: ${err.message || err}`;
    }
  });

  // (옵션) 로그아웃 버튼
  const session = await getSession().catch(() => null);
  if (session) {
    $("#logoutBtn").style.display = "inline-block";
    $("#logoutBtn").addEventListener("click", signOut);
  }
})();
