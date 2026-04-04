// api/system.js
const handleHealth = require("../lib/handlers/system/health");
const handleSyncEmailChanges = require("../lib/handlers/system/sync-email-changes");
const handleBootstrapAdmin = require("../lib/handlers/system/bootstrap-admin");

module.exports = async (req, res) => {
  const action = String(req.query?.action || "").trim().toLowerCase();

  if (action === "health") {
    return await handleHealth(req, res);
  }

  if (action === "sync_email_changes") {
    return await handleSyncEmailChanges(req, res);
  }

  if (action === "bootstrap_admin") {
    return await handleBootstrapAdmin(req, res);
  }

  return res.status(400).json({
    ok: false,
    message: "action tidak valid. Gunakan 'health', 'sync_email_changes', atau 'bootstrap_admin'.",
  });
};