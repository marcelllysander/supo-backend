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

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  return req.body || {};
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function getTimestampMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.toDate === "function") return ts.toDate().getTime();

  const d = new Date(ts);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function formatMidtransStartTime(date = new Date()) {
  // Midtrans docs contoh: YYYY-MM-DD HH:mm:ss +0700
  const utc7Ms = date.getTime() + (7 * 60 * 60 * 1000);
  const d = new Date(utc7Ms);

  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} +0700`;
}

async function autoCancelExpiredOrder(db, orderRef) {
  return db.runTransaction(async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) {
      return { cancelled: false, reason: "ORDER_NOT_FOUND" };
    }

    const order = orderSnap.data() || {};
    const status = String(order.status || "").trim();
    const limitMs = getTimestampMs(order.buyerCancelableUntilAt);
    const nowMs = Date.now();

    if (status !== "PENDING_PAYMENT") {
      return { cancelled: false, reason: "STATUS_CHANGED", status };
    }

    if (!limitMs || nowMs < limitMs) {
      return { cancelled: false, reason: "NOT_EXPIRED_YET" };
    }

    const qty = toNum(order.quantity, 0);
    const productId = String(order.productId || "").trim();

    const stockMeta = order.stock || {};
    const reservedApplied = !!stockMeta.reservedApplied;
    const reservedReleased = !!stockMeta.reservedReleased;
    const deducted = !!stockMeta.deducted;

    if (productId && reservedApplied && !reservedReleased && !deducted && qty > 0) {
      const productRef = db.collection("products").doc(productId);
      const productSnap = await tx.get(productRef);

      if (productSnap.exists) {
        const product = productSnap.data() || {};
        const reserved = toNum(product.reserved, 0);

        tx.update(productRef, {
          reserved: Math.max(0, reserved - qty),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }

    tx.set(
      orderRef,
      {
        status: "CANCELLED",
        cancelledByUid: "",
        cancelledByRole: "SYSTEM",
        cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        "stock.reservedReleased": true,
        payment: {
          provider: "MIDTRANS",
          expiredBySystemAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      },
      { merge: true },
    );

    return { cancelled: true };
  });
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return json(res, 405, { error: "Method not allowed" });
    }

    initFirebase();
    const db = admin.firestore();

    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return json(res, 401, { error: "Missing auth token" });

    const decoded = await admin.auth().verifyIdToken(token);
    const uid = decoded.uid;

    const body = parseBody(req);
    const orderId = String(body?.orderId || "").trim();
    if (!orderId) return json(res, 400, { error: "orderId required" });

    const orderRef = db.collection("orders").doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) return json(res, 404, { error: "Order not found" });

    const order = orderSnap.data() || {};
    if (order.buyerUid !== uid) return json(res, 403, { error: "Not your order" });

    const currentStatus = String(order.status || "PENDING_PAYMENT").trim();
    const limitMs = getTimestampMs(order.buyerCancelableUntilAt);
    const nowMs = Date.now();

    if (currentStatus === "PAID") {
      return json(res, 409, { error: "Order already PAID" });
    }

    if (["PROCESSING", "SHIPPING", "DONE", "CANCELLED", "REFUNDED"].includes(currentStatus)) {
      return json(res, 409, { error: `Order already ${currentStatus}` });
    }

    if (!limitMs) {
      return json(res, 409, { error: "Order payment limit missing" });
    }

    if (nowMs >= limitMs) {
      await autoCancelExpiredOrder(db, orderRef);
      return json(res, 409, { error: "Payment time limit exceeded" });
    }

    const existingSnapToken = String(order.payment?.snapToken || "").trim();
    const existingRedirectUrl = String(
      order.payment?.redirectUrl || order.payment?.snapRedirectUrl || "",
    ).trim();

    if (currentStatus === "PENDING_PAYMENT" && existingSnapToken) {
      return json(res, 200, {
        snapToken: existingSnapToken,
        redirectUrl: existingRedirectUrl,
        reused: true,
      });
    }

    const productPrice = toNum(order.productPrice, toNum(order.price, 0));
    const shippingFee = toNum(order.shippingFee, toNum(order.shipping, 0));
    const adminFee = toNum(order.adminFee, 0);
    const quantity = Math.max(1, Math.floor(toNum(order.quantity, 1)));

    const itemDetails = [
      {
        id: order.productId || "item",
        price: productPrice,
        quantity,
        name: String(order.productName || "Produk").slice(0, 50),
      },
      {
        id: "shipping",
        price: shippingFee,
        quantity: 1,
        name: "Shipping Cost",
      },
      {
        id: "admin_fee",
        price: adminFee,
        quantity: 1,
        name: "Admin Fee",
      },
    ];

    const grossAmount = itemDetails.reduce((sum, item) => {
      return sum + (toNum(item.price, 0) * toNum(item.quantity, 0));
    }, 0);

    if (!Number.isFinite(grossAmount) || grossAmount <= 0) {
      return json(res, 400, { error: "Invalid gross amount" });
    }

    const isProduction = String(process.env.MIDTRANS_IS_PRODUCTION) === "true";
    const serverKey = process.env.MIDTRANS_SERVER_KEY;
    const clientKey = process.env.MIDTRANS_CLIENT_KEY;
    if (!serverKey || !clientKey) {
      return json(res, 500, { error: "Midtrans env missing" });
    }

    const snap = new midtransClient.Snap({
      isProduction,
      serverKey,
      clientKey,
    });

    const remainingMinutes = Math.max(1, Math.ceil((limitMs - nowMs) / 60000));

    const parameter = {
      transaction_details: {
        order_id: orderId,
        gross_amount: grossAmount,
      },
      item_details: itemDetails,
      customer_details: {
        first_name: String(order.receiverName || order.buyerName || "Customer").slice(0, 50),
        phone: String(order.receiverPhone || ""),
        shipping_address: {
          first_name: String(order.receiverName || order.buyerName || "Customer").slice(0, 50),
          phone: String(order.receiverPhone || ""),
          address: String(order.address || "").slice(0, 200),
        },
      },
      enabled_payments: ["bank_transfer", "gopay", "shopeepay", "other_qris"],
      expiry: {
        start_time: formatMidtransStartTime(new Date()),
        unit: "minute",
        duration: remainingMinutes,
      },
    };

    const transaction = await snap.createTransaction(parameter);
    const snapToken = String(transaction?.token || "").trim();
    const redirectUrl = String(transaction?.redirect_url || "").trim();

    if (!snapToken) {
      return json(res, 500, { error: "Midtrans snapToken empty" });
    }

    const persisted = await db.runTransaction(async (tx) => {
      const liveSnap = await tx.get(orderRef);
      if (!liveSnap.exists) throw new Error("Order not found during save");

      const liveOrder = liveSnap.data() || {};
      const liveStatus = String(liveOrder.status || "").trim();
      const liveLimitMs = getTimestampMs(liveOrder.buyerCancelableUntilAt);

      if (liveOrder.buyerUid !== uid) {
        throw new Error("Not your order");
      }

      if (liveStatus !== "PENDING_PAYMENT") {
        return {
          blocked: true,
          status: liveStatus,
        };
      }

      if (!liveLimitMs || Date.now() >= liveLimitMs) {
        return {
          expired: true,
        };
      }

      const alreadySavedToken = String(liveOrder.payment?.snapToken || "").trim();
      const alreadySavedRedirectUrl = String(
        liveOrder.payment?.redirectUrl || liveOrder.payment?.snapRedirectUrl || "",
      ).trim();

      if (alreadySavedToken) {
        return {
          snapToken: alreadySavedToken,
          redirectUrl: alreadySavedRedirectUrl,
          reused: true,
        };
      }

      tx.set(
        orderRef,
        {
          payment: {
            provider: "MIDTRANS",
            snapToken,
            redirectUrl,
            snapRedirectUrl: redirectUrl,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      return {
        snapToken,
        redirectUrl,
        reused: false,
      };
    });

    if (persisted?.blocked) {
      return json(res, 409, { error: `Order already ${persisted.status}` });
    }

    if (persisted?.expired) {
      await autoCancelExpiredOrder(db, orderRef);
      return json(res, 409, { error: "Payment time limit exceeded" });
    }

    return json(res, 200, persisted);
  } catch (e) {
    console.error("ERROR FULL:", e);
    const detail = e?.ApiResponse?.error_messages || e?.message || String(e);
    return json(res, 500, { error: "Server error", detail });
  }
};