const { dbAdmin } = require("../../lib/firebaseAdmin");
const { requireAuth } = require("../../lib/authMiddleware");
const { otpHash } = require("../../lib/otpUtil");

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
    const purpose = String(body.purpose || "").trim();
    const otp = String(body.otp || "").trim();

    if (!["email", "phone"].includes(purpose)) {
      return res.status(400).json({ ok: false, message: "purpose tidak valid" });
    }
    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({ ok: false, message: "OTP harus 6 digit." });
    }

    const docId = Buffer.from(`${uid}:${purpose}`).toString("base64url");
    const ref = dbAdmin.collection("profile_verify_otps").doc(docId);
    const snap = await ref.get();

    if (!snap.exists) return res.status(400).json({ ok: false, message: "OTP tidak ditemukan / sudah kadaluarsa." });

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
    if (otpHash(otp) !== expected) {
      await ref.update({ attempts: attempts + 1 });
      return res.status(400).json({ ok: false, message: "OTP salah." });
    }

    // sukses: hapus agar sekali pakai
    await ref.delete().catch(() => {});

    return res.status(200).json({ ok: true, message: "OTP valid." });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message || "Server error" });
  }
};
