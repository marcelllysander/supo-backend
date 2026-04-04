// api/otp.js
const handleAuthOtp = require("../lib/handlers/otp/auth-password-otp");
const handleProfileOtp = require("../lib/handlers/otp/profile-otp");
const handleCompanyOtp = require("../lib/handlers/otp/company-change-otp");

function parseBody(req) {
  try {
    if (!req.body) return {};
    if (typeof req.body === "string") return JSON.parse(req.body || "{}");
    return req.body || {};
  } catch {
    return {};
  }
}

function getFlow(body) {
  return String(body.flow || "").trim().toLowerCase();
}

function getPurpose(body) {
  return String(body.purpose || "").trim().toLowerCase();
}

function getAction(body) {
  return String(body.action || "").trim().toLowerCase();
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const body = parseBody(req);
    req.body = body;

    const flow = getFlow(body);
    const purpose = getPurpose(body);
    const action = getAction(body);

    // auth signup / password reset
    if (flow === "signup" || flow === "password_reset") {
      return await handleAuthOtp(req, res);
    }

    // company change otp
    if (action === "change_email" || action === "change_phone") {
      return await handleCompanyOtp(req, res);
    }

    // profile otp
    if (purpose === "email" || purpose === "phone") {
      return await handleProfileOtp(req, res);
    }

    return res.status(400).json({
      ok: false,
      message: "Request OTP tidak dikenali.",
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e?.message || "Server error",
    });
  }
};