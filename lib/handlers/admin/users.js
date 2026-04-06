// lib/handlers/admin/users.js
const { admin, authAdmin, dbAdmin } = require("../../firebaseAdmin");

function json(res, code, data) {
  res.status(code).json(data);
}

function str(v) {
  return String(v || "").trim();
}

module.exports = async (req, res, decoded, body) => {
  try {
    const action = str(body.action).toLowerCase();
    const uid = str(body.uid);
    const reason = str(body.reason);
    const adminUid = decoded.uid;

    if (!uid) {
      return json(res, 400, { ok: false, message: "uid wajib diisi." });
    }

    const userRef = dbAdmin.collection("users").doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return json(res, 404, { ok: false, message: "User tidak ditemukan." });
    }

    if (action === "warn") {
      if (!reason) {
        return json(res, 400, { ok: false, message: "Alasan warning wajib diisi." });
      }

      await userRef.set(
        {
          accountStatus: "ACTIVE",
          warningCount: admin.firestore.FieldValue.increment(1),
          lastWarningReason: reason,
          lastWarningAt: admin.firestore.FieldValue.serverTimestamp(),
          lastWarnedByUid: adminUid,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return json(res, 200, { ok: true, message: "Warning berhasil diberikan." });
    }

    if (action === "block") {
      if (!reason) {
        return json(res, 400, { ok: false, message: "Alasan block wajib diisi." });
      }

      await authAdmin.updateUser(uid, { disabled: true });
      await authAdmin.revokeRefreshTokens(uid).catch(() => {});

      await userRef.set(
        {
          accountStatus: "BLOCKED",
          blockedReason: reason,
          blockedAt: admin.firestore.FieldValue.serverTimestamp(),
          blockedByUid: adminUid,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return json(res, 200, { ok: true, message: "Akun berhasil diblokir." });
    }

    if (action === "unblock") {
      await authAdmin.updateUser(uid, { disabled: false });

      await userRef.set(
        {
          accountStatus: "ACTIVE",
          blockedReason: admin.firestore.FieldValue.delete(),
          blockedAt: admin.firestore.FieldValue.delete(),
          blockedByUid: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return json(res, 200, { ok: true, message: "Akun berhasil dibuka blokirnya." });
    }

    return json(res, 400, { ok: false, message: "action users tidak valid." });
  } catch (e) {
    return json(res, 500, { ok: false, message: e?.message || "Server error" });
  }
};