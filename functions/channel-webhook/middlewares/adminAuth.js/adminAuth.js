// functions/channel-webhook/middlewares/adminAuth.js (ESM)
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// (옵션) 레거시 토큰 병행 (있으면만)
const LEGACY_ADMIN_TOKEN = process.env.ADMIN_API_TOKEN;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("[adminAuth] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

export async function requireAdmin(req, res, next) {
  try {
    // 0) supabase 준비 체크
    if (!supabaseAdmin) {
      return res.status(503).json({ ok: false, error: "SUPABASE_NOT_CONFIGURED" });
    }

    // 1) Bearer JWT 우선
    const authHeader = String(req.headers.authorization || "");
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    const bearerToken = match?.[1];

    if (bearerToken) {
      // ✅ JWT로 유저 검증
      const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(bearerToken);

      if (userErr || !userData?.user?.id) {
        return res.status(401).json({ ok: false, error: "Invalid session token" });
      }

      const userId = userData.user.id;

      // ✅ role=admin 확인
      const { data: profile, error: profErr } = await supabaseAdmin
        .from("profiles")
        .select("role")
        .eq("user_id", userId)
        .single();

      if (profErr || !profile) {
        return res.status(403).json({ ok: false, error: "Profile not found" });
      }
      if (profile.role !== "admin") {
        return res.status(403).json({ ok: false, error: "Admin only" });
      }

      req.adminUserId = userId;
      return next();
    }

    // 2) (옵션) 레거시 x-admin-token 병행
    if (LEGACY_ADMIN_TOKEN) {
      const token = String(req.headers["x-admin-token"] || "");
      if (token && token === LEGACY_ADMIN_TOKEN) return next();
    }

    return res.status(401).json({ ok: false, error: "Unauthorized" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
