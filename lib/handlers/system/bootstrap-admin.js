// lib/handlers/system/bootstrap-admin.js
const { admin, authAdmin, dbAdmin } = require("../../firebaseAdmin");

function parseBody(req) {
  try {
    if (!req.body) return {};
    if (typeof req.body === "string") return JSON.parse(req.body || "{}");
    return req.body || {};
  } catch {
    return {};
  }
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

async function resolveTargetUser(body) {
  const uid = String(body.uid || "").trim();
  const email = normalizeEmail(body.email);

  if (uid) {
    return await authAdmin.getUser(uid);
  }

  if (email) {
    return await authAdmin.getUserByEmail(email);
  }

  throw new Error("uid atau email wajib diisi.");
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  const authHeader = req.headers.authorization || "";
  const secret = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : "";

  if (!process.env.ADMIN_BOOTSTRAP_SECRET) {
    return res.status(500).json({
      ok: false,
      message: "Missing ADMIN_BOOTSTRAP_SECRET"
    });
  }

  if (secret !== process.env.ADMIN_BOOTSTRAP_SECRET) {
    return res.status(401).json({
      ok: false,
      message: "Unauthorized"
    });
  }

  try {
    const body = parseBody(req);
    const user = await resolveTargetUser(body);

    const uid = user.uid;
    const oldClaims = user.customClaims || {};

    await authAdmin.setCustomUserClaims(uid, {
      ...oldClaims,
      admin: true
    });

    const batch = dbAdmin.batch();

    batch.set(
      dbAdmin.collection("users").doc(uid),
      {
        role: "admin",
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    batch.set(
      dbAdmin.collection("publicProfiles").doc(uid),
      {
        role: "admin"
      },
      { merge: true }
    );

    await batch.commit();

    return res.status(200).json({
      ok: true,
      message: "Admin claim berhasil dipasang.",
      uid,
      email: user.email || "",
      note: "User harus refresh token dengan getIdToken(true) atau login ulang."
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e?.message || "Server error"
    });
  }
};