const { authAdmin, dbAdmin } = require("../../lib/firebaseAdmin");
const { normalizeEmail, isValidEmail, emailDocId, otpHash, isPasswordStrong } = require("../../lib/otpUtil");

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
    const body = await parseBody(req);

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
      await ref.delete();
      return res.status(400).json({ ok: false, message: "OTP sudah kadaluarsa." });
    }

    if (attempts >= 5) {
      await ref.delete();
      return res.status(429).json({ ok: false, message: "Terlalu banyak percobaan. Minta OTP baru." });
    }

    const expected = snap.get("otpHash");
    const given = otpHash(otp);

    if (given !== expected) {
      await ref.update({ attempts: attempts + 1 });
      return res.status(400).json({ ok: false, message: "OTP salah." });
    }

    function isUserNotFoundError(e) {
      const code = e?.code || "";
      return code === "auth/user-not-found" || code === "USER_NOT_FOUND";
    }

    // ...

    let user;
    try {
      user = await authAdmin.getUserByEmail(emailLower);
    } catch (e) {
      if (isUserNotFoundError(e)) {
        // optional: bersihkan OTP kalau ada
        await ref.delete().catch(() => {});
        return res.status(404).json({ ok: false, message: "Email tidak terdaftar." });
      }
      throw e;
    }

    await authAdmin.updateUser(user.uid, { password: newPassword });

    // paksa login ulang (recommended)
    await authAdmin.revokeRefreshTokens(user.uid);

    await ref.delete();

    return res.status(200).json({ ok: true, message: "Password berhasil direset. Silakan login ulang." });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message || "Server error" });
  }
};
