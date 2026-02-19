const { authAdmin } = require("./firebaseAdmin");

async function requireAuth(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new Error("Missing Authorization Bearer token");
  return await authAdmin.verifyIdToken(m[1]);
}

module.exports = { requireAuth };
