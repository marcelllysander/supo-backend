// lib/handlers/admin/broadcast.js
const { admin, dbAdmin } = require("../../firebaseAdmin");

function json(res, code, data) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

function badRequest(message) {
  const e = new Error(message);
  e.statusCode = 400;
  return e;
}

function forbidden(message) {
  const e = new Error(message);
  e.statusCode = 403;
  return e;
}

function pickString(v) {
  return String(v || "").trim();
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function getTargetUsers(targetRole) {
  if (targetRole === "SUPPLIER") {
    const snap = await dbAdmin.collection("users").where("role", "==", "supplier").get();
    return snap.docs;
  }

  if (targetRole === "COMPANY") {
    const snap = await dbAdmin.collection("users").where("role", "==", "company").get();
    return snap.docs;
  }

  const snap = await dbAdmin.collection("users").where("role", "in", ["supplier", "company"]).get();
  return snap.docs;
}

async function getNotificationSettings(uid) {
  const snap = await dbAdmin.collection("notification_settings").doc(uid).get();
  return snap.exists ? (snap.data() || {}) : {};
}

async function getUserTokens(uid) {
  const snap = await dbAdmin
    .collection("notification_tokens")
    .doc(uid)
    .collection("tokens")
    .get();

  return snap.docs.map((d) => d.id).filter(Boolean);
}

async function cleanupBadTokens(tokenOwners, badTokens) {
  if (!badTokens.length) return;

  const batch = dbAdmin.batch();

  for (const token of badTokens) {
    const uid = tokenOwners.get(token);
    if (!uid) continue;

    const ref = dbAdmin
      .collection("notification_tokens")
      .doc(uid)
      .collection("tokens")
      .doc(token);

    batch.delete(ref);
  }

  await batch.commit();
}

module.exports = async (req, res, decoded, body) => {
  try {
    if (decoded.admin !== true) {
      throw forbidden("Admin claim diperlukan.");
    }

    const action = pickString(body.action).toLowerCase();
    if (action !== "send") {
      throw badRequest("action broadcast tidak valid.");
    }

    const title = pickString(body.title);
    const messageBody = pickString(body.body);
    const targetRole = pickString(body.targetRole || "ALL").toUpperCase();
    const category = pickString(body.category || "system").toLowerCase();

    if (!title) throw badRequest("title wajib diisi.");
    if (!messageBody) throw badRequest("body wajib diisi.");
    if (!["ALL", "SUPPLIER", "COMPANY"].includes(targetRole)) {
      throw badRequest("targetRole tidak valid.");
    }
    if (!["system", "promo"].includes(category)) {
      throw badRequest("category tidak valid.");
    }

    const broadcastRef = dbAdmin.collection("broadcast_notifications").doc();
    const nowTs = admin.firestore.FieldValue.serverTimestamp();

    await broadcastRef.set({
      title,
      body: messageBody,
      targetRole,
      category,
      status: "SENDING",
      createdByUid: decoded.uid,
      createdAt: nowTs,
      updatedAt: nowTs
    });

    const userDocs = await getTargetUsers(targetRole);

    const tokens = [];
    const tokenOwners = new Map();
    let totalUsers = 0;

    for (const userDoc of userDocs) {
      const uid = userDoc.id;
      const settings = await getNotificationSettings(uid);

      const pushEnabled = settings.pushEnabled !== false;
      const promoEnabled = settings.promoEnabled === true;

      if (!pushEnabled) continue;
      if (category === "promo" && !promoEnabled) continue;

      totalUsers++;

      const userTokens = await getUserTokens(uid);
      for (const tk of userTokens) {
        tokens.push(tk);
        tokenOwners.set(tk, uid);
      }
    }

    let successCount = 0;
    let failedCount = 0;
    const badTokens = [];

    const chunks = chunkArray([...new Set(tokens)], 500);

    for (const chunk of chunks) {
      if (!chunk.length) continue;

      const resp = await admin.messaging().sendEachForMulticast({
        tokens: chunk,
        data: {
          type: "broadcast",
          broadcastId: broadcastRef.id,
          title,
          body: messageBody,
          targetRole,
          category,
          sentAt: Date.now().toString()
        },
        android: {
          priority: "high"
        }
      });

      successCount += resp.successCount;
      failedCount += resp.failureCount;

      resp.responses.forEach((r, idx) => {
        if (!r.success) {
          const code = r.error?.code || "";
          if (
            code.includes("registration-token-not-registered") ||
            code.includes("invalid-argument")
          ) {
            badTokens.push(chunk[idx]);
          }
        }
      });
    }

    await cleanupBadTokens(tokenOwners, badTokens);

    await broadcastRef.set({
      status: "SENT",
      totalUsers,
      totalTokens: [...new Set(tokens)].length,
      successCount,
      failedCount,
      finishedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return json(res, 200, {
      ok: true,
      broadcastId: broadcastRef.id,
      totalUsers,
      totalTokens: [...new Set(tokens)].length,
      successCount,
      failedCount
    });
  } catch (e) {
    const code = Number(e.statusCode) || 500;
    return json(res, code, {
      ok: false,
      message: e.message || "Server error"
    });
  }
};