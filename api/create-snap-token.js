// supo-backend/api/create-snap-token.js
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
  try {
    if (!req.body) return {};
    if (typeof req.body === "string") return JSON.parse(req.body || "{}");
    return req.body || {};
  } catch (_) {
    const e = new Error("Body JSON tidak valid");
    e.statusCode = 400;
    throw e;
  }
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
  const utc7Ms = date.getTime() + 7 * 60 * 60 * 1000;
  const d = new Date(utc7Ms);

  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} +0700`;
}

function extractReservedItems(order) {
  const stockMeta = order?.stock || {};
  if (Array.isArray(stockMeta.items) && stockMeta.items.length > 0) {
    return stockMeta.items
      .map((it) => ({
        productId: String(it.productId || "").trim(),
        quantity: Math.max(0, Math.floor(toNum(it.quantity, 0))),
      }))
      .filter((it) => it.productId && it.quantity > 0);
  }

  const productId = String(order?.productId || "").trim();
  const quantity = Math.max(0, Math.floor(toNum(order?.quantity, 0)));
  if (!productId || quantity <= 0) return [];
  return [{ productId, quantity }];
}

function shouldReleaseReserved(order) {
  const stockMeta = order?.stock || {};
  return !!stockMeta.reservedApplied && !stockMeta.reservedReleased && !stockMeta.deducted;
}

function accumulateReleaseMap(releaseMap, order) {
  const items = extractReservedItems(order);
  for (const it of items) {
    releaseMap.set(
      it.productId,
      (releaseMap.get(it.productId) || 0) + Number(it.quantity || 0)
    );
  }
}

async function readProductStatesForReleaseTx(tx, db, releaseMap) {
  const productStates = [];

  for (const [productId, qtyToRelease] of releaseMap.entries()) {
    const productRef = db.collection("products").doc(productId);
    const productSnap = await tx.get(productRef);

    productStates.push({
      productId,
      productRef,
      productSnap,
      qtyToRelease,
    });
  }

  return productStates;
}

function applyReleaseWrites(tx, productStates) {
  for (const p of productStates) {
    if (!p.productSnap.exists) continue;

    const reserved = toNum(p.productSnap.get("reserved"), 0);
    tx.update(p.productRef, {
      reserved: Math.max(0, reserved - p.qtyToRelease),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}

async function autoCancelExpiredOrder(db, orderRef) {
  return db.runTransaction(async (tx) => {
    // ---------- READ PHASE ----------
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

    const release = shouldReleaseReserved(order);
    const releaseMap = new Map();
    if (release) {
      accumulateReleaseMap(releaseMap, order);
    }

    const productStates = await readProductStatesForReleaseTx(tx, db, releaseMap);

    // ---------- WRITE PHASE ----------
    applyReleaseWrites(tx, productStates);

    tx.set(
      orderRef,
      {
        status: "CANCELLED",
        cancelledByUid: "",
        cancelledByRole: "SYSTEM",
        cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        "stock.reservedReleased": release ? true : !!order?.stock?.reservedReleased,
        payment: {
          provider: "MIDTRANS",
          expiredBySystemAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      },
      { merge: true }
    );

    return { cancelled: true };
  });
}

async function autoCancelExpiredCheckoutSession(db, checkoutRef) {
  return db.runTransaction(async (tx) => {
    // ---------- READ PHASE ----------
    const checkoutSnap = await tx.get(checkoutRef);
    if (!checkoutSnap.exists) {
      return { cancelled: false, reason: "CHECKOUT_NOT_FOUND" };
    }

    const checkout = checkoutSnap.data() || {};
    const status = String(checkout.status || "").trim();
    const limitMs = getTimestampMs(checkout.buyerCancelableUntilAt);
    const nowMs = Date.now();

    if (status !== "PENDING_PAYMENT") {
      return { cancelled: false, reason: "STATUS_CHANGED", status };
    }

    if (!limitMs || nowMs < limitMs) {
      return { cancelled: false, reason: "NOT_EXPIRED_YET" };
    }

    const orderIds = Array.isArray(checkout.orderIds) ? checkout.orderIds : [];
    const orderRefs = orderIds.map((id) => db.collection("orders").doc(String(id)));

    const orderSnaps = [];
    for (const ref of orderRefs) {
      orderSnaps.push(await tx.get(ref));
    }

    const orderStates = [];
    const releaseMap = new Map();

    for (let i = 0; i < orderRefs.length; i++) {
      const orderRef = orderRefs[i];
      const orderSnap = orderSnaps[i];

      if (!orderSnap.exists) {
        orderStates.push({ orderRef, exists: false });
        continue;
      }

      const order = orderSnap.data() || {};
      const release = shouldReleaseReserved(order);
      if (release) {
        accumulateReleaseMap(releaseMap, order);
      }

      orderStates.push({
        orderRef,
        exists: true,
        order,
        release,
      });
    }

    const productStates = await readProductStatesForReleaseTx(tx, db, releaseMap);

    // ---------- WRITE PHASE ----------
    applyReleaseWrites(tx, productStates);

    for (const state of orderStates) {
      if (!state.exists) continue;

      tx.set(
        state.orderRef,
        {
          status: "CANCELLED",
          cancelledByUid: "",
          cancelledByRole: "SYSTEM",
          cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          "stock.reservedReleased": state.release ? true : !!state.order?.stock?.reservedReleased,
          payment: {
            provider: "MIDTRANS",
            expiredBySystemAt: admin.firestore.FieldValue.serverTimestamp(),
          },
        },
        { merge: true }
      );
    }

    tx.set(
      checkoutRef,
      {
        status: "CANCELLED",
        cancelledByUid: "",
        cancelledByRole: "SYSTEM",
        cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        payment: {
          provider: "MIDTRANS",
          expiredBySystemAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      },
      { merge: true }
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
    const checkoutId = String(body?.checkoutId || "").trim();

    if (!orderId && !checkoutId) {
      return json(res, 400, { error: "orderId or checkoutId required" });
    }

    const isCheckoutMode = checkoutId !== "";
    const targetRef = isCheckoutMode
      ? db.collection("checkout_sessions").doc(checkoutId)
      : db.collection("orders").doc(orderId);

    const targetSnap = await targetRef.get();
    if (!targetSnap.exists) {
      return json(res, 404, {
        error: isCheckoutMode ? "Checkout not found" : "Order not found",
      });
    }

    const target = targetSnap.data() || {};
    if (target.buyerUid !== uid) {
      return json(res, 403, { error: "Not your checkout/order" });
    }

    const currentStatus = String(target.status || "PENDING_PAYMENT").trim();
    const limitMs = getTimestampMs(target.buyerCancelableUntilAt);
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
      if (isCheckoutMode) {
        await autoCancelExpiredCheckoutSession(db, targetRef);
      } else {
        await autoCancelExpiredOrder(db, targetRef);
      }
      return json(res, 409, { error: "Payment time limit exceeded" });
    }

    const existingSnapToken = String(target.payment?.snapToken || "").trim();
    const existingRedirectUrl = String(
      target.payment?.redirectUrl || target.payment?.snapRedirectUrl || ""
    ).trim();

    if (currentStatus === "PENDING_PAYMENT" && existingSnapToken) {
      return json(res, 200, {
        snapToken: existingSnapToken,
        redirectUrl: existingRedirectUrl,
        reused: true,
      });
    }

    let itemDetails = [];
    let grossAmount = 0;

    if (isCheckoutMode) {
      itemDetails = [
        ...(Array.isArray(target.items) ? target.items : []).map((it) => ({
          id: it.productId || "item",
          price: toNum(it.productPrice, 0),
          quantity: Math.max(1, Math.floor(toNum(it.quantity, 1))),
          name: String(it.productName || "Produk").slice(0, 50),
        })),
        ...(Array.isArray(target.stores) ? target.stores : []).flatMap((store) => {
          const arr = [];

          if (toNum(store.shippingFee, 0) > 0) {
            arr.push({
              id: `shipping_${store.sellerUid || "store"}`,
              price: toNum(store.shippingFee, 0),
              quantity: 1,
              name: `Ongkir ${String(store.sellerName || "Toko").slice(0, 40)}`.slice(0, 50),
            });
          }

          if (toNum(store.adminFee, 0) > 0) {
            arr.push({
              id: `admin_${store.sellerUid || "store"}`,
              price: toNum(store.adminFee, 0),
              quantity: 1,
              name: `Admin ${String(store.sellerName || "Toko").slice(0, 41)}`.slice(0, 50),
            });
          }

          return arr;
        }),
      ];
    } else {
      const productPrice = toNum(target.productPrice, toNum(target.price, 0));
      const shippingFee = toNum(target.shippingFee, toNum(target.shipping, 0));
      const adminFee = toNum(target.adminFee, 0);
      const quantity = Math.max(1, Math.floor(toNum(target.quantity, 1)));

      itemDetails = [
        {
          id: target.productId || "item",
          price: productPrice,
          quantity,
          name: String(target.productName || "Produk").slice(0, 50),
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
    }

    grossAmount = itemDetails.reduce((sum, item) => {
      return sum + toNum(item.price, 0) * toNum(item.quantity, 0);
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

    const customerName = String(target.receiverName || target.buyerName || "Customer").slice(0, 50);
    const customerPhone = String(target.receiverPhone || "");
    const customerAddress = String(target.address || "").slice(0, 200);

    const parameter = {
      transaction_details: {
        order_id: isCheckoutMode ? checkoutId : orderId,
        gross_amount: grossAmount,
      },
      item_details: itemDetails,
      customer_details: {
        first_name: customerName,
        phone: customerPhone,
        shipping_address: {
          first_name: customerName,
          phone: customerPhone,
          address: customerAddress,
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
      const liveSnap = await tx.get(targetRef);
      if (!liveSnap.exists) throw new Error("Order not found during save");

      const liveTarget = liveSnap.data() || {};
      const liveStatus = String(liveTarget.status || "").trim();
      const liveLimitMs = getTimestampMs(liveTarget.buyerCancelableUntilAt);

      if (liveTarget.buyerUid !== uid) {
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

      const alreadySavedToken = String(liveTarget.payment?.snapToken || "").trim();
      const alreadySavedRedirectUrl = String(
        liveTarget.payment?.redirectUrl || liveTarget.payment?.snapRedirectUrl || ""
      ).trim();

      if (alreadySavedToken) {
        return {
          snapToken: alreadySavedToken,
          redirectUrl: alreadySavedRedirectUrl,
          reused: true,
        };
      }

      tx.set(
        targetRef,
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
        { merge: true }
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
      if (isCheckoutMode) {
        await autoCancelExpiredCheckoutSession(db, targetRef);
      } else {
        await autoCancelExpiredOrder(db, targetRef);
      }
      return json(res, 409, { error: "Payment time limit exceeded" });
    }

    return json(res, 200, persisted);
  } catch (e) {
    console.error("ERROR FULL:", e);
    const detail = e?.ApiResponse?.error_messages || e?.message || String(e);
    const code = Number(e.statusCode) || 500;
    return json(res, code, {
      error: code >= 500 ? "Server error" : "Request failed",
      detail,
    });
  }
};