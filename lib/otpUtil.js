const crypto = require("crypto");

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function emailDocId(emailLower) {
  return Buffer.from(emailLower).toString("base64url");
}

function genOtp6() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function otpHash(otp) {
  const pepper = process.env.OTP_PEPPER || "";
  return crypto
    .createHash("sha256")
    .update(String(otp) + pepper)
    .digest("hex");
}

function isPasswordStrong(pw) {
  return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{6,}$/.test(String(pw || ""));
}

module.exports = {
  normalizeEmail,
  isValidEmail,
  emailDocId,
  genOtp6,
  otpHash,
  isPasswordStrong,
};
