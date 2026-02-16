// /middlewares/adminAuth.js (ESM)
export function requireAdminFactory() {
  return function requireAdmin(req, res, next) {
    const h = String(req.headers.authorization || "");
    const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";

    const adminToken = process.env.ADMIN_API_TOKEN || "";
    if (!adminToken) return res.status(500).json({ error: "ADMIN_API_TOKEN_MISSING" });
    if (!token || token !== adminToken) return res.status(401).json({ error: "Unauthorized" });

    next();
  };
}
