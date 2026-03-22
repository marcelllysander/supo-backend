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

function mapStatus(txStatus) {
  switch (txStatus) {
    case "settlement":
    case "capture":
      return "PAID";
    case "pending":
      return "PENDING_PAYMENT";
    case "deny":
      return "PENDING_PAYMENT";
    case "cancel":
    case "expire":
    case "failure":
      return "CANCELLED";
    case "refund":
    case "partial_refund":
    case "chargeback":
      return "REFUNDED";
    default:
      return "PENDING_PAYMENT";
  }
}

function extractReservedItems(order) {
  const stockMeta = order?.stock || {};
  if (Array.isArray(stockMeta.items) && stockMeta.items.length > 0) {
    return stockMeta.items
      .map((it) => ({
        productId: String(it.productId || "").trim(),
        quantity: Number(it.quantity || 0),
      }))
      .filter((it) => it.productId && it.quantity > 0);
  }

  const productId = String(order?.productId || "").trim();
  const quantity = Number(order?.quantity || 0);
  if (!productId || quantity <= 0) return [];
  return [{ productId, quantity }];
}

async function releaseReservedItemsTx(t, db, order) {
  const stockMeta = order?.stock || {};
  const reservedApplied = !!stockMeta.reservedApplied;
  const reservedReleased = !!stockMeta.reservedReleased;
  const deducted = !!stockMeta.deducted;

  if (!reservedApplied || reservedReleased || deducted) return false;

  const items = extractReservedItems(order);
  for (const it of items) {
    const productRef = db.collection("products").doc(it.productId);
    const productSnap = await t.get(productRef);
    if (!productSnap.exists) continue;

    const reserved = Number(productSnap.get("reserved") || 0);
    t.update(productRef, {
      reserved: Math.max(0, reserved - it.quantity),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  return true;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return json(res, 405, { error: "Method not allowed" });
    }

    const secret = String(req.query?.secret || "");
    if (process.env.SUPO_WEBHOOK_SECRET && secret !== process.env.SUPO_WEBHOOK_SECRET) {
      return json(res, 401, { error: "Invalid webhook secret" });
    }

    initFirebase();
    const db = admin.firestore();

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    const orderId = String(body.order_id || "");
    const statusCode = String(body.status_code || "");
    const grossAmount = String(body.gross_amount || "");
    const signatureKey = String(body.signature_key || "");
    const transactionStatus = String(body.transaction_status || "");

    if (!orderId) return json(res, 400, { error: "Missing order_id" });

    const serverKey = process.env.MIDTRANS_SERVER_KEY || "";
    const expected = crypto
      .createHash("sha512")
      .update(orderId + statusCode + grossAmount + serverKey)
      .digest("hex");

    if (expected !== signatureKey) {
      return json(res, 401, { error: "Invalid signature" });
    }

    const newStatus = mapStatus(transactionStatus);
    const grossAmountNum = Number(grossAmount || 0);

    const checkoutRef = db.collection("checkout_sessions").doc(orderId);
    const checkoutSnap = await checkoutRef.get();

    if (checkoutSnap.exists) {
      const checkout = checkoutSnap.data() || {};

      await db.runTransaction(async (t) => {
        const liveCheckoutSnap = await t.get(checkoutRef);
        const liveCheckout = liveCheckoutSnap.data() || {};

        const currentCheckoutStatus = String(liveCheckout.status || "").trim();
        const orderIds = Array.isArray(liveCheckout.orderIds) ? liveCheckout.orderIds : [];

        const checkoutUpdate = {
          totalPembayaran: Number.isFinite(grossAmountNum) ? grossAmountNum : Number(liveCheckout.total || 0),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          payment: {
            provider: "MIDTRANS",
            transactionStatus,
            paymentType: body.payment_type || null,
            fraudStatus: body.fraud_status || null,
            statusCode,
            grossAmount,
            rawNotification: body,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
        };

        if (currentCheckoutStatus === "CANCELLED" && newStatus === "PAID") {
          checkoutUpdate.payment.needsManualReview = true;
          checkoutUpdate.payment.manualReviewReason =
            "Paid notification received after local cancellation";
        } else if (currentCheckoutStatus !== "DONE") {
          checkoutUpdate.status = newStatus;

          if (newStatus === "CANCELLED" && !liveCheckout.cancelledAt) {
            checkoutUpdate.cancelledAt = admin.firestore.FieldValue.serverTimestamp();
            checkoutUpdate.cancelledByRole = liveCheckout.cancelledByRole || "SYSTEM";
          }
        }

        t.set(checkoutRef, checkoutUpdate, { merge: true });

        for (const id of orderIds) {
          const orderRef = db.collection("orders").doc(String(id));
          const orderSnap = await t.get(orderRef);
          if (!orderSnap.exists) continue;

          const order = orderSnap.data() || {};
          const currentStatus = String(order.status || "").trim();

          const shouldReleaseReserved =
            ["CANCELLED", "REFUNDED"].includes(newStatus) &&
            !!order.stock?.reservedApplied &&
            !order.stock?.reservedReleased &&
            !order.stock?.deducted;

          let released = false;
          if (shouldReleaseReserved) {
            released = await releaseReservedItemsTx(t, db, order);
          }

          const orderUpdate = {
            totalPembayaran: Number.isFinite(grossAmountNum)
              ? grossAmountNum
              : Number(order.total || 0),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            payment: {
              provider: "MIDTRANS",
              transactionStatus,
              paymentType: body.payment_type || null,
              fraudStatus: body.fraud_status || null,
              statusCode,
              grossAmount,
              rawNotification: body,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
          };

          if (currentStatus === "CANCELLED" && newStatus === "PAID") {
            orderUpdate.payment.needsManualReview = true;
            orderUpdate.payment.manualReviewReason =
              "Paid notification received after local cancellation";
          } else if (currentStatus !== "DONE") {
            orderUpdate.status = newStatus;

            if (newStatus === "CANCELLED" && !order.cancelledAt) {
              orderUpdate.cancelledAt = admin.firestore.FieldValue.serverTimestamp();
              orderUpdate.cancelledByRole = order.cancelledByRole || "SYSTEM";
            }
          }

          if (released) {
            orderUpdate["stock.reservedReleased"] = true;
          }

          t.set(orderRef, orderUpdate, { merge: true });
        }
      });

      if (newStatus === "PAID") {
        const cartItemIds = Array.isArray(checkout.cartItemIds) ? checkout.cartItemIds : [];
        const buyerUid = String(checkout.buyerUid || "").trim();

        if (buyerUid && cartItemIds.length) {
          const batch = db.batch();
          for (const cartItemId of cartItemIds) {
            const cartRef = db
              .collection("users")
              .doc(buyerUid)
              .collection("cart")
              .doc(String(cartItemId));
            batch.delete(cartRef);
          }
          await batch.commit();
        }
      }

      return json(res, 200, {
        ok: true,
        status: newStatus,
        mode: "CHECKOUT_SESSION",
      });
    }

    await db.runTransaction(async (t) => {
      const orderRef = db.collection("orders").doc(orderId);
      const orderSnap = await t.get(orderRef);

      if (!orderSnap.exists) {
        t.set(
          orderRef,
          {
            status: newStatus,
            totalPembayaran: Number.isFinite(grossAmountNum) ? grossAmountNum : 0,
            payment: {
              provider: "MIDTRANS",
              transactionStatus,
              paymentType: body.payment_type || null,
              fraudStatus: body.fraud_status || null,
              statusCode,
              grossAmount: grossAmount,
              rawNotification: body,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        return;
      }

      const order = orderSnap.data() || {};
      const currentStatus = String(order.status || "").trim();

      const shouldReleaseReserved =
        ["CANCELLED", "REFUNDED"].includes(newStatus) &&
        !!order.stock?.reservedApplied &&
        !order.stock?.reservedReleased &&
        !order.stock?.deducted;

      let released = false;
      if (shouldReleaseReserved) {
        released = await releaseReservedItemsTx(t, db, order);
      }

      const orderUpdate = {
        totalPembayaran: Number.isFinite(grossAmountNum)
          ? grossAmountNum
          : Number(order.total || 0),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        payment: {
          provider: "MIDTRANS",
          transactionStatus,
          paymentType: body.payment_type || null,
          fraudStatus: body.fraud_status || null,
          statusCode,
          grossAmount,
          rawNotification: body,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      };

      if (currentStatus === "CANCELLED" && newStatus === "PAID") {
        orderUpdate.payment.needsManualReview = true;
        orderUpdate.payment.manualReviewReason =
          "Paid notification received after local cancellation";
      } else if (currentStatus !== "DONE") {
        orderUpdate.status = newStatus;

        if (newStatus === "CANCELLED" && !order.cancelledAt) {
          orderUpdate.cancelledAt = admin.firestore.FieldValue.serverTimestamp();
          orderUpdate.cancelledByRole = order.cancelledByRole || "SYSTEM";
        }
      }

      if (released) {
        orderUpdate["stock.reservedReleased"] = true;
      }

      t.set(orderRef, orderUpdate, { merge: true });
    });

    return json(res, 200, { ok: true, status: newStatus });
  } catch (e) {
    console.error("midtrans-webhook error:", e);
    return json(res, 500, { error: "Server error", detail: String(e.message || e) });
  }
};