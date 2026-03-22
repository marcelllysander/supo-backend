const { admin, authAdmin, dbAdmin } = require("../lib/firebaseAdmin");
const midtransClient = require("midtrans-client");

function json(res, code, data) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

function httpError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

const badRequest = (m) => httpError(400, m);
const forbidden = (m) => httpError(403, m);
const conflict = (m) => httpError(409, m);
const notFound = (m) => httpError(404, m);

function parseJsonBody(req) {
  try {
    if (!req.body) return {};
    if (typeof req.body === "string") return JSON.parse(req.body || "{}");
    return req.body || {};
  } catch (_) {
    throw badRequest("Body JSON tidak valid");
  }
}

function createMidtransClient() {
  const isProduction = String(process.env.MIDTRANS_IS_PRODUCTION) === "true";
  const serverKey = process.env.MIDTRANS_SERVER_KEY;
  const clientKey = process.env.MIDTRANS_CLIENT_KEY;

  if (!serverKey || !clientKey) return null;

  return new midtransClient.Snap({
    isProduction,
    serverKey,
    clientKey,
  });
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

async function releaseReservedItemsTx(tx, order) {
  const stockMeta = order?.stock || {};
  const reservedApplied = !!stockMeta.reservedApplied;
  const reservedReleased = !!stockMeta.reservedReleased;
  const deducted = !!stockMeta.deducted;

  if (!reservedApplied || reservedReleased || deducted) return;

  const items = extractReservedItems(order);
  for (const it of items) {
    const productRef = dbAdmin.collection("products").doc(it.productId);
    const productSnap = await tx.get(productRef);
    if (!productSnap.exists) continue;

    const reserved = Number(productSnap.get("reserved") || 0);
    tx.update(productRef, {
      reserved: Math.max(0, reserved - it.quantity),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return json(res, 401, { error: "Missing auth token" });

    const decoded = await authAdmin.verifyIdToken(token);
    const uid = decoded.uid;

    const body = parseJsonBody(req);
    const orderId = String(body.orderId || "").trim();
    const checkoutId = String(body.checkoutId || "").trim();

    if (!orderId && !checkoutId) {
      throw badRequest("orderId or checkoutId required");
    }

    if (checkoutId) {
      const checkoutRef = dbAdmin.collection("checkout_sessions").doc(checkoutId);

      const result = await dbAdmin.runTransaction(async (tx) => {
        const checkoutSnap = await tx.get(checkoutRef);
        if (!checkoutSnap.exists) throw notFound("Checkout tidak ditemukan");

        const c = checkoutSnap.data() || {};
        const status = String(c.status || "").trim();
        const buyerUid = String(c.buyerUid || "").trim();

        if (uid !== buyerUid) {
          throw forbidden("Hanya pembeli yang bisa membatalkan checkout");
        }

        if (["PAID", "PROCESSING", "SHIPPING", "DONE", "CANCELLED", "REFUNDED"].includes(status)) {
          throw conflict(`Checkout tidak bisa dibatalkan pada status ${status}`);
        }

        const buyerCancelableUntilAt = c.buyerCancelableUntilAt || null;
        const nowMs = Date.now();
        const limitMs = buyerCancelableUntilAt?.toMillis?.() || 0;
        if (!limitMs || nowMs >= limitMs) {
          throw conflict("Batas waktu cancel pembeli sudah habis (15 menit)");
        }

        const orderIds = Array.isArray(c.orderIds) ? c.orderIds : [];
        for (const id of orderIds) {
          const orderRef = dbAdmin.collection("orders").doc(String(id));
          const orderSnap = await tx.get(orderRef);
          if (!orderSnap.exists) continue;

          const o = orderSnap.data() || {};
          await releaseReservedItemsTx(tx, o);

          tx.update(orderRef, {
            status: "CANCELLED",
            cancelledByUid: uid,
            cancelledByRole: "BUYER",
            cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            "stock.reservedReleased": true,
          });
        }

        tx.update(checkoutRef, {
          status: "CANCELLED",
          cancelledByUid: uid,
          cancelledByRole: "BUYER",
          cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return {
          ok: true,
          shouldExpireMidtrans:
            status === "PENDING_PAYMENT" &&
            String(c.payment?.provider || "MIDTRANS") === "MIDTRANS" &&
            !!String(c.payment?.snapToken || "").trim(),
        };
      });

      if (result.shouldExpireMidtrans) {
        const apiClient = createMidtransClient();
        if (apiClient) {
          try {
            await apiClient.transaction.expire(checkoutId);
          } catch (expireErr) {
            try {
              await apiClient.transaction.cancel(checkoutId);
            } catch (_) {}
          }
        }
      }

      return json(res, 200, { ok: true, message: "Checkout dibatalkan" });
    }

    const orderRef = dbAdmin.collection("orders").doc(orderId);

    const result = await dbAdmin.runTransaction(async (tx) => {
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap.exists) throw notFound("Order tidak ditemukan");

      const o = orderSnap.data() || {};
      const status = String(o.status || "").trim();
      const buyerUid = String(o.buyerUid || "").trim();
      const sellerUid = String(o.sellerUid || "").trim();
      const checkoutSessionId = String(o.checkoutSessionId || "").trim();

      if (checkoutSessionId) {
        throw conflict("Order ini bagian dari checkout gabungan. Batalkan checkout gabungannya.");
      }

      const isBuyer = uid === buyerUid;
      const isSeller = uid === sellerUid;
      if (!isBuyer && !isSeller) throw forbidden("Tidak memiliki akses");

      if (["PAID", "PROCESSING", "SHIPPING", "DONE", "CANCELLED", "REFUNDED"].includes(status)) {
        throw conflict(`Order tidak bisa dibatalkan pada status ${status}`);
      }

      if (isBuyer) {
        const buyerCancelableUntilAt = o.buyerCancelableUntilAt || null;
        const nowMs = Date.now();
        const limitMs = buyerCancelableUntilAt?.toMillis?.() || 0;
        if (!limitMs || nowMs >= limitMs) {
          throw conflict("Batas waktu cancel pembeli sudah habis (15 menit)");
        }
      }

      await releaseReservedItemsTx(tx, o);

      tx.update(orderRef, {
        status: "CANCELLED",
        cancelledByUid: uid,
        cancelledByRole: isSeller ? "SELLER" : "BUYER",
        cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        "stock.reservedReleased": true,
      });

      return {
        ok: true,
        previousStatus: status,
        shouldExpireMidtrans:
          status === "PENDING_PAYMENT" &&
          String(o.payment?.provider || "MIDTRANS") === "MIDTRANS" &&
          !!String(o.payment?.snapToken || "").trim(),
      };
    });

    if (result.shouldExpireMidtrans) {
      const apiClient = createMidtransClient();

      if (apiClient) {
        try {
          await apiClient.transaction.expire(orderId);
        } catch (expireErr) {
          console.warn("Midtrans expire failed, fallback cancel:", expireErr?.message || expireErr);

          try {
            await apiClient.transaction.cancel(orderId);
          } catch (cancelErr) {
            console.warn("Midtrans cancel fallback failed:", cancelErr?.message || cancelErr);
          }
        }
      }
    }

    return json(res, 200, { ok: true, message: "Order dibatalkan" });
  } catch (e) {
    console.error("cancel-order error:", e);
    const code = Number(e.statusCode) || 500;
    return json(res, code, {
      error: code >= 500 ? "Server error" : "Request failed",
      detail: String(e.message || e),
    });
  }
};