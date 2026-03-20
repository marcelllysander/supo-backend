const admin = require("firebase-admin");

function initFirebase() {
  if (admin.apps.length) return;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("Missing Firebase env vars");
  }

  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });
}

function json(res, code, data) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return json(res, 405, { error: "Method not allowed" });
    }

    initFirebase();
    const db = admin.firestore();

    // 1) Verify Firebase ID token
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!idToken) {
      return json(res, 401, { error: "Missing auth token" });
    }

    const decoded = await admin.auth().verifyIdToken(idToken);
    const senderUid = decoded.uid;

    // 2) Parse body safely
    let body = req.body;
    if (typeof body === "string") {
      body = body.trim() ? JSON.parse(body) : {};
    }
    body = body || {};

    const action = String(body?.action || "send").trim().toLowerCase();

    // =========================================================
    // ACTION: READ
    // =========================================================
    if (action === "read") {
      const chatId = String(body?.chatId || "").trim();
      if (!chatId) {
        return json(res, 400, { error: "chatId is required" });
      }

      const chatRef = db.collection("chats").doc(chatId);
      const chatSnap = await chatRef.get();

      if (!chatSnap.exists) {
        return json(res, 404, { error: "Chat not found" });
      }

      const participantIds = chatSnap.get("participantIds") || [];
      if (!Array.isArray(participantIds) || !participantIds.includes(senderUid)) {
        return json(res, 403, { error: "Not allowed" });
      }

      await chatRef.set(
        {
          [`unreadCountByUid.${senderUid}`]: 0,
          [`lastReadAtByUid.${senderUid}`]: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return json(res, 200, {
        ok: true,
        action: "read",
        chatId,
      });
    }

    // =========================================================
    // ACTION: SEND
    // =========================================================
    if (action !== "send") {
      return json(res, 400, { error: "Invalid action" });
    }

    const chatId = String(body?.chatId || "").trim();
    const receiverUid = String(body?.receiverUid || "").trim();
    const text = String(body?.text || "").trim();
    const chatTitleForSender = String(body?.chatTitleForSender || "").trim();
    const senderName = String(body?.senderName || "").trim();

    const replyToMessageId = String(body?.replyToMessageId || "").trim();
    const replyToText = String(body?.replyToText || "").trim();
    const replyToSenderId = String(body?.replyToSenderId || "").trim();

    if (!chatId || !receiverUid || !text) {
      return json(res, 400, { error: "chatId, receiverUid, text are required" });
    }

    if (receiverUid === senderUid) {
      return json(res, 400, { error: "receiverUid cannot be same as sender" });
    }

    const chatRef = db.collection("chats").doc(chatId);
    const msgRef = chatRef.collection("messages").doc();

    await db.runTransaction(async (t) => {
      const chatSnap = await t.get(chatRef);
      const chatExists = chatSnap.exists;

      const chatData = {
        participants: { [senderUid]: true, [receiverUid]: true },
        participantIds: [senderUid, receiverUid],

        lastMessage: text,
        lastSenderId: senderUid,
        lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),

        [`unreadCountByUid.${receiverUid}`]: admin.firestore.FieldValue.increment(1),
        [`unreadCountByUid.${senderUid}`]: 0,
        [`lastReadAtByUid.${senderUid}`]: admin.firestore.FieldValue.serverTimestamp(),
      };

      // hanya set createdAt kalau chat baru
      if (!chatExists) {
        chatData.createdAt = admin.firestore.FieldValue.serverTimestamp();
      }

      // jangan timpa title lama dengan string kosong
      if (chatTitleForSender) {
        chatData.title = chatTitleForSender;
      }

      t.set(chatRef, chatData, { merge: true });

      t.set(msgRef, {
        senderId: senderUid,
        text,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        replyToMessageId,
        replyToText,
        replyToSenderId,
      });
    });

    // 3) Ambil token milik receiver
    const receiverTokenSnap = await db
      .collection("users")
      .doc(receiverUid)
      .collection("fcmTokens")
      .get();

    let tokens = receiverTokenSnap.docs.map((d) => d.id).filter(Boolean);

    // hardening: buang token milik sender kalau tersimpan ganda / salah user
    const senderTokenSnap = await db
      .collection("users")
      .doc(senderUid)
      .collection("fcmTokens")
      .get();

    const senderTokens = new Set(senderTokenSnap.docs.map((d) => d.id).filter(Boolean));
    tokens = tokens.filter((tk) => !senderTokens.has(tk));

    // 4) Kirim data-only FCM
    if (tokens.length > 0) {
      const notifTitle = senderName || "Pesan baru";
      const notifBody = text.length > 120 ? text.slice(0, 120) + "..." : text;

      const message = {
        tokens,
        data: {
          type: "chat",
          chatId,
          senderUid,
          receiverUid,
          senderName: notifTitle,
          text: notifBody,

          replyToMessageId,
          replyToText,
          replyToSenderId,

          sentAt: Date.now().toString(),
        },
        android: {
          priority: "high",
        },
      };

      const resp = await admin.messaging().sendEachForMulticast(message);

      // 5) Bersihkan token invalid
      const badTokens = [];
      resp.responses.forEach((r, idx) => {
        if (!r.success) {
          const code = r.error?.code || "";
          if (
            code.includes("registration-token-not-registered") ||
            code.includes("invalid-argument")
          ) {
            badTokens.push(tokens[idx]);
          }
        }
      });

      if (badTokens.length) {
        const batch = db.batch();
        badTokens.forEach((tk) => {
          batch.delete(
            db.collection("users").doc(receiverUid).collection("fcmTokens").doc(tk)
          );
        });
        await batch.commit();
      }
    }

    return json(res, 200, {
      ok: true,
      action: "send",
      messageId: msgRef.id,
      chatId,
    });
  } catch (e) {
    console.error("chat-send error:", e);
    return json(res, 500, {
      error: "Server error",
      detail: e?.message || String(e),
    });
  }
};