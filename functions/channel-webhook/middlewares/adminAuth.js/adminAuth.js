// functions/channel-webhook/middlewares/adminAuth.js

export function adminAuth(req, res, next) {
  try {
    const serverToken = process.env.ADMIN_API_TOKEN;

    if (!serverToken) {
      console.error("ADMIN_API_TOKEN not set");
      return res.status(500).json({ error: "Server misconfigured" });
    }

    const authHeader = req.headers.authorization || "";
    const incomingToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : null;

    if (!incomingToken || incomingToken !== serverToken) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    next();
  } catch (err) {
    console.error("adminAuth error:", err);
    return res.status(500).json({ error: "Auth middleware error" });
  }
}
