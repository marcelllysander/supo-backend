const admin = require("firebase-admin");
const midtransClient = require("midtrans-client");

function initFirebase() {
  if (admin.apps.length) return;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("Missing Firebase env vars");
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
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

    // 1) Ambil Firebase ID Token dari header Authorization: Bearer <token>
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return json(res, 401, { error: "Missing auth token" });

    const decoded = await admin.auth().verifyIdToken(token);
    const uid = decoded.uid;

    // 2) Ambil orderId dari body
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const orderId = String(body?.orderId || "").trim();
    if (!orderId) return json(res, 400, { error: "orderId required" });

    // 3) Ambil order dari Firestore
    const orderRef = db.collection("orders").doc(orderId);
    const snapOrder = await orderRef.get();
    if (!snapOrder.exists) return json(res, 404, { error: "Order not found" });

    const order = snapOrder.data() || {};
    if (order.buyerUid !== uid) return json(res, 403, { error: "Not your order" });

    const total = Number(order.total || 0);
    if (total <= 0) return json(res, 400, { error: "Invalid total" });

    // 4) Midtrans Snap
    const isProduction = String(process.env.MIDTRANS_IS_PRODUCTION) === "true";
    const serverKey = process.env.MIDTRANS_SERVER_KEY;
    const clientKey = process.env.MIDTRANS_CLIENT_KEY;
    if (!serverKey || !clientKey) return json(res, 500, { error: "Midtrans env missing" });

    const snap = new midtransClient.Snap({
      isProduction,
      serverKey,
      clientKey,
    });

    const parameter = {
      transaction_details: {
        order_id: orderId,
        gross_amount: total,
      },
      item_details: [
        {
          id: order.productId || "item",
          price: Number(order.price || total),
          quantity: Number(order.quantity || 1),
          name: String(order.productName || "Produk").slice(0, 50),
        },
      ],
      customer_details: {
        first_name: String(order.receiverName || "Customer").slice(0, 50),
        phone: String(order.receiverPhone || ""),
        shipping_address: {
          first_name: String(order.receiverName || "Customer").slice(0, 50),
          phone: String(order.receiverPhone || ""),
          address: String(order.address || "").slice(0, 200),
        },
      },
      enabled_payments: ["bank_transfer", "gopay", "shopeepay", "other_qris"],
    };

    const snapToken = await snap.createTransactionToken(parameter);

    // 5) Simpan ke Firestore
    await orderRef.set(
      {
        status: "PENDING_PAYMENT",
        payment: {
          provider: "MIDTRANS",
          snapToken,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      },
      { merge: true }
    );

    return json(res, 200, { snapToken });
  } catch (e) {
    console.error("ERROR FULL:", e);

    const detail = e?.ApiResponse?.error_messages || e?.message || String(e);

    return json(res, 500, { error: "Server error", detail });
  }
};
