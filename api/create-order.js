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
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    const productId = String(body.productId || "").trim();
    const quantity = Math.floor(toNum(body.quantity, 0));

    const receiverName = String(body.receiverName || "").trim();
    const receiverPhone = String(body.receiverPhone || "").trim();
    const address = String(body.address || "").trim();
    const noteToSeller = String(body.noteToSeller || "").trim();

    const shipping = Math.max(0, Math.floor(toNum(body.shipping, 0)));
    const adminFee = Math.max(0, Math.floor(toNum(body.adminFee, 0)));
    const distanceKm = Math.max(0, toNum(body.distanceKm, 0));

    if (!productId) return json(res, 400, { error: "productId required" });
    if (quantity <= 0) return json(res, 400, { error: "quantity invalid" });
    if (!receiverName || !receiverPhone || !address) {
      return json(res, 400, { error: "Data alamat penerima belum lengkap" });
    }

    const productRef = dbAdmin.collection("products").doc(productId);
    const orderRef = dbAdmin.collection("orders").doc();

    const result = await dbAdmin.runTransaction(async (tx) => {
      const productSnap = await tx.get(productRef);
      if (!productSnap.exists) throw new Error("Produk tidak ditemukan.");

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

      if (!sellerUid) throw new Error("Produk tidak valid (sellerUid kosong).");
      if (buyerUid === sellerUid) throw new Error("Tidak bisa membeli produk sendiri.");
      if (status !== "PUBLISHED") throw new Error("Produk belum dipublish.");
      if (quantity > available) throw new Error(`Stok tidak cukup. Tersedia: ${available}`);

      const subtotal = price * quantity;
      const total = subtotal + shipping + adminFee;

      // Reserve stok
      tx.update(productRef, {
        reserved: reserved + quantity,
      });

      // Simpan order (struktur disesuaikan dengan create-snap-token.js & webhook kamu)
      const orderData = {
        buyerUid,
        sellerUid,
        productId,
        productName,
        productImage,
        sellerCompanyName,

        price,
        quantity,
        subtotal,
        shipping,
        adminFee,
        distanceKm,
        total,

        status: "PENDING_PAYMENT",

        receiverName,
        receiverPhone,
        address,
        noteToSeller,

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
        total,
        subtotal,
      };
    });

    return json(res, 200, {
      ok: true,
      orderId: result.orderId,
      message: "Order created",
    });
  } catch (e) {
    console.error("create-order error:", e);
    return json(res, 500, {
      error: "Server error",
      detail: String(e.message || e),
    });
  }
};
