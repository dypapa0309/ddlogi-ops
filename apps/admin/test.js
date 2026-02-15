const API_BASE = "https://ddlogi-ops.onrender.com";

const $ = (id) => document.getElementById(id);
const out = $("out");

function show(obj) {
  out.textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
}

async function call(path) {
  const token = $("token").value.trim();
  if (!token) return show("❌ ADMIN_API_TOKEN을 입력해줘");

  const res = await fetch(`${API_BASE}${path}`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }

  if (!res.ok) {
    return show({ ok: false, status: res.status, data });
  }
  return show({ ok: true, status: res.status, data });
}

$("btnList").addEventListener("click", async () => {
  const q = encodeURIComponent($("q").value.trim());
  const status = encodeURIComponent($("status").value.trim());
  const page = encodeURIComponent($("page").value.trim() || "1");
  const limit = encodeURIComponent($("limit").value.trim() || "20");

  const qs = new URLSearchParams();
  if (q) qs.set("q", decodeURIComponent(q));
  if (status) qs.set("status", decodeURIComponent(status));
  qs.set("page", decodeURIComponent(page));
  qs.set("limit", decodeURIComponent(limit));

  await call(`/jobs?${qs.toString()}`);
});

$("btnOne").addEventListener("click", async () => {
  const chatId = $("chatId").value.trim();
  if (!chatId) return show("❌ chatId를 입력해줘");
  await call(`/jobs/${encodeURIComponent(chatId)}`);
});
