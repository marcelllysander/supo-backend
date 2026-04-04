// lib/handlers/order/create-order.js
const { admin, authAdmin, dbAdmin } = require("../../firebaseAdmin");

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

function forbidden(msg) {
  return httpError(403, msg);
}

async function assertBuyerCanCheckout(buyerUid) {
  const buyerUserRef = dbAdmin.collection("users").doc(buyerUid);
  const buyerUserSnap = await buyerUserRef.get();

  if (!buyerUserSnap.exists) {
    throw forbidden("Profil user tidak ditemukan.");
  }

  const verificationStatus = String(
    buyerUserSnap.get("verificationStatus") || ""
  ).trim().toUpperCase();

  const canCheckout = buyerUserSnap.get("canCheckout") === true;

  if (verificationStatus !== "VERIFIED" || !canCheckout) {
    throw forbidden("Akun harus diverifikasi terlebih dahulu sebelum checkout.");
  }
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
  const suffix = String(orderId || "").slice(0, 6).toUpperCase();
  return `ORD-${now}-${suffix}`;
}

async function handleCartCheckout({ body, buyerUid, res }) {
  const items = Array.isArray(body.items) ? body.items : [];
  const stores = Array.isArray(body.stores) ? body.stores : [];

  const receiverName = String(body.receiverName || "").trim();
  const receiverPhone = String(body.receiverPhone || "").trim();
  const address = String(body.address || "").trim();

  if (!receiverName || !receiverPhone || !address) {
    throw badRequest("Data alamat penerima belum lengkap");
  }

  if (!items.length) {
    throw badRequest("items cart kosong");
  }

  const normalizedItems = items.map((it) => ({
    productId: String(it.productId || "").trim(),
    quantity: Math.floor(toNum(it.quantity, 0)),
    cartItemId: String(it.cartItemId || "").trim(),
  }));

  for (const it of normalizedItems) {
    if (!it.productId) throw badRequest("Ada productId kosong pada cart");
    if (it.quantity <= 0) throw badRequest("Ada quantity cart tidak valid");
  }

  const storeConfigMap = new Map();
  for (const s of stores) {
    const sellerUid = String(s.sellerUid || "").trim();
    if (!sellerUid) continue;

    const shipping = Math.max(0, Math.floor(toNum(s.shipping, 0)));
    const adminFee = Math.max(0, Math.floor(toNum(s.adminFee, 0)));
    const distanceKm = Math.max(0, toNum(s.distanceKm, 0));
    const noteToSeller = String(s.noteToSeller || "").trim();

    if (shipping > 30000) {
      throw badRequest(`shipping terlalu besar untuk seller ${sellerUid}`);
    }
    if (adminFee > 15000) {
      throw badRequest(`adminFee terlalu besar untuk seller ${sellerUid}`);
    }

    storeConfigMap.set(sellerUid, {
      shipping,
      adminFee,
      distanceKm,
      noteToSeller,
    });
  }

  const checkoutRef = dbAdmin.collection("checkout_sessions").doc();
  const buyerCancelableUntilAt = admin.firestore.Timestamp.fromMillis(
    Date.now() + 15 * 60 * 1000
  );

  const result = await dbAdmin.runTransaction(async (tx) => {
    const productRefs = normalizedItems.map((it) =>
      dbAdmin.collection("products").doc(it.productId)
    );

    const productSnaps = [];
    for (const ref of productRefs) {
      productSnaps.push(await tx.get(ref));
    }

    const preparedItems = [];
    const reserveMap = new Map();

    for (let i = 0; i < normalizedItems.length; i++) {
      const reqItem = normalizedItems[i];
      const productSnap = productSnaps[i];

      if (!productSnap.exists) {
        throw notFound(`Produk tidak ditemukan: ${reqItem.productId}`);
      }

      const p = productSnap.data() || {};
      const sellerUid = String(p.sellerUid || "").trim();
      const productStatus = String(p.status || "").trim();
      const stock = toNum(p.stock, 0);
      const reserved = toNum(p.reserved, 0);
      const available = Math.max(0, stock - reserved);
      const price = Math.floor(toNum(p.price, 0));
      const productName = String(p.name || "").trim();
      const productImage =
        Array.isArray(p.images) && typeof p.images[0] === "string" ? p.images[0] : "";
      const sellerName = String(p.companyName || "").trim();
      const location = String(p.location || "").trim();
      const unitLabel = String(p.unitLabel || "").trim() || "pcs";
      const minOrder = Math.max(1, Math.floor(toNum(p.minOrder, 1)));

      if (!sellerUid) throw badRequest("Produk tidak valid (sellerUid kosong).");
      if (buyerUid === sellerUid) throw badRequest("Tidak bisa membeli produk sendiri.");
      if (productStatus !== "PUBLISHED") {
        throw conflict(`Produk ${productName || reqItem.productId} belum dipublish.`);
      }
      if (reqItem.quantity < minOrder) {
        throw badRequest(`Minimal order untuk ${productName || reqItem.productId} adalah ${minOrder} ${unitLabel}.`);
      }
      if (reqItem.quantity > available) {
        throw conflict(`Stok tidak cukup untuk ${productName}. Tersedia: ${available}`);
      }

      preparedItems.push({
        productId: reqItem.productId,
        cartItemId: reqItem.cartItemId,
        sellerUid,
        sellerName,
        productName,
        productImage,
        location,
        productPrice: price,
        quantity: reqItem.quantity,
        lineSubtotal: price * reqItem.quantity,
      });

      reserveMap.set(
        reqItem.productId,
        Math.max(0, toNum(reserveMap.get(reqItem.productId), 0)) + reqItem.quantity
      );
    }

    // reserve stok
    for (let i = 0; i < normalizedItems.length; i++) {
      const reqItem = normalizedItems[i];
      const productRef = productRefs[i];
      const productSnap = productSnaps[i];
      const p = productSnap.data() || {};

      const firstIndex = normalizedItems.findIndex((x) => x.productId === reqItem.productId);
      if (firstIndex !== i) continue;

      const totalReserveForProduct = reserveMap.get(reqItem.productId) || 0;
      const reserved = toNum(p.reserved, 0);

      tx.update(productRef, {
        reserved: reserved + totalReserveForProduct,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    const groups = new Map();
    for (const item of preparedItems) {
      const arr = groups.get(item.sellerUid) || [];
      arr.push(item);
      groups.set(item.sellerUid, arr);
    }

    const orderIds = [];
    const storeSummaries = [];
    let grandSubtotal = 0;
    let grandShipping = 0;
    let grandAdminFee = 0;
    let grandTotal = 0;

    for (const [sellerUid, sellerItems] of groups.entries()) {
      const orderRef = dbAdmin.collection("orders").doc();
      const firstItem = sellerItems[0];

      const cfg = storeConfigMap.get(sellerUid) || {
        shipping: 0,
        adminFee: 0,
        distanceKm: 0,
        noteToSeller: "",
      };

      const subtotal = sellerItems.reduce((sum, it) => sum + toNum(it.lineSubtotal, 0), 0);
      const totalQty = sellerItems.reduce((sum, it) => sum + toNum(it.quantity, 0), 0);
      const total = subtotal + cfg.shipping + cfg.adminFee;

      const previewName =
        sellerItems.length > 1
          ? `${firstItem.productName} +${sellerItems.length - 1} produk lainnya`
          : firstItem.productName;

      const orderCode = makeOrderCode(orderRef.id);

      const orderData = {
        buyerUid,
        sellerUid,
        checkoutSessionId: checkoutRef.id,
        orderType: "CART_MULTI_ITEM",
        orderCode,
        buyerCancelableUntilAt,

        buyerName: receiverName,
        sellerName: firstItem.sellerName,
        sellerCompanyName: firstItem.sellerName,

        // preview kompatibel
        productId: firstItem.productId,
        productName: previewName,
        productImage: firstItem.productImage,
        productPrice: firstItem.productPrice,
        price: firstItem.productPrice,
        quantity: totalQty,

        items: sellerItems.map((it) => ({
          productId: it.productId,
          productName: it.productName,
          productImage: it.productImage,
          location: it.location,
          productPrice: it.productPrice,
          quantity: it.quantity,
          lineSubtotal: it.lineSubtotal,
        })),
        itemCount: sellerItems.length,

        subtotal,
        shippingFee: cfg.shipping,
        shipping: cfg.shipping,
        adminFee: cfg.adminFee,
        distanceKm: cfg.distanceKm,
        total,

        receiverName,
        receiverPhone,
        address,
        noteToSeller: cfg.noteToSeller,

        status: "PENDING_PAYMENT",

        stock: {
          reservedApplied: true,
          reservedReleased: false,
          deducted: false,
          items: sellerItems.map((it) => ({
            productId: it.productId,
            quantity: it.quantity,
          })),
        },

        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      tx.set(orderRef, orderData);
      orderIds.push(orderRef.id);

      storeSummaries.push({
        sellerUid,
        sellerName: firstItem.sellerName,
        subtotal,
        shippingFee: cfg.shipping,
        adminFee: cfg.adminFee,
        total,
        itemCount: sellerItems.length,
      });

      grandSubtotal += subtotal;
      grandShipping += cfg.shipping;
      grandAdminFee += cfg.adminFee;
      grandTotal += total;
    }

    tx.set(checkoutRef, {
      buyerUid,
      orderIds,
      cartItemIds: preparedItems.map((it) => it.cartItemId).filter(Boolean),
      items: preparedItems,
      stores: storeSummaries,
      subtotal: grandSubtotal,
      shippingFee: grandShipping,
      adminFee: grandAdminFee,
      total: grandTotal,
      receiverName,
      receiverPhone,
      address,
      status: "PENDING_PAYMENT",
      buyerCancelableUntilAt,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      checkoutId: checkoutRef.id,
      orderIds,
      total: grandTotal,
    };
  });

  return json(res, 200, {
    ok: true,
    checkoutId: result.checkoutId,
    orderIds: result.orderIds,
    message: "Checkout cart created",
  });
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
    const buyerUid = decoded.uid;

    await assertBuyerCanCheckout(buyerUid);

    const body = parseJsonBody(req);
    const mode = String(body.mode || "").trim().toUpperCase();

    if (mode === "CART") {
      return await handleCartCheckout({
        body,
        buyerUid,
        res,
      });
    }

    const productId = String(body.productId || "").trim();
    const quantity = Math.floor(toNum(body.quantity, 0));

    const receiverName = String(body.receiverName || "").trim();
    const receiverPhone = String(body.receiverPhone || "").trim();
    const address = String(body.address || "").trim();
    const noteToSeller = String(body.noteToSeller || "").trim();

    const shipping = Math.max(0, Math.floor(toNum(body.shipping, 0)));
    const adminFee = Math.max(0, Math.floor(toNum(body.adminFee, 0)));

    if (shipping > 30000) throw badRequest("shipping terlalu besar");
    if (adminFee > 15000) throw badRequest("adminFee terlalu besar");

    const distanceKm = Math.max(0, toNum(body.distanceKm, 0));

    if (!productId) throw badRequest("productId required");
    if (quantity <= 0) throw badRequest("quantity invalid");
    if (!receiverName || !receiverPhone || !address) {
      throw badRequest("Data alamat penerima belum lengkap");
    }

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
      const productImage =
        Array.isArray(p.images) && typeof p.images[0] === "string" ? p.images[0] : "";
      const sellerCompanyName = String(p.companyName || "").trim();
      const location = String(p.location || "").trim();
      const unitLabel = String(p.unitLabel || "").trim() || "pcs";
      const minOrder = Math.max(1, Math.floor(toNum(p.minOrder, 1)));

      if (!sellerUid) throw badRequest("Produk tidak valid (sellerUid kosong).");
      if (buyerUid === sellerUid) throw badRequest("Tidak bisa membeli produk sendiri.");
      if (status !== "PUBLISHED") throw conflict("Produk belum dipublish.");
      if (quantity < minOrder) {
        throw badRequest(`Minimal order untuk ${productName || "produk ini"} adalah ${minOrder} ${unitLabel}.`);
      } 
      if (quantity > available) throw conflict(`Stok tidak cukup. Tersedia: ${available}`);

      const subtotal = price * quantity;
      const total = subtotal + shipping + adminFee;

      tx.update(productRef, {
        reserved: reserved + quantity,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const buyerName = receiverName;
      const orderCode = makeOrderCode(orderRef.id);
      const buyerCancelableUntilAt = admin.firestore.Timestamp.fromMillis(
        Date.now() + 15 * 60 * 1000
      );

      const orderData = {
        buyerUid,
        sellerUid,
        orderType: "SINGLE_PRODUCT",
        productId,
        orderCode,
        buyerCancelableUntilAt,

        buyerName,
        sellerName: sellerCompanyName,
        sellerCompanyName,

        productName,
        productImage,

        productPrice: price,
        price,
        quantity,

        items: [
          {
            productId,
            productName,
            productImage,
            location,
            productPrice: price,
            quantity,
            lineSubtotal: subtotal,
          },
        ],
        itemCount: 1,

        shippingFee: shipping,
        shipping,
        adminFee,
        distanceKm,

        subtotal,
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
          items: [
            {
              productId,
              quantity,
            },
          ],
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