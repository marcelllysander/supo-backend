// lib/handlers/otp/auth-password-otp.js
const { admin, authAdmin, dbAdmin } = require("../../firebaseAdmin");
const { sendOtpEmail } = require("../../mailer");
const { sendOtpWhatsapp, sendOtpSms } = require("../../whatsapp");
const { normalizeEmail, isValidEmail, emailDocId, genOtp6, otpHash, isPasswordStrong, normalizePhoneE164, isValidPhoneE164 } = require("../../otpUtil");

const FieldValue = admin.firestore.FieldValue;

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

function getFlow(body) {
  const flow = String(body.flow || "")
    .trim()
    .toLowerCase();
  if (flow) return flow;

  const purpose = String(body.purpose || "")
    .trim()
    .toLowerCase();
  const hasName = !!String(body.firstName || "").trim() || !!String(body.lastName || "").trim();
  const hasPhone = !!String(body.phone || "").trim();
  const hasConfirmPassword = !!String(body.confirmPassword || "").trim();

  if (purpose === "email" || purpose === "phone" || hasName || hasPhone || hasConfirmPassword) {
    return "signup";
  }

  return "password_reset";
}

function getStep(body) {
  return String(body.step || body.mode || "")
    .trim()
    .toLowerCase();
}

function isUserNotFoundError(e) {
  const code = e?.code || "";
  return code === "auth/user-not-found" || code === "USER_NOT_FOUND";
}

async function getUserByEmailOrNull(emailLower) {
  try {
    return await authAdmin.getUserByEmail(emailLower);
  } catch (e) {
    if (isUserNotFoundError(e)) return null;
    throw e;
  }
}

async function getUserByPhoneOrNull(phoneE164) {
  try {
    return await authAdmin.getUserByPhoneNumber(phoneE164);
  } catch (e) {
    if (isUserNotFoundError(e)) return null;
    throw e;
  }
}

function getRegistrationRef(emailLower) {
  const docId = emailDocId(emailLower);
  return dbAdmin.collection("account_registrations").doc(docId);
}

function getPhoneRegistryRef(phoneE164) {
  return dbAdmin.collection("phone_registry").doc(phoneE164);
}

/* -------------------------------------------------------------------------- */
/*                              PASSWORD RESET FLOW                            */
/* -------------------------------------------------------------------------- */

async function handlePasswordResetRequest(req, res, body) {
  const emailLower = normalizeEmail(body.email);

  if (!isValidEmail(emailLower)) {
    return res.status(400).json({ ok: false, message: "Email tidak valid." });
  }

  const user = await getUserByEmailOrNull(emailLower);
  if (!user) {
    return res.status(404).json({ ok: false, message: "Email tidak terdaftar." });
  }

  const docId = emailDocId(emailLower);
  const ref = dbAdmin.collection("password_reset_otps").doc(docId);
  const snap = await ref.get();

  const now = Date.now();

  if (snap.exists) {
    const nextAllowedAt = snap.get("nextAllowedAt");
    if (nextAllowedAt && now < nextAllowedAt) {
      return res.status(429).json({
        ok: false,
        message: "Tunggu sebentar sebelum minta OTP lagi.",
      });
    }
  }

  const otp = genOtp6();

  await ref.set({
    email: emailLower,
    otpHash: otpHash(otp),
    expiresAt: now + 10 * 60 * 1000,
    attempts: 0,
    nextAllowedAt: now + 60 * 1000,
    createdAt: now,
    updatedAt: now,
  });

  await sendOtpEmail(emailLower, otp, {
    subject: "Kode OTP Reset Password SUPO",
    heading: "Reset Password SUPO",
    intro: "Kode OTP kamu:",
  });

  return res.status(200).json({ ok: true, message: "OTP terkirim." });
}

async function handlePasswordResetConfirm(req, res, body) {
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
    return res.status(400).json({
      ok: false,
      message: "Password baru tidak memenuhi syarat.",
    });
  }

  const docId = emailDocId(emailLower);
  const ref = dbAdmin.collection("password_reset_otps").doc(docId);
  const snap = await ref.get();

  if (!snap.exists) {
    return res.status(400).json({
      ok: false,
      message: "OTP tidak ditemukan / sudah kadaluarsa.",
    });
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
    return res.status(429).json({
      ok: false,
      message: "Terlalu banyak percobaan. Minta OTP baru.",
    });
  }

  if (otpHash(otp) !== snap.get("otpHash")) {
    await ref.update({ attempts: attempts + 1, updatedAt: now });
    return res.status(400).json({ ok: false, message: "OTP salah." });
  }

  const user = await getUserByEmailOrNull(emailLower);
  if (!user) {
    await ref.delete().catch(() => {});
    return res.status(404).json({ ok: false, message: "Email tidak terdaftar." });
  }

  await authAdmin.updateUser(user.uid, { password: newPassword });
  await authAdmin.revokeRefreshTokens(user.uid);
  await ref.delete().catch(() => {});

  return res.status(200).json({
    ok: true,
    message: "Password berhasil direset. Silakan login ulang.",
  });
}

/* -------------------------------------------------------------------------- */
/*                                  SIGNUP FLOW                               */
/* -------------------------------------------------------------------------- */

async function handleSignupRequest(req, res, body) {
  const purpose = String(body.purpose || "")
    .trim()
    .toLowerCase();
  const channel = String(body.channel || "")
    .trim()
    .toLowerCase();
  const firstName = String(body.firstName || "").trim();
  const lastName = String(body.lastName || "").trim();
  const emailLower = normalizeEmail(body.email);
  const rawPhone = String(body.phone || "").trim();
  const phoneE164 = rawPhone ? normalizePhoneE164(rawPhone) : "";

  if (!["email", "phone"].includes(purpose)) {
    return res.status(400).json({ ok: false, message: "purpose tidak valid." });
  }

  if (!firstName || !lastName) {
    return res.status(400).json({
      ok: false,
      message: "Nama depan dan nama belakang wajib diisi.",
    });
  }

  if (!isValidEmail(emailLower)) {
    return res.status(400).json({ ok: false, message: "Email tidak valid." });
  }

  if (rawPhone && !isValidPhoneE164(phoneE164)) {
    return res.status(400).json({
      ok: false,
      message: "Nomor HP tidak valid. Gunakan format internasional, misalnya +628xxxx.",
    });
  }

  const existingEmailUser = await getUserByEmailOrNull(emailLower);
  if (existingEmailUser) {
    return res.status(409).json({
      ok: false,
      message: "Email sudah terdaftar. Silakan login.",
    });
  }

  if (purpose === "phone") {
    if (!phoneE164) {
      return res.status(400).json({
        ok: false,
        message: "Nomor HP wajib diisi untuk verifikasi OTP nomor HP.",
      });
    }

    const existingPhoneUser = await getUserByPhoneOrNull(phoneE164);
    if (existingPhoneUser) {
      return res.status(409).json({
        ok: false,
        message: "Nomor HP sudah terdaftar. Gunakan nomor lain.",
      });
    }
  }

  const ref = getRegistrationRef(emailLower);
  const snap = await ref.get();
  const now = Date.now();

  const prevPhone = snap.exists ? String(snap.get("phoneE164") || "") : "";
  const phoneChanged = prevPhone !== phoneE164;

  const baseData = {
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`.trim(),
    email: emailLower,
    phoneE164: phoneE164 || "",
    status: "PENDING",
    createdAt: snap.exists ? snap.get("createdAt") || now : now,
    updatedAt: now,
    expireAt: admin.firestore.Timestamp.fromMillis(now + 24 * 60 * 60 * 1000),
  };

  if (phoneChanged) {
    baseData.phoneVerifiedAt = FieldValue.delete();
    baseData.phoneOtpHash = FieldValue.delete();
    baseData.phoneOtpExpiresAt = FieldValue.delete();
    baseData.phoneOtpAttempts = FieldValue.delete();
    baseData.phoneNextAllowedAt = FieldValue.delete();
    baseData.phoneOtpChannel = FieldValue.delete();
  }

  // Simpan/update data dasar registrasi dulu
  await ref.set(baseData, { merge: true });

  const freshSnap = await ref.get();

  const nextAllowedField = purpose === "email" ? "emailNextAllowedAt" : "phoneNextAllowedAt";
  const nextAllowedAt = freshSnap.exists ? freshSnap.get(nextAllowedField) : 0;

  if (nextAllowedAt && now < nextAllowedAt) {
    return res.status(429).json({
      ok: false,
      message: "Tunggu sebentar sebelum minta OTP lagi.",
    });
  }

  const otp = genOtp6();
  const updateData = {
    updatedAt: now,
  };

  if (purpose === "email") {
    // Penting:
    // setiap kali user request OTP email signup lagi,
    // reset status verifikasi email lama agar OTP baru wajib diverifikasi ulang
    updateData.emailVerifiedAt = FieldValue.delete();
    updateData.emailOtpHash = otpHash(otp);
    updateData.emailOtpExpiresAt = now + 10 * 60 * 1000;
    updateData.emailOtpAttempts = 0;
    updateData.emailNextAllowedAt = now + 60 * 1000;
  } else {
    // phone flow tetap normal
    const alreadyPhoneVerified = freshSnap.exists && !!freshSnap.get("phoneVerifiedAt");
    if (alreadyPhoneVerified && !phoneChanged) {
      return res.status(200).json({
        ok: true,
        message: "Nomor HP sudah diverifikasi.",
      });
    }

    updateData.phoneOtpHash = otpHash(otp);
    updateData.phoneOtpExpiresAt = now + 10 * 60 * 1000;
    updateData.phoneOtpAttempts = 0;
    updateData.phoneNextAllowedAt = now + 60 * 1000;
    updateData.phoneOtpChannel = channel;
    updateData.phoneVerifiedAt = FieldValue.delete();
  }

  await ref.set(updateData, { merge: true });

  try {
    if (purpose === "email") {
      await sendOtpEmail(emailLower, otp, {
        subject: "Kode OTP Registrasi SUPO",
        heading: "Verifikasi Email Registrasi SUPO",
        intro: "Masukkan kode OTP berikut untuk menyelesaikan pendaftaran akun:",
      });
    } else if (channel === "whatsapp") {
      await sendOtpWhatsapp(phoneE164, otp);
    } else {
      await sendOtpSms(phoneE164, otp);
    }

    return res.status(200).json({
      ok: true,
      message: "OTP terkirim.",
    });
  } catch (e) {
    const rollback = {
      updatedAt: Date.now(),
    };

    if (purpose === "email") {
      rollback.emailOtpHash = FieldValue.delete();
      rollback.emailOtpExpiresAt = FieldValue.delete();
      rollback.emailOtpAttempts = FieldValue.delete();
      rollback.emailNextAllowedAt = FieldValue.delete();
    } else {
      rollback.phoneOtpHash = FieldValue.delete();
      rollback.phoneOtpExpiresAt = FieldValue.delete();
      rollback.phoneOtpAttempts = FieldValue.delete();
      rollback.phoneNextAllowedAt = FieldValue.delete();
      rollback.phoneOtpChannel = FieldValue.delete();
    }

    try {
      const latestSnap = await ref.get();
      const hasEmailVerified = latestSnap.exists && !!latestSnap.get("emailVerifiedAt");
      const hasPhoneVerified = latestSnap.exists && !!latestSnap.get("phoneVerifiedAt");

      if (!hasEmailVerified && !hasPhoneVerified) {
        await ref.delete();
      } else {
        await ref.update(rollback);
      }
    } catch (_) {}

    throw e;
  }
}

async function handleSignupVerify(req, res, body) {
  const purpose = String(body.purpose || "")
    .trim()
    .toLowerCase();
  const emailLower = normalizeEmail(body.email);
  const rawPhone = String(body.phone || "").trim();
  const phoneE164 = rawPhone ? normalizePhoneE164(rawPhone) : "";
  const otp = String(body.otp || "").trim();

  if (!["email", "phone"].includes(purpose)) {
    return res.status(400).json({ ok: false, message: "purpose tidak valid." });
  }

  if (!isValidEmail(emailLower)) {
    return res.status(400).json({ ok: false, message: "Email tidak valid." });
  }

  if (purpose === "phone") {
    if (!phoneE164 || !isValidPhoneE164(phoneE164)) {
      return res.status(400).json({
        ok: false,
        message: "Nomor HP tidak valid.",
      });
    }
  }

  if (!/^\d{6}$/.test(otp)) {
    return res.status(400).json({ ok: false, message: "OTP harus 6 digit." });
  }

  const ref = getRegistrationRef(emailLower);
  const snap = await ref.get();

  if (!snap.exists) {
    return res.status(400).json({
      ok: false,
      message: "Data registrasi tidak ditemukan / sudah kadaluarsa.",
    });
  }

  if (purpose === "phone") {
    const storedPhone = String(snap.get("phoneE164") || "");
    if (!storedPhone) {
      return res.status(400).json({
        ok: false,
        message: "Nomor HP belum tersimpan pada data registrasi.",
      });
    }

    if (storedPhone !== phoneE164) {
      return res.status(400).json({
        ok: false,
        message: "Nomor HP tidak sesuai dengan data registrasi.",
      });
    }
  }

  const now = Date.now();

  const hashField = purpose === "email" ? "emailOtpHash" : "phoneOtpHash";
  const expiresField = purpose === "email" ? "emailOtpExpiresAt" : "phoneOtpExpiresAt";
  const attemptsField = purpose === "email" ? "emailOtpAttempts" : "phoneOtpAttempts";
  const verifiedField = purpose === "email" ? "emailVerifiedAt" : "phoneVerifiedAt";
  const nextAllowedField = purpose === "email" ? "emailNextAllowedAt" : "phoneNextAllowedAt";

  if (snap.get(verifiedField)) {
    return res.status(200).json({
      ok: true,
      message: purpose === "email" ? "Email sudah diverifikasi." : "Nomor HP sudah diverifikasi.",
    });
  }

  const expiresAt = snap.get(expiresField);
  const attempts = snap.get(attemptsField) || 0;
  const expectedHash = snap.get(hashField);

  if (!expectedHash) {
    return res.status(400).json({
      ok: false,
      message: "OTP tidak ditemukan. Silakan minta OTP baru.",
    });
  }

  if (expiresAt && now > expiresAt) {
    await ref.update({
      [hashField]: FieldValue.delete(),
      [expiresField]: FieldValue.delete(),
      [attemptsField]: FieldValue.delete(),
      [nextAllowedField]: FieldValue.delete(),
      updatedAt: now,
    });
    return res.status(400).json({ ok: false, message: "OTP sudah kadaluarsa." });
  }

  if (attempts >= 5) {
    await ref.update({
      [hashField]: FieldValue.delete(),
      [expiresField]: FieldValue.delete(),
      [attemptsField]: FieldValue.delete(),
      [nextAllowedField]: FieldValue.delete(),
      updatedAt: now,
    });
    return res.status(429).json({
      ok: false,
      message: "Terlalu banyak percobaan. Minta OTP baru.",
    });
  }

  if (otpHash(otp) !== expectedHash) {
    await ref.update({
      [attemptsField]: attempts + 1,
      updatedAt: now,
    });
    return res.status(400).json({ ok: false, message: "OTP salah." });
  }

  await ref.update({
    [verifiedField]: now,
    [hashField]: FieldValue.delete(),
    [expiresField]: FieldValue.delete(),
    [attemptsField]: FieldValue.delete(),
    [nextAllowedField]: FieldValue.delete(),
    updatedAt: now,
  });

  return res.status(200).json({
    ok: true,
    message: purpose === "email" ? "Email berhasil diverifikasi." : "Nomor HP berhasil diverifikasi.",
  });
}

async function handleSignupComplete(req, res, body) {
  const emailLower = normalizeEmail(body.email);
  const password = String(body.password || "");
  const confirmPassword = String(body.confirmPassword || "");
  const rawPhoneFromBody = String(body.phone || "").trim();
  const phoneFromBody = rawPhoneFromBody ? normalizePhoneE164(rawPhoneFromBody) : "";

  if (!isValidEmail(emailLower)) {
    return res.status(400).json({ ok: false, message: "Email tidak valid." });
  }

  if (password !== confirmPassword) {
    return res.status(400).json({
      ok: false,
      message: "Konfirmasi password tidak sama.",
    });
  }

  if (!isPasswordStrong(password)) {
    return res.status(400).json({
      ok: false,
      message: "Password tidak memenuhi syarat keamanan.",
    });
  }

  if (rawPhoneFromBody && !isValidPhoneE164(phoneFromBody)) {
    return res.status(400).json({
      ok: false,
      message: "Nomor HP tidak valid.",
    });
  }

  const ref = getRegistrationRef(emailLower);
  const snap = await ref.get();

  if (!snap.exists) {
    return res.status(400).json({
      ok: false,
      message: "Data registrasi tidak ditemukan.",
    });
  }

  const firstName = String(snap.get("firstName") || "").trim();
  const lastName = String(snap.get("lastName") || "").trim();
  const fullName = String(snap.get("fullName") || "").trim();

  // prioritaskan nomor HP terbaru dari body
  const storedPhone = normalizePhoneE164(String(snap.get("phoneE164") || ""));
  const finalPhoneE164 = phoneFromBody || storedPhone || "";

  if (!snap.get("emailVerifiedAt")) {
    return res.status(400).json({
      ok: false,
      message: "Email belum diverifikasi.",
    });
  }

  const existingEmailUser = await getUserByEmailOrNull(emailLower);
  if (existingEmailUser) {
    return res.status(409).json({
      ok: false,
      message: "Email sudah terdaftar. Silakan login.",
    });
  }

  if (finalPhoneE164) {
    const phoneRegistryRef = getPhoneRegistryRef(finalPhoneE164);
    const phoneRegistrySnap = await phoneRegistryRef.get();
    if (phoneRegistrySnap.exists) {
      return res.status(409).json({
        ok: false,
        message: "Nomor HP sudah digunakan. Gunakan nomor lain.",
      });
    }
  }

  let createdUser = null;

  try {
    createdUser = await authAdmin.createUser({
      email: emailLower,
      emailVerified: true,
      password,
      displayName: fullName || undefined,
      disabled: false,
    });

    const uid = createdUser.uid;
    const username = `supo_${uid.slice(0, 6).toLowerCase()}`;

    const userData = {
      uid,
      firstName,
      lastName,
      fullName,
      displayName: fullName,
      email: emailLower,
      phone: finalPhoneE164 || "",
      phoneE164: finalPhoneE164 || "",
      phoneVerified: false,
      phoneVerifiedVia: "",
      telegramUserId: "",
      telegramUsername: "",
      telegramVerifiedAt: null,
      emailVerified: true,
      username,
      usernameChanged: false,
      photoUrl: "",
      photoPath: "",
      companyName: "",
      role: "",
      verificationType: "",
      verificationStatus: "NOT_VERIFIED",
      canCheckout: false,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    const userRef = dbAdmin.collection("users").doc(uid);
    const usernameRef = dbAdmin.collection("usernames").doc(username);
    const publicProfileRef = dbAdmin.collection("publicProfiles").doc(uid);

    const batch = dbAdmin.batch();

    batch.set(userRef, userData, { merge: true });

    batch.set(
      usernameRef,
      {
        uid,
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    batch.set(
      publicProfileRef,
      {
        displayName: fullName,
        username,
        photoUrl: "",
        role: "",
        verificationStatus: "NOT_VERIFIED",
      },
      { merge: true },
    );

    if (finalPhoneE164) {
      const phoneRegistryRef = getPhoneRegistryRef(finalPhoneE164);
      batch.set(
        phoneRegistryRef,
        {
          uid,
          phoneE164: finalPhoneE164,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }

    // simpan juga perubahan terakhir ke account_registrations sebelum delete
    batch.set(
      ref,
      {
        phoneE164: finalPhoneE164 || "",
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    await batch.commit();

    await ref.delete().catch(() => {});

    return res.status(200).json({
      ok: true,
      message: "Registrasi berhasil. Silakan login.",
      uid,
    });
  } catch (e) {
    if (createdUser?.uid) {
      await authAdmin.deleteUser(createdUser.uid).catch(() => {});
    }
    throw e;
  }
}

/* -------------------------------------------------------------------------- */
/*                                   HANDLER                                  */
/* -------------------------------------------------------------------------- */

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const body = await parseBody(req);
    const flow = getFlow(body);
    const step = getStep(body);

    console.log("AUTH OTP body:", body);
    console.log("AUTH OTP flow:", flow, "step:", step);

    if (flow === "signup") {
      if (step === "request") {
        return await handleSignupRequest(req, res, body);
      }

      if (step === "verify" || step === "confirm") {
        return await handleSignupVerify(req, res, body);
      }

      if (step === "complete") {
        return await handleSignupComplete(req, res, body);
      }

      return res.status(400).json({
        ok: false,
        message: "step signup tidak valid. Gunakan 'request', 'verify', atau 'complete'.",
      });
    }

    if (step === "request") {
      return await handlePasswordResetRequest(req, res, body);
    }

    if (step === "confirm") {
      return await handlePasswordResetConfirm(req, res, body);
    }

    return res.status(400).json({
      ok: false,
      message: "step tidak valid. Gunakan 'request' atau 'confirm'.",
    });
  } catch (e) {
    console.error("AUTH OTP ERROR:", e);
    return res.status(500).json({
      ok: false,
      message: e?.message || "Server error",
    });
  }
};
