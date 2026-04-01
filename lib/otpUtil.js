// lib/otpUtil.js
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

function normalizePhoneE164(phone) {
  let s = String(phone || "").trim();

  // hapus spasi, kurung, strip
  s = s.replace(/[\s\-()]/g, "");

  // ubah 00xxxx -> +xxxx
  if (s.startsWith("00")) {
    s = `+${s.slice(2)}`;
  }

  // kalau ada +, pertahankan hanya di depan
  if (s.startsWith("+")) {
    s = `+${s.slice(1).replace(/\D/g, "")}`;
  } else {
    // kalau tidak ada +, hanya digit
    s = s.replace(/\D/g, "");
  }

  return s;
}

function isValidPhoneE164(phone) {
  return /^\+[1-9]\d{7,14}$/.test(String(phone || ""));
}

module.exports = {
  normalizeEmail,
  isValidEmail,
  emailDocId,
  genOtp6,
  otpHash,
  isPasswordStrong,
  normalizePhoneE164,
  isValidPhoneE164,
};