const { dbAdmin, authAdmin } = require("../../lib/firebaseAdmin");
const { requireAuth } = require("../../lib/authMiddleware");
const { genOtp6, otpHash } = require("../../lib/otpUtil");
const { sendOtpEmail } = require("../../lib/mailer");
const { sendOtpWhatsapp } = require("../../lib/whatsapp");

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

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ ok: false, message: "Method not allowed" });

  try {
    const decoded = await requireAuth(req);
    const uid = decoded.uid;

    const body = await parseBody(req);
    const purpose = String(body.purpose || "").trim(); // "email" | "phone"
    const channel = String(body.channel || "").trim(); // "email" | "whatsapp"

    if (!["email", "phone"].includes(purpose)) {
      return res.status(400).json({ ok: false, message: "purpose tidak valid" });
    }
    if (!["email", "whatsapp"].includes(channel)) {
      return res.status(400).json({ ok: false, message: "channel tidak valid" });
    }

    // rate limit doc per uid+purpose
    const docId = Buffer.from(`${uid}:${purpose}`).toString("base64url");
    const ref = dbAdmin.collection("profile_verify_otps").doc(docId);
    const snap = await ref.get();
    const now = Date.now();

    if (snap.exists) {
      const nextAllowedAt = snap.get("nextAllowedAt");
      if (nextAllowedAt && now < nextAllowedAt) {
        return res.status(429).json({ ok: false, message: "Tunggu sebentar sebelum minta OTP lagi." });
      }
    }

    const otp = genOtp6();
    await ref.set({
      uid,
      purpose,
      otpHash: otpHash(otp),
      expiresAt: now + 10 * 60 * 1000,
      attempts: 0,
      nextAllowedAt: now + 60 * 1000,
      createdAt: now,
      channel,
    });

    // tujuan kirim OTP
    if (channel === "email") {
      const user = await authAdmin.getUser(uid);
      const email = user.email;
      if (!email) return res.status(400).json({ ok: false, message: "User tidak punya email login." });
      await sendOtpEmail(email, otp);
    } else {
      const userDoc = await dbAdmin.collection("users").doc(uid).get();
      const phone = userDoc.get("phone");
      if (!phone) return res.status(400).json({ ok: false, message: "Nomor HP belum diisi." });
      await sendOtpWhatsapp(phone, otp);
    }

    return res.status(200).json({ ok: true, message: "OTP terkirim." });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message || "Server error" });
  }
};
