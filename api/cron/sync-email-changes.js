const { admin, authAdmin, dbAdmin } = require("../../lib/firebaseAdmin");

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ ok: false, message: "Method not allowed" });

  // ✅ amankan cron (Vercel akan kirim Authorization: Bearer <CRON_SECRET>)
  const authHeader = req.headers.authorization || "";
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false, message: "Unauthorized" });
  }

  try {
    const FieldValue = admin.firestore.FieldValue;

    let checked = 0;
    let updated = 0;

    // helper sinkron 1 koleksi
    async function syncCollection(colName) {
      const q = await dbAdmin.collection(colName).where("companyEmailChangeStatus", "==", "PENDING_VERIFY").limit(200).get();

      if (q.empty) return;

      const batch = dbAdmin.batch();

      for (const doc of q.docs) {
        checked++;
        const uid = doc.id;

        const pending = doc.get("pendingCompanyEmail");
        if (!pending) {
          batch.update(doc.ref, {
            companyEmailChangeStatus: "NONE",
            pendingCompanyEmail: FieldValue.delete(),
          });
          continue;
        }

        // cek email di Firebase Auth
        const u = await authAdmin.getUser(uid).catch(() => null);
        if (!u || !u.email) continue;

        // syarat: email Auth sudah berubah + terverifikasi
        const isMatch = (u.email || "").toLowerCase() === String(pending).toLowerCase();
        if (!isMatch) continue;

        // kalau kamu mau wajib verified:
        if (u.emailVerified !== true) continue;

        updated++;

        batch.update(doc.ref, {
          companyEmail: u.email,
          companyEmailChangeStatus: "DONE",
          pendingCompanyEmail: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        });

        // opsional: sinkron juga ke users/{uid}
        batch.set(dbAdmin.collection("users").doc(uid), { companyEmail: u.email, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

        // opsional: sinkron juga ke publicProfiles/{uid} (kalau kamu simpan email di situ)
        // batch.set(dbAdmin.collection("publicProfiles").doc(uid), { email: u.email }, { merge: true });
      }

      await batch.commit();
    }

    // ✅ sync ke dua koleksi: companies & suppliers
    await syncCollection("companies");
    await syncCollection("suppliers");

    return res.status(200).json({ ok: true, checked, updated });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message || "Server error" });
  }
};
