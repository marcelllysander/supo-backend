const { dbAdmin } = require("../../lib/firebaseAdmin");
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
    const action = String(body.action || "").trim(); // change_email | change_phone
    const channel = String(body.channel || "").trim(); // email | whatsapp

    if (!["change_email", "change_phone"].includes(action)) {
      return res.status(400).json({ ok: false, message: "action tidak valid" });
    }
    if (!["email", "whatsapp"].includes(channel)) {
      return res.status(400).json({ ok: false, message: "channel tidak valid" });
    }

    // Ambil kontak lama dari companies/{uid}
    const cSnap = await dbAdmin.collection("companies").doc(uid).get();
    if (!cSnap.exists) return res.status(404).json({ ok: false, message: "Company tidak ditemukan" });

    const oldEmail = cSnap.get("companyEmail");
    const oldPhone = cSnap.get("companyPhone");

    // rate limit per uid+action
    const docId = Buffer.from(`${uid}:${action}`).toString("base64url");
    const ref = dbAdmin.collection("company_change_otps").doc(docId);
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
      action,
      otpHash: otpHash(otp),
      expiresAt: now + 10 * 60 * 1000,
      attempts: 0,
      nextAllowedAt: now + 60 * 1000,
      createdAt: now,
      channel,
    });

    if (channel === "email") {
      if (!oldEmail) return res.status(400).json({ ok: false, message: "Email lama belum ada." });
      await sendOtpEmail(oldEmail, otp);
    } else {
      if (!oldPhone) return res.status(400).json({ ok: false, message: "Nomor HP lama belum ada." });
      await sendOtpWhatsapp(oldPhone, otp);
    }

    return res.status(200).json({ ok: true, message: "OTP terkirim." });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message || "Server error" });
  }
};
