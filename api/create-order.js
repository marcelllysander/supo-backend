// supo-backend/api/create-order.js
const { admin, authAdmin, dbAdmin } = require("../lib/firebaseAdmin");

function json(res, code, data) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function httpError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

function badRequest(msg) {
  return httpError(400, msg);
}

function conflict(msg) {
  return httpError(409, msg);
}

function notFound(msg) {
  return httpError(404, msg);
}

function parseJsonBody(req) {
  try {
    if (!req.body) return {};
    if (typeof req.body === "string") return JSON.parse(req.body || "{}");
    return req.body || {};
  } catch (_) {
    throw badRequest("Body JSON tidak valid");
  }
}

function makeOrderCode(orderId) {
  const now = Date.now();
  const suffix = String(orderId || "")
    .slice(0, 6)
    .toUpperCase();
  return `ORD-${now}-${suffix}`;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return json(res, 405, { error: "Method not allowed" });
    }

    // 1) Firebase ID Token dari header Authorization: Bearer <token>
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return json(res, 401, { error: "Missing auth token" });

    const decoded = await authAdmin.verifyIdToken(token);
    const buyerUid = decoded.uid;

    // 2) Body
    const body = parseJsonBody(req);

    const productId = String(body.productId || "").trim();
    const quantity = Math.floor(toNum(body.quantity, 0));

    const receiverName = String(body.receiverName || "").trim();
    const receiverPhone = String(body.receiverPhone || "").trim();
    const address = String(body.address || "").trim();
    const noteToSeller = String(body.noteToSeller || "").trim();

    const shipping = Math.max(0, Math.floor(toNum(body.shipping, 0)));
    const adminFee = Math.max(0, Math.floor(toNum(body.adminFee, 0)));
    const distanceKm = Math.max(0, toNum(body.distanceKm, 0));

    if (!productId) throw badRequest("productId required");
    if (quantity <= 0) throw badRequest("quantity invalid");
    if (!receiverName || !receiverPhone || !address) {
      throw badRequest("Data alamat penerima belum lengkap");
    }

    // Optional guard (boleh dipakai kalau mau lebih ketat)
    // if (shipping > 30000) throw badRequest("shipping terlalu besar");
    // if (adminFee > 15000) throw badRequest("adminFee terlalu besar");

    const productRef = dbAdmin.collection("products").doc(productId);
    const orderRef = dbAdmin.collection("orders").doc();

    const result = await dbAdmin.runTransaction(async (tx) => {
      const productSnap = await tx.get(productRef);
      if (!productSnap.exists) throw notFound("Produk tidak ditemukan.");

      const p = productSnap.data() || {};

      const sellerUid = String(p.sellerUid || "").trim();
      const status = String(p.status || "").trim();

      const stock = toNum(p.stock, 0);
      const reserved = toNum(p.reserved, 0);
      const available = Math.max(0, stock - reserved);

      const price = Math.floor(toNum(p.price, 0));
      const productName = String(p.name || "").trim();
      const productImage = Array.isArray(p.images) && typeof p.images[0] === "string" ? p.images[0] : "";
      const sellerCompanyName = String(p.companyName || "").trim();

      if (!sellerUid) throw badRequest("Produk tidak valid (sellerUid kosong).");
      if (buyerUid === sellerUid) throw badRequest("Tidak bisa membeli produk sendiri.");
      if (status !== "PUBLISHED") throw conflict("Produk belum dipublish.");
      if (quantity > available) throw conflict(`Stok tidak cukup. Tersedia: ${available}`);

      // Hitung ulang di backend (lebih aman)
      const subtotal = price * quantity;
      const total = subtotal + shipping + adminFee;

      // Reserve stok
      tx.update(productRef, {
        reserved: reserved + quantity,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(), // optional
      });

      // Sementara fallback: buyerName = receiverName
      // Nanti kalau mau, bisa ganti ke nama dari users/{buyerUid}
      const buyerName = receiverName;
      const orderCode = makeOrderCode(orderRef.id);
      const buyerCancelableUntilAt = admin.firestore.Timestamp.fromMillis(Date.now() + 15 * 60 * 1000);

      const orderData = {
        buyerUid,
        sellerUid,
        productId,
        orderCode,
        buyerCancelableUntilAt,

        // ===== Nama untuk history/detail (kompatibel dengan app) =====
        buyerName, // dipakai TransactionHistoryModel
        sellerName: sellerCompanyName, // alias untuk app

        // ===== Field lama (kompatibilitas ke fitur lama) =====
        sellerCompanyName,

        productName,
        productImage,

        // ===== Harga & biaya (kompatibel dengan app) =====
        productPrice: price, // alias untuk app
        price, // legacy
        quantity,

        shippingFee: shipping, // alias untuk app
        shipping, // legacy
        adminFee,
        distanceKm,

        subtotal,
        total,

        status: "PENDING_PAYMENT",

        // Data pengiriman
        receiverName,
        receiverPhone,
        address,
        noteToSeller,

        // Tracking stok order
        stock: {
          reservedApplied: true,
          reservedReleased: false,
          deducted: false,
        },

        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      tx.set(orderRef, orderData);

      return {
        orderId: orderRef.id,
        orderCode,
        total,
        subtotal,
      };
    });

    return json(res, 200, {
      ok: true,
      orderId: result.orderId,
      orderCode: result.orderCode,
      message: "Order created",
    });
  } catch (e) {
    console.error("create-order error:", e);
    const code = Number(e.statusCode) || 500;
    return json(res, code, {
      error: code >= 500 ? "Server error" : "Request failed",
      detail: String(e.message || e),
    });
  }
};
