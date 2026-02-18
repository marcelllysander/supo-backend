const { authAdmin, dbAdmin } = require("../../lib/firebaseAdmin");
const { sendOtpEmail } = require("../../lib/mailer");
const { normalizeEmail, isValidEmail, emailDocId, genOtp6, otpHash } = require("../../lib/otpUtil");

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

function isUserNotFoundError(e) {
  const code = e?.code || "";
  return code === "auth/user-not-found" || code === "USER_NOT_FOUND";
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const body = await parseBody(req);
    const emailLower = normalizeEmail(body.email);

    if (!isValidEmail(emailLower)) {
      return res.status(400).json({ ok: false, message: "Email tidak valid." });
    }

    // ✅ CEK: email harus terdaftar di Firebase Auth
    try {
      await authAdmin.getUserByEmail(emailLower);
    } catch (e) {
      if (isUserNotFoundError(e)) {
        return res.status(404).json({ ok: false, message: "Email tidak terdaftar." });
      }
      throw e; // error lain (mis config firebase)
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
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message || "Server error" });
  }
};
