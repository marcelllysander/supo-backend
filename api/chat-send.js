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
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

    initFirebase();
    const db = admin.firestore();

    // 1) Verify Firebase ID token
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!idToken) return json(res, 401, { error: "Missing auth token" });

    const decoded = await admin.auth().verifyIdToken(idToken);
    const senderUid = decoded.uid;

    // 2) Parse body
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const chatId = String(body?.chatId || "").trim();
    const receiverUid = String(body?.receiverUid || "").trim();
    const text = String(body?.text || "").trim();
    const chatTitleForSender = String(body?.chatTitleForSender || "").trim(); // optional
    const senderName = String(body?.senderName || "").trim(); // optional untuk judul notif

    if (!chatId || !receiverUid || !text) {
      return json(res, 400, { error: "chatId, receiverUid, text are required" });
    }
    if (receiverUid === senderUid) {
      return json(res, 400, { error: "receiverUid cannot be same as sender" });
    }

    const chatRef = db.collection("chats").doc(chatId);
    const msgRef = chatRef.collection("messages").doc();

    // 3) Write message + update thread (transaction biar rapi)
    await db.runTransaction(async (t) => {
      // upsert chat doc
      t.set(
        chatRef,
        {
          participants: { [senderUid]: true, [receiverUid]: true },
          participantIds: [senderUid, receiverUid],
          title: chatTitleForSender || "", // kamu boleh abaikan ini kalau title kamu sudah fixed
          lastMessage: text,
          lastSenderId: senderUid,
          lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      t.set(msgRef, {
        senderId: senderUid,
        text,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // 4) Get receiver tokens (multi-device)
    const tokenSnap = await db.collection("users").doc(receiverUid).collection("fcmTokens").get();
    const tokens = tokenSnap.docs.map((d) => d.id).filter(Boolean);

    // 5) Send push via FCM (kalau receiver belum punya token, skip tapi tetap sukses)
    if (tokens.length > 0) {
      const notifTitle = senderName || "Pesan baru";
      const notifBody = text.length > 80 ? text.slice(0, 80) + "..." : text;

      const message = {
        tokens,

        // ✅ ini bikin Android bisa tampilkan notif otomatis saat background
        notification: {
          title: notifTitle,
          body: notifBody,
        },

        // ✅ data untuk routing buka chat yang benar
        data: {
          type: "chat",
          chatId,
          senderUid, // penting untuk open chat ke lawan chat
          receiverUid,
          title: notifTitle,
          body: notifBody,
        },

        android: {
          priority: "high",
          notification: {
            channelId: "chat", // harus sama dengan channel di Android
            sound: "default",
            tag: chatId,
          },
        },
      };

      const resp = await admin.messaging().sendEachForMulticast(message);

      // Optional: bersihkan token invalid
      const badTokens = [];
      resp.responses.forEach((r, idx) => {
        if (!r.success) {
          const code = r.error?.code || "";
          if (code.includes("registration-token-not-registered")) {
            badTokens.push(tokens[idx]);
          }
        }
      });

      if (badTokens.length) {
        const batch = db.batch();
        badTokens.forEach((tk) => {
          batch.delete(db.collection("users").doc(receiverUid).collection("fcmTokens").doc(tk));
        });
        await batch.commit();
      }
    }

    return json(res, 200, { ok: true, messageId: msgRef.id });
  } catch (e) {
    console.error("chat-send error:", e);
    return json(res, 500, { error: "Server error", detail: e?.message || String(e) });
  }
};
