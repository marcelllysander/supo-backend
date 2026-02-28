// api/auth/password-otp.js
const { authAdmin, dbAdmin } = require("../../lib/firebaseAdmin");
const { sendOtpEmail } = require("../../lib/mailer");
const { normalizeEmail, isValidEmail, emailDocId, genOtp6, otpHash, isPasswordStrong } = require("../../lib/otpUtil");

async function parseBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.length) {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}

function getStep(body) {
  return String(body.step || body.mode || "")
    .trim()
    .toLowerCase(); // request | confirm
}

function isUserNotFoundError(e) {
  const code = e?.code || "";
  return code === "auth/user-not-found" || code === "USER_NOT_FOUND";
}

async function handleRequest(req, res, body) {
  const emailLower = normalizeEmail(body.email);

  if (!isValidEmail(emailLower)) {
    return res.status(400).json({ ok: false, message: "Email tidak valid." });
  }

  // CEK: email harus terdaftar di Firebase Auth
  try {
    await authAdmin.getUserByEmail(emailLower);
  } catch (e) {
    if (isUserNotFoundError(e)) {
      return res.status(404).json({ ok: false, message: "Email tidak terdaftar." });
    }
    throw e;
  }

  const docId = emailDocId(emailLower);
  const ref = dbAdmin.collection("password_reset_otps").doc(docId);
  const snap = await ref.get();

  const now = Date.now();

  // rate limit 60 detik per email
  if (snap.exists) {
    const nextAllowedAt = snap.get("nextAllowedAt");
    if (nextAllowedAt && now < nextAllowedAt) {
      return res.status(429).json({ ok: false, message: "Tunggu sebentar sebelum minta OTP lagi." });
    }
  }

  const otp = genOtp6();
  const hash = otpHash(otp);

  await ref.set({
    email: emailLower,
    otpHash: hash,
    expiresAt: now + 10 * 60 * 1000, // 10 menit
    attempts: 0,
    nextAllowedAt: now + 60 * 1000,
    createdAt: now,
  });

  await sendOtpEmail(emailLower, otp);

  return res.status(200).json({ ok: true, message: "OTP terkirim." });
}

async function handleConfirm(req, res, body) {
  const emailLower = normalizeEmail(body.email);
  const otp = String(body.otp || "").trim();
  const newPassword = String(body.newPassword || "");

  if (!isValidEmail(emailLower)) {
    return res.status(400).json({ ok: false, message: "Email tidak valid." });
  }

  if (!/^\d{6}$/.test(otp)) {
    return res.status(400).json({ ok: false, message: "OTP harus 6 digit." });
  }

  if (!isPasswordStrong(newPassword)) {
    return res.status(400).json({ ok: false, message: "Password baru tidak memenuhi syarat." });
  }

  const docId = emailDocId(emailLower);
  const ref = dbAdmin.collection("password_reset_otps").doc(docId);
  const snap = await ref.get();

  if (!snap.exists) {
    return res.status(400).json({ ok: false, message: "OTP tidak ditemukan / sudah kadaluarsa." });
  }

  const now = Date.now();
  const expiresAt = snap.get("expiresAt");
  const attempts = snap.get("attempts") || 0;

  if (expiresAt && now > expiresAt) {
    await ref.delete().catch(() => {});
    return res.status(400).json({ ok: false, message: "OTP sudah kadaluarsa." });
  }

  if (attempts >= 5) {
    await ref.delete().catch(() => {});
    return res.status(429).json({ ok: false, message: "Terlalu banyak percobaan. Minta OTP baru." });
  }

  const expected = snap.get("otpHash");
  const given = otpHash(otp);

  if (given !== expected) {
    await ref.update({ attempts: attempts + 1 });
    return res.status(400).json({ ok: false, message: "OTP salah." });
  }

  let user;
  try {
    user = await authAdmin.getUserByEmail(emailLower);
  } catch (e) {
    if (isUserNotFoundError(e)) {
      await ref.delete().catch(() => {});
      return res.status(404).json({ ok: false, message: "Email tidak terdaftar." });
    }
    throw e;
  }

  await authAdmin.updateUser(user.uid, { password: newPassword });

  // paksa login ulang
  await authAdmin.revokeRefreshTokens(user.uid);

  await ref.delete().catch(() => {});

  return res.status(200).json({
    ok: true,
    message: "Password berhasil direset. Silakan login ulang.",
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const body = await parseBody(req);
    const step = getStep(body);

    if (step === "request") {
      return await handleRequest(req, res, body);
    }

    if (step === "confirm") {
      return await handleConfirm(req, res, body);
    }

    return res.status(400).json({
      ok: false,
      message: "step tidak valid. Gunakan 'request' atau 'confirm'.",
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message || "Server error" });
  }
};
