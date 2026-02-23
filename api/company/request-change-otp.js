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
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

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

    // 1) Ambil profil: companies/{uid} -> fallback suppliers/{uid}
    let profileSnap = await dbAdmin.collection("companies").doc(uid).get();
    if (!profileSnap.exists) {
      profileSnap = await dbAdmin.collection("suppliers").doc(uid).get();
    }
    if (!profileSnap.exists) {
      return res.status(404).json({ ok: false, message: "Data tidak ditemukan (companies/suppliers)." });
    }

    const oldEmail = profileSnap.get("companyEmail");
    const oldPhone = profileSnap.get("companyPhone");

    // 2) rate limit per uid+action
    const docId = Buffer.from(`${uid}:${action}`).toString("base64url");
    const ref = dbAdmin.collection("company_change_otps").doc(docId);

    const otpSnap = await ref.get();
    const now = Date.now();

    if (otpSnap.exists) {
      const nextAllowedAt = otpSnap.get("nextAllowedAt");
      if (nextAllowedAt && now < nextAllowedAt) {
        return res.status(429).json({ ok: false, message: "Tunggu sebentar sebelum minta OTP lagi." });
      }
    }

    // 3) simpan OTP
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

    // 4) kirim OTP
    if (channel === "email") {
      if (!oldEmail) return res.status(400).json({ ok: false, message: "Email lama belum ada." });
      await sendOtpEmail(oldEmail, otp);
    } else {
      if (!oldPhone) return res.status(400).json({ ok: false, message: "Nomor HP lama belum ada." });
      if (!String(oldPhone).startsWith("+")) {
        return res.status(400).json({ ok: false, message: "Nomor HP lama harus format +62xxxx" });
      }
      await sendOtpWhatsapp(oldPhone, otp);
    }

    return res.status(200).json({ ok: true, message: "OTP terkirim." });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message || "Server error" });
  }
};
