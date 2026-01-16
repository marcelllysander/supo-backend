const admin = require("firebase-admin");
const crypto = require("crypto");

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

// Mapping Midtrans -> status order kamu
function mapStatus(txStatus) {
  switch (txStatus) {
    case "settlement":
    case "capture":
      return "PAID";

    case "pending":
      return "PENDING_PAYMENT";

    case "deny":
    case "cancel":
    case "expire":
      return "CANCELLED";

    case "refund":
    case "chargeback":
      return "REFUNDED";

    default:
      return "PENDING_PAYMENT";
  }
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return json(res, 405, { error: "Method not allowed" });
    }

    // OPTIONAL: proteksi secret query
    const secret = String(req.query?.secret || "");
    if (process.env.SUPO_WEBHOOK_SECRET && secret !== process.env.SUPO_WEBHOOK_SECRET) {
      return json(res, 401, { error: "Invalid webhook secret" });
    }

    initFirebase();
    const db = admin.firestore();

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const orderId = String(body.order_id || "");
    const statusCode = String(body.status_code || "");
    const grossAmount = String(body.gross_amount || "");
    const signatureKey = String(body.signature_key || "");
    const transactionStatus = String(body.transaction_status || "");

    if (!orderId) return json(res, 400, { error: "Missing order_id" });

    // ====== Verifikasi signature Midtrans ======
    const serverKey = process.env.MIDTRANS_SERVER_KEY || "";
    const expected = crypto
      .createHash("sha512")
      .update(orderId + statusCode + grossAmount + serverKey)
      .digest("hex");

    if (expected !== signatureKey) {
      return json(res, 401, { error: "Invalid signature" });
    }

    const newStatus = mapStatus(transactionStatus);

    // ====== TRANSACTION: update order + update stock/reserved product ======
    await db.runTransaction(async (t) => {
      const orderRef = db.collection("orders").doc(orderId);
      const orderSnap = await t.get(orderRef);

      if (!orderSnap.exists) {
        // Kalau order tidak ada, tetap simpan status minimal (untuk debug)
        t.set(orderRef, { status: newStatus }, { merge: true });
        return;
      }

      const order = orderSnap.data() || {};
      const productId = String(order.productId || "");
      const qty = Number(order.quantity || 0);

      // 1) Update status + payment raw notification
      t.set(
        orderRef,
        {
          status: newStatus,
          payment: {
            provider: "MIDTRANS",
            transactionStatus,
            paymentType: body.payment_type || null,
            fraudStatus: body.fraud_status || null,
            rawNotification: body,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
        },
        { merge: true }
      );

      // Kalau order tidak punya product/qty, stop
      if (!productId || qty <= 0) return;

      const productRef = db.collection("products").doc(productId);
      const productSnap = await t.get(productRef);
      if (!productSnap.exists) return;

      const product = productSnap.data() || {};
      const stock = Number(product.stock || 0);
      const reserved = Number(product.reserved || 0);

      const stockState = order.stock || {};
      const deducted = !!stockState.deducted;
      const reservedReleased = !!stockState.reservedReleased;

      // ===== CASE A: PAID -> potong stock + lepas reserved (HANYA SEKALI) =====
      if (newStatus === "PAID" && !deducted) {
        const newStock = stock - qty;
        const newReserved = reserved - qty;

        t.update(productRef, {
          stock: newStock < 0 ? 0 : newStock,
          reserved: newReserved < 0 ? 0 : newReserved,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        t.set(
          orderRef,
          {
            stock: {
              reservedApplied: true,
              reservedReleased: true,
              deducted: true,
              deductedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
          },
          { merge: true }
        );

        return;
      }

      // ===== CASE B: CANCELLED / REFUNDED -> release reserved (HANYA SEKALI) =====
      if ((newStatus === "CANCELLED" || newStatus === "REFUNDED") && !reservedReleased) {
        const newReserved = reserved - qty;

        t.update(productRef, {
          reserved: newReserved < 0 ? 0 : newReserved,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        t.set(
          orderRef,
          {
            stock: {
              reservedReleased: true,
              releasedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
          },
          { merge: true }
        );
      }

      // Kalau newStatus = PENDING_PAYMENT -> tidak melakukan apa-apa (karena reserve sudah dilakukan di Android)
    });

    return json(res, 200, { ok: true, status: newStatus });
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: "Server error", detail: String(e.message || e) });
  }
};
