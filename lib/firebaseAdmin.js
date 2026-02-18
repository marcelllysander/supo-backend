const admin = require("firebase-admin");

function getPrivateKey() {
  const k = process.env.FIREBASE_PRIVATE_KEY;
  if (!k) throw new Error("Missing FIREBASE_PRIVATE_KEY");
  return k.replace(/\\n/g, "\n");
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: getPrivateKey(),
    }),
  });
}

const authAdmin = admin.auth();
const dbAdmin = admin.firestore();

module.exports = { admin, authAdmin, dbAdmin };
