// api/admin.js
const { requireAuth } = require("../lib/authMiddleware");
const handleAdminVerification = require("../lib/handlers/admin/verification");
const handleAdminBroadcast = require("../lib/handlers/admin/broadcast");
const handleAdminUsers = require("../lib/handlers/admin/users");

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
    return res.status(405).json({
      ok: false,
      message: "Method not allowed"
    });
  }

  try {
    const decoded = await requireAuth(req);

    if (decoded.admin !== true) {
      return res.status(403).json({
        ok: false,
        message: "Bukan admin."
      });
    }

    const body = parseBody(req);
    const moduleName = String(body.module || "").trim().toLowerCase();

    if (moduleName === "verification") {
      return await handleAdminVerification(req, res, decoded, body);
    }

    if (moduleName === "broadcast") {
      return await handleAdminBroadcast(req, res, decoded, body);
    }

    if (moduleName === "users") {
      return await handleAdminUsers(req, res, decoded, body);
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