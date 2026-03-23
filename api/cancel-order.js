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

async function readProductStatesForReleaseTx(tx, releaseMap) {
  const productStates = [];

  for (const [productId, qtyToRelease] of releaseMap.entries()) {
    const productRef = dbAdmin.collection("products").doc(productId);
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

    const reserved = Number(p.productSnap.get("reserved") || 0);
    tx.update(p.productRef, {
      reserved: Math.max(0, reserved - p.qtyToRelease),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return json(res, 405, { error: "Method not allowed" });
    }

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

    // =========================================================
    // CANCEL CHECKOUT SESSION
    // =========================================================
    if (checkoutId) {
      const checkoutRef = dbAdmin.collection("checkout_sessions").doc(checkoutId);

      const result = await dbAdmin.runTransaction(async (tx) => {
        // ---------- READ PHASE ----------
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
        const orderRefs = orderIds.map((id) => dbAdmin.collection("orders").doc(String(id)));

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

        const productStates = await readProductStatesForReleaseTx(tx, releaseMap);

        // ---------- WRITE PHASE ----------
        applyReleaseWrites(tx, productStates);

        for (const state of orderStates) {
          if (!state.exists) continue;

          tx.update(state.orderRef, {
            status: "CANCELLED",
            cancelledByUid: uid,
            cancelledByRole: "BUYER",
            cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            "stock.reservedReleased": state.release ? true : !!state.order?.stock?.reservedReleased,
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

    // =========================================================
    // CANCEL SINGLE ORDER
    // =========================================================
    const orderRef = dbAdmin.collection("orders").doc(orderId);

    const result = await dbAdmin.runTransaction(async (tx) => {
      // ---------- READ PHASE ----------
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

      const release = shouldReleaseReserved(o);
      const releaseMap = new Map();
      if (release) {
        accumulateReleaseMap(releaseMap, o);
      }

      const productStates = await readProductStatesForReleaseTx(tx, releaseMap);

      // ---------- WRITE PHASE ----------
      applyReleaseWrites(tx, productStates);

      tx.update(orderRef, {
        status: "CANCELLED",
        cancelledByUid: uid,
        cancelledByRole: isSeller ? "SELLER" : "BUYER",
        cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        "stock.reservedReleased": release ? true : !!o?.stock?.reservedReleased,
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