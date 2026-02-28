const { admin, authAdmin, dbAdmin } = require("../lib/firebaseAdmin");

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
    if (!orderId) throw badRequest("orderId required");

    const orderRef = dbAdmin.collection("orders").doc(orderId);

    const result = await dbAdmin.runTransaction(async (tx) => {
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap.exists) throw notFound("Order tidak ditemukan");

      const o = orderSnap.data() || {};
      const status = String(o.status || "").trim();
      const buyerUid = String(o.buyerUid || "").trim();
      const sellerUid = String(o.sellerUid || "").trim();
      const productId = String(o.productId || "").trim();

      if (!productId) throw badRequest("Order tidak valid (productId kosong)");

      const isBuyer = uid === buyerUid;
      const isSeller = uid === sellerUid;
      if (!isBuyer && !isSeller) throw forbidden("Tidak memiliki akses");

      if (["PROCESSING", "SHIPPING", "DONE", "CANCELLED"].includes(status)) {
        throw conflict(`Order tidak bisa dibatalkan pada status ${status}`);
      }

      // Aturan cancel buyer: max 15 menit
      if (isBuyer) {
        const buyerCancelableUntilAt = o.buyerCancelableUntilAt || null;
        const nowMs = Date.now();
        const limitMs = buyerCancelableUntilAt?.toMillis?.() || 0;
        if (!limitMs || nowMs > limitMs) {
          throw conflict("Batas waktu cancel pembeli sudah habis (15 menit)");
        }
      }

      // release reserved stock (jika belum direlease)
      const productRef = dbAdmin.collection("products").doc(productId);
      const productSnap = await tx.get(productRef);
      if (!productSnap.exists) throw notFound("Produk tidak ditemukan");

      const p = productSnap.data() || {};
      const qty = Number(o.quantity || 0);
      const reserved = Number(p.reserved || 0);

      const stockMeta = o.stock || {};
      const reservedApplied = !!stockMeta.reservedApplied;
      const reservedReleased = !!stockMeta.reservedReleased;

      if (reservedApplied && !reservedReleased && qty > 0) {
        tx.update(productRef, {
          reserved: Math.max(0, reserved - qty),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      tx.update(orderRef, {
        status: "CANCELLED",
        cancelledByUid: uid,
        cancelledByRole: isSeller ? "SELLER" : "BUYER",
        cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        "stock.reservedReleased": true,
      });

      return { ok: true };
    });

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
