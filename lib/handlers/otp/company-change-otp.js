// lib/handlers/otp/company-change-otp.js
const { dbAdmin } = require("../../firebaseAdmin");
const { requireAuth } = require("../../authMiddleware");
const { genOtp6, otpHash } = require("../../otpUtil");
const { sendOtpEmail } = require("../../mailer");
const { sendOtpWhatsapp } = require("../../whatsapp");

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
    .toLowerCase(); // request | verify
}

function getOtpDocRef(uid, action) {
  const docId = Buffer.from(`${uid}:${action}`).toString("base64url");
  return dbAdmin.collection("company_change_otps").doc(docId);
}

async function loadCompanyOrSupplierProfile(uid) {
  let profileSnap = await dbAdmin.collection("companies").doc(uid).get();
  if (!profileSnap.exists) {
    profileSnap = await dbAdmin.collection("suppliers").doc(uid).get();
  }
  return profileSnap;
}

async function handleRequest(req, res, decoded, body) {
  const uid = decoded.uid;

  const action = String(body.action || "").trim(); // change_email | change_phone
  const channel = String(body.channel || "").trim(); // email | whatsapp

  if (!["change_email", "change_phone"].includes(action)) {
    return res.status(400).json({ ok: false, message: "action tidak valid" });
  }
  if (!["email", "whatsapp"].includes(channel)) {
    return res.status(400).json({ ok: false, message: "channel tidak valid" });
  }

  // 1) Ambil profil: companies/{uid} -> fallback suppliers/{uid}
  const profileSnap = await loadCompanyOrSupplierProfile(uid);
  if (!profileSnap.exists) {
    return res.status(404).json({ ok: false, message: "Data tidak ditemukan (companies/suppliers)." });
  }

  const oldEmail = profileSnap.get("companyEmail");
  const oldPhone = profileSnap.get("companyPhone");

  // 2) rate limit per uid+action
  const ref = getOtpDocRef(uid, action);
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
    if (!oldEmail) {
      return res.status(400).json({ ok: false, message: "Email lama belum ada." });
    }
    await sendOtpEmail(oldEmail, otp);
  } else {
    if (!oldPhone) {
      return res.status(400).json({ ok: false, message: "Nomor HP lama belum ada." });
    }
    if (!String(oldPhone).startsWith("+")) {
      return res.status(400).json({ ok: false, message: "Nomor HP lama harus format +62xxxx" });
    }
    await sendOtpWhatsapp(oldPhone, otp);
  }

  return res.status(200).json({ ok: true, message: "OTP terkirim." });
}

async function handleVerify(req, res, decoded, body) {
  const uid = decoded.uid;

  const action = String(body.action || "").trim(); // change_email | change_phone
  const otp = String(body.otp || "").trim();

  if (!["change_email", "change_phone"].includes(action)) {
    return res.status(400).json({ ok: false, message: "action tidak valid" });
  }
  if (!/^\d{6}$/.test(otp)) {
    return res.status(400).json({ ok: false, message: "OTP harus 6 digit." });
  }

  const ref = getOtpDocRef(uid, action);
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

  if (otpHash(otp) !== snap.get("otpHash")) {
    await ref.update({ attempts: attempts + 1 });
    return res.status(400).json({ ok: false, message: "OTP salah." });
  }

  await ref.delete().catch(() => {});
  return res.status(200).json({ ok: true, message: "OTP valid." });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const decoded = await requireAuth(req);
    const body = await parseBody(req);
    const step = getStep(body);

    if (step === "request") {
      return await handleRequest(req, res, decoded, body);
    }

    if (step === "verify") {
      return await handleVerify(req, res, decoded, body);
    }

    return res.status(400).json({
      ok: false,
      message: "step tidak valid. Gunakan 'request' atau 'verify'.",
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message || "Server error" });
  }
};
