// api/auth/password-otp.js
const { admin, authAdmin, dbAdmin } = require("../../lib/firebaseAdmin");
const { sendOtpEmail } = require("../../lib/mailer");
const { sendOtpWhatsapp, sendOtpSms } = require("../../lib/whatsapp");
const {
  normalizeEmail,
  isValidEmail,
  emailDocId,
  genOtp6,
  otpHash,
  isPasswordStrong,
  normalizePhoneE164,
  isValidPhoneE164,
} = require("../../lib/otpUtil");

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
  return String(body.flow || "password_reset")
    .trim()
    .toLowerCase(); // password_reset | signup
}

function getStep(body) {
  return String(body.step || body.mode || "")
    .trim()
    .toLowerCase(); // request | confirm | verify | complete
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
  const purpose = String(body.purpose || "").trim().toLowerCase(); // email | phone
  const channel = String(body.channel || "").trim().toLowerCase(); // whatsapp | sms
  const firstName = String(body.firstName || "").trim();
  const lastName = String(body.lastName || "").trim();
  const emailLower = normalizeEmail(body.email);
  const phoneE164 = normalizePhoneE164(body.phone);

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

  if (!isValidPhoneE164(phoneE164)) {
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

  const existingPhoneUser = await getUserByPhoneOrNull(phoneE164);
  if (existingPhoneUser) {
    return res.status(409).json({
      ok: false,
      message: "Nomor HP sudah terdaftar. Gunakan nomor lain.",
    });
  }

  if (purpose === "phone" && !["whatsapp", "sms"].includes(channel)) {
    return res.status(400).json({
      ok: false,
      message: "channel tidak valid. Gunakan whatsapp atau sms.",
    });
  }

  const ref = getRegistrationRef(emailLower);
  const snap = await ref.get();
  const now = Date.now();

  const prevPhone = snap.exists ? String(snap.get("phoneE164") || "") : "";
  const phoneChanged = prevPhone && prevPhone !== phoneE164;

  if (purpose === "email" && snap.exists && snap.get("emailVerifiedAt")) {
    return res.status(200).json({
      ok: true,
      message: "Email sudah diverifikasi.",
    });
  }

  if (purpose === "phone" && snap.exists && snap.get("phoneVerifiedAt") && !phoneChanged) {
    return res.status(200).json({
      ok: true,
      message: "Nomor HP sudah diverifikasi.",
    });
  }

  const nextAllowedField = purpose === "email" ? "emailNextAllowedAt" : "phoneNextAllowedAt";
  const nextAllowedAt = snap.exists ? snap.get(nextAllowedField) : 0;

  if (nextAllowedAt && now < nextAllowedAt) {
    return res.status(429).json({
      ok: false,
      message: "Tunggu sebentar sebelum minta OTP lagi.",
    });
  }

  const otp = genOtp6();

  const baseData = {
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`.trim(),
    email: emailLower,
    phoneE164,
    status: "PENDING",
    createdAt: snap.exists ? snap.get("createdAt") || now : now,
    updatedAt: now,
  };

  const updateData = { ...baseData };

  if (phoneChanged) {
    updateData.phoneVerifiedAt = FieldValue.delete();
    updateData.phoneOtpHash = FieldValue.delete();
    updateData.phoneOtpExpiresAt = FieldValue.delete();
    updateData.phoneOtpAttempts = FieldValue.delete();
    updateData.phoneNextAllowedAt = FieldValue.delete();
    updateData.phoneOtpChannel = FieldValue.delete();
  }

  if (purpose === "email") {
    updateData.emailOtpHash = otpHash(otp);
    updateData.emailOtpExpiresAt = now + 10 * 60 * 1000;
    updateData.emailOtpAttempts = 0;
    updateData.emailNextAllowedAt = now + 60 * 1000;
  } else {
    updateData.phoneOtpHash = otpHash(otp);
    updateData.phoneOtpExpiresAt = now + 10 * 60 * 1000;
    updateData.phoneOtpAttempts = 0;
    updateData.phoneNextAllowedAt = now + 60 * 1000;
    updateData.phoneOtpChannel = channel;
  }

  await ref.set(updateData, { merge: true });

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

  return res.status(200).json({ ok: true, message: "OTP terkirim." });
}

async function handleSignupVerify(req, res, body) {
  const purpose = String(body.purpose || "").trim().toLowerCase(); // email | phone
  const emailLower = normalizeEmail(body.email);
  const phoneE164 = normalizePhoneE164(body.phone);
  const otp = String(body.otp || "").trim();

  if (!["email", "phone"].includes(purpose)) {
    return res.status(400).json({ ok: false, message: "purpose tidak valid." });
  }

  if (!isValidEmail(emailLower)) {
    return res.status(400).json({ ok: false, message: "Email tidak valid." });
  }

  if (purpose === "phone" && !isValidPhoneE164(phoneE164)) {
    return res.status(400).json({
      ok: false,
      message: "Nomor HP tidak valid.",
    });
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
  const phoneE164 = normalizePhoneE164(snap.get("phoneE164"));

  if (!snap.get("emailVerifiedAt")) {
    return res.status(400).json({
      ok: false,
      message: "Email belum diverifikasi.",
    });
  }

  if (!snap.get("phoneVerifiedAt")) {
    return res.status(400).json({
      ok: false,
      message: "Nomor HP belum diverifikasi.",
    });
  }

  const existingEmailUser = await getUserByEmailOrNull(emailLower);
  if (existingEmailUser) {
    return res.status(409).json({
      ok: false,
      message: "Email sudah terdaftar. Silakan login.",
    });
  }

  const existingPhoneUser = await getUserByPhoneOrNull(phoneE164);
  if (existingPhoneUser) {
    return res.status(409).json({
      ok: false,
      message: "Nomor HP sudah terdaftar. Gunakan nomor lain.",
    });
  }

  let createdUser = null;

  try {
    createdUser = await authAdmin.createUser({
      email: emailLower,
      emailVerified: true,
      password,
      displayName: fullName || undefined,
      phoneNumber: phoneE164,
      disabled: false,
    });

    const username = `supo_${createdUser.uid.slice(0, 6).toLowerCase()}`;

    const userData = {
      uid: createdUser.uid,

      firstName,
      lastName,
      fullName,
      displayName: fullName,

      email: emailLower,
      phone: phoneE164,
      phoneE164,

      emailVerified: true,
      phoneVerified: true,

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

    const userRef = dbAdmin.collection("users").doc(createdUser.uid);
    const usernameRef = dbAdmin.collection("usernames").doc(username);
    const publicProfileRef = dbAdmin.collection("publicProfiles").doc(createdUser.uid);

    const batch = dbAdmin.batch();

    batch.set(userRef, userData, { merge: true });

    batch.set(
      usernameRef,
      {
        uid: createdUser.uid,
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
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
      { merge: true }
    );

    await batch.commit();

    await ref.delete().catch(() => {});

    return res.status(200).json({
      ok: true,
      message: "Registrasi berhasil. Silakan login.",
      uid: createdUser.uid,
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

    // signup flow
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

    // default: password reset
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
    return res.status(500).json({
      ok: false,
      message: e?.message || "Server error",
    });
  }
};