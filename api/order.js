// api/order.js
const handleCreateOrder = require("../lib/handlers/order/create-order");
const handleCancelOrder = require("../lib/handlers/order/cancel-order");

function parseBody(req) {
  try {
    if (!req.body) return {};
    if (typeof req.body === "string") return JSON.parse(req.body || "{}");
    return req.body || {};
  } catch {
    return {};
  }
}

function looksLikeCreateOrder(body) {
  return (
    String(body.mode || "").trim().toUpperCase() === "CART" ||
    !!body.productId ||
    !!body.receiverName ||
    !!body.quantity ||
    Array.isArray(body.items)
  );
}

function looksLikeCancelOrder(body) {
  return !!body.orderId || !!body.checkoutId;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const body = parseBody(req);
    req.body = body;

    if (looksLikeCreateOrder(body)) {
      return await handleCreateOrder(req, res);
    }

    if (looksLikeCancelOrder(body)) {
      return await handleCancelOrder(req, res);
    }

    return res.status(400).json({
      ok: false,
      message: "Request order tidak dikenali.",
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e?.message || "Server error",
    });
  }
};