// api/admin.js
const { requireAuth } = require("../lib/authMiddleware");
const handleVerificationAdmin = require("../lib/handlers/admin/verification");

function parseBody(req) {
  try {
    if (!req.body) return {};
    if (typeof req.body === "string") return JSON.parse(req.body || "{}");
    return req.body || {};
  } catch {
    return {};
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const decoded = await requireAuth(req);

    if (decoded.admin !== true) {
      return res.status(403).json({
        ok: false,
        message: "Admin only"
      });
    }

    const body = parseBody(req);
    const moduleName = String(body.module || "").trim().toLowerCase();

    if (moduleName === "verification") {
      return await handleVerificationAdmin(req, res, decoded, body);
    }

    return res.status(400).json({
      ok: false,
      message: "module admin tidak valid."
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e?.message || "Server error"
    });
  }
};