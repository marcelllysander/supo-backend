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

function str(v) {
  return String(v || "")
    .trim()
    .toLowerCase();
}

function isCompanyOtp(body) {
  const action = str(body.action);
  return action === "change_email" || action === "change_phone";
}

function isProfileOtp(body) {
  const purpose = str(body.purpose);
  const flow = str(body.flow);

  // signup & password_reset BUKAN profile otp
  if (flow === "signup" || flow === "password_reset") {
    return false;
  }

  return purpose === "email" || purpose === "phone";
}

function isAuthOtp(body) {
  const flow = str(body.flow);
  const step = str(body.step || body.mode);

  if (flow === "signup" || flow === "password_reset") {
    return true;
  }

  const hasEmail = !!String(body.email || "").trim();
  const hasName = !!String(body.firstName || "").trim() || !!String(body.lastName || "").trim();
  const hasPhone = !!String(body.phone || "").trim();
  const hasPassword = !!String(body.password || "").trim();
  const hasConfirmPassword = !!String(body.confirmPassword || "").trim();
  const hasNewPassword = !!String(body.newPassword || "").trim();
  const hasOtp = !!String(body.otp || "").trim();

  return !isCompanyOtp(body) && !isProfileOtp(body) && ["request", "confirm", "verify", "complete"].includes(step) && (hasEmail || hasName || hasPhone || hasPassword || hasConfirmPassword || hasNewPassword || hasOtp);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const body = parseBody(req);
    req.body = body;

    console.log("OTP ROUTER body:", body);

    // PRIORITAS 1: auth/signup/password_reset
    if (isAuthOtp(body)) {
      console.log("OTP ROUTER -> auth handler");
      return await handleAuthOtp(req, res);
    }

    // PRIORITAS 2: company change otp
    if (isCompanyOtp(body)) {
      console.log("OTP ROUTER -> company handler");
      return await handleCompanyOtp(req, res);
    }

    // PRIORITAS 3: profile otp
    if (isProfileOtp(body)) {
      console.log("OTP ROUTER -> profile handler");
      return await handleProfileOtp(req, res);
    }

    console.log("OTP ROUTER -> unknown request");
    return res.status(400).json({
      ok: false,
      message: "Request OTP tidak dikenali",
    });
  } catch (e) {
    console.error("OTP ROUTER ERROR:", e);
    return res.status(500).json({
      ok: false,
      message: e?.message || "Server error",
    });
  }
};
