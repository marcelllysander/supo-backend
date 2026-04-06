// lib/handlers/admin/users.js
const { admin, authAdmin, dbAdmin } = require("../../firebaseAdmin");

const FieldValue = admin.firestore.FieldValue;

function json(res, code, data) {
  return res.status(code).json(data);
}

function str(v) {
  return String(v || "").trim();
}

async function getAuthUserOrNull(uid) {
  try {
    return await authAdmin.getUser(uid);
  } catch (e) {
    if (e?.code === "auth/user-not-found") {
      return null;
    }
    throw e;
  }
}

module.exports = async (req, res, decoded, body) => {
  const action = str(body.action).toLowerCase();
  const uid = str(body.uid);
  const reason = str(body.reason);
  const adminUid = decoded.uid;

  try {
    if (!uid) {
      return json(res, 400, {
        ok: false,
        message: "uid wajib diisi."
      });
    }

    if (!["warn", "block", "unblock"].includes(action)) {
      return json(res, 400, {
        ok: false,
        message: "action users tidak valid."
      });
    }

    const userRef = dbAdmin.collection("users").doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return json(res, 404, {
        ok: false,
        message: "User Firestore tidak ditemukan."
      });
    }

    // =========================================
    // WARN
    // =========================================
    if (action === "warn") {
      if (!reason) {
        return json(res, 400, {
          ok: false,
          message: "Alasan warning wajib diisi."
        });
      }

      await userRef.set(
        {
          accountStatus: "ACTIVE",
          warningCount: FieldValue.increment(1),
          lastWarningReason: reason,
          lastWarningAt: FieldValue.serverTimestamp(),
          lastWarnedByUid: adminUid,
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      return json(res, 200, {
        ok: true,
        message: "Warning berhasil diberikan."
      });
    }

    // =========================================
    // BLOCK
    // =========================================
    if (action === "block") {
      if (!reason) {
        return json(res, 400, {
          ok: false,
          message: "Alasan block wajib diisi."
        });
      }

      // Hindari block akun admin yang sedang dipakai
      if (uid === adminUid) {
        return json(res, 400, {
          ok: false,
          message: "Jangan memblokir akun admin yang sedang dipakai. Gunakan akun lain untuk testing."
        });
      }

      const authUser = await getAuthUserOrNull(uid);

      // Kalau user Auth ada, disable
      if (authUser) {
        await authAdmin.updateUser(uid, { disabled: true });

        try {
          await authAdmin.revokeRefreshTokens(uid);
        } catch (e) {
          console.warn("[ADMIN USERS] revokeRefreshTokens gagal:", e?.message || e);
        }
      } else {
        console.warn("[ADMIN USERS] User Auth tidak ditemukan, hanya update Firestore.", { uid });
      }

      await userRef.set(
        {
          accountStatus: "BLOCKED",
          disabled: true,
          blockedReason: reason,
          blockedAt: FieldValue.serverTimestamp(),
          blockedByUid: adminUid,
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      return json(res, 200, {
        ok: true,
        message: authUser
          ? "Akun berhasil diblokir."
          : "Akun diblokir di Firestore, tetapi user Auth tidak ditemukan."
      });
    }

    // =========================================
    // UNBLOCK
    // =========================================
    if (action === "unblock") {
      const authUser = await getAuthUserOrNull(uid);

      if (authUser) {
        await authAdmin.updateUser(uid, { disabled: false });
      } else {
        console.warn("[ADMIN USERS] User Auth tidak ditemukan saat unblock, hanya update Firestore.", { uid });
      }

      await userRef.set(
        {
          accountStatus: "ACTIVE",
          disabled: false,
          blockedReason: FieldValue.delete(),
          blockedAt: FieldValue.delete(),
          blockedByUid: FieldValue.delete(),
          unblockedAt: FieldValue.serverTimestamp(),
          unblockedByUid: adminUid,
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      return json(res, 200, {
        ok: true,
        message: authUser
          ? "Akun berhasil dibuka blokirnya."
          : "Status block di Firestore berhasil dibersihkan, tetapi user Auth tidak ditemukan."
      });
    }

    return json(res, 400, {
      ok: false,
      message: "action users tidak valid."
    });
  } catch (e) {
    console.error("[ADMIN USERS] ERROR", {
      action,
      uid,
      adminUid,
      code: e?.code || "",
      message: e?.message || "",
      stack: e?.stack || ""
    });

    return json(res, 500, {
      ok: false,
      message: e?.message || "Server error",
      code: e?.code || ""
    });
  }
};