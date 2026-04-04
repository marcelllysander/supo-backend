// api/system.js
const handleHealth = require("../lib/handlers/system/health");
const handleSyncEmailChanges = require("../lib/handlers/system/sync-email-changes");

module.exports = async (req, res) => {
  const action = String(req.query?.action || "").trim().toLowerCase();

  if (action === "health") {
    return await handleHealth(req, res);
  }

  if (action === "sync_email_changes") {
    return await handleSyncEmailChanges(req, res);
  }

  return res.status(400).json({
    ok: false,
    message: "action tidak valid. Gunakan 'health' atau 'sync_email_changes'.",
  });
};