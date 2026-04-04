// lib/handlers/admin/verification.js
const { admin, dbAdmin } = require("../../firebaseAdmin");

function normalizeType(type) {
  const t = String(type || "").trim().toLowerCase();
  return t === "supplier" ? "supplier" : "company";
}

function pick(...vals) {
  for (const v of vals) {
    const s = String(v || "").trim();
    if (s) return s;
  }
  return "";
}

function safeObj(v) {
  return v && typeof v === "object" ? v : {};
}

function getRequestRef(type, uid) {
  if (type === "supplier") {
    return dbAdmin.collection("supplier_verification_requests").doc(uid);
  }
  return dbAdmin.collection("business_verification_requests").doc(uid);
}

function buildSupplierProfileFromRequest(uid, data, adminUid) {
  const addressData = safeObj(data.supplierAddressData);

  return {
    uid,
    companyName: pick(data.supplierName, data.companyName),
    companyEmail: pick(data.supplierEmail, data.companyEmail),
    companyPhone: pick(data.supplierPhone, data.companyPhone),
    companyPicName: pick(data.supplierPicName, data.companyPicName),
    businessType: pick(data.supplierBusinessType, data.businessType),
    address: pick(addressData.fullAddress, addressData.addressLine, data.address),
    addressData,
    ktpUrl: pick(data.ktpUrl),
    nibUrl: pick(data.nibUrl),
    npwpUrl: pick(data.npwpUrl),
    siupUrl: pick(data.siupUrl),
    selfieUrl: pick(data.selfieUrl),
    faceVerified: data.faceVerified === true,
    verificationRequestType: "supplier",
    verificationStatus: "APPROVED",
    verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
    verifiedByUid: adminUid,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
}

function buildCompanyProfileFromRequest(uid, data, adminUid) {
  const addressData = safeObj(data.companyAddressData);

  return {
    uid,
    companyName: pick(data.businessName, data.companyName),
    companyEmail: pick(data.businessEmail, data.companyEmail),
    companyPhone: pick(data.businessPhone, data.companyPhone),
    companyPicName: pick(data.companyPicName, data.businessPicName),
    businessCategory: pick(data.businessCategory, "PERUSAHAAN"),
    address: pick(addressData.fullAddress, addressData.addressLine, data.address),
    addressData,
    ktpUrl: pick(data.ktpUrl),
    nibUrl: pick(data.nibUrl),
    npwpUrl: pick(data.npwpUrl),
    siupUrl: pick(data.siupUrl),
    selfieUrl: pick(data.selfieUrl),
    faceVerified: data.faceVerified === true,
    verificationRequestType: "company",
    verificationStatus: "APPROVED",
    verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
    verifiedByUid: adminUid,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
}

module.exports = async (req, res, decoded, body) => {
  try {
    const action = String(body.action || "").trim().toLowerCase();
    const uid = String(body.uid || "").trim();
    const type = normalizeType(body.verificationType);
    const note = String(body.note || "").trim();
    const adminUid = decoded.uid;

    if (!uid) {
      return res.status(400).json({ ok: false, message: "uid wajib diisi." });
    }

    if (!["under_review", "approve", "request_revision", "reject"].includes(action)) {
      return res.status(400).json({ ok: false, message: "action verifikasi tidak valid." });
    }

    if (["request_revision", "reject"].includes(action) && !note) {
      return res.status(400).json({ ok: false, message: "Catatan wajib diisi." });
    }

    const requestRef = getRequestRef(type, uid);
    const requestSnap = await requestRef.get();

    if (!requestSnap.exists) {
      return res.status(404).json({ ok: false, message: "Request verifikasi tidak ditemukan." });
    }

    const data = requestSnap.data() || {};
    const batch = dbAdmin.batch();

    const userRef = dbAdmin.collection("users").doc(uid);
    const publicProfileRef = dbAdmin.collection("publicProfiles").doc(uid);

    const commonRequestUpdate = {
      reviewedByUid: adminUid,
      reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    if (action === "under_review") {
      batch.set(requestRef, {
        ...commonRequestUpdate,
        status: "UNDER_REVIEW"
      }, { merge: true });

      batch.set(userRef, {
        verificationType: type,
        verificationStatus: "UNDER_REVIEW",
        canCheckout: false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      batch.set(publicProfileRef, {
        verificationStatus: "UNDER_REVIEW"
      }, { merge: true });

      await batch.commit();

      return res.status(200).json({
        ok: true,
        message: "Status berhasil diubah menjadi UNDER_REVIEW."
      });
    }

    if (action === "request_revision") {
      batch.set(requestRef, {
        ...commonRequestUpdate,
        status: "REVISION_REQUIRED",
        revisionNotes: note,
        rejectionReason: ""
      }, { merge: true });

      batch.set(userRef, {
        verificationType: type,
        verificationStatus: "REVISION_REQUIRED",
        canCheckout: false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      batch.set(publicProfileRef, {
        verificationStatus: "REVISION_REQUIRED"
      }, { merge: true });

      await batch.commit();

      return res.status(200).json({
        ok: true,
        message: "Permintaan revisi berhasil dikirim."
      });
    }

    if (action === "reject") {
      batch.set(requestRef, {
        ...commonRequestUpdate,
        status: "REJECTED",
        rejectionReason: note
      }, { merge: true });

      batch.set(userRef, {
        verificationType: type,
        verificationStatus: "REJECTED",
        canCheckout: false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      batch.set(publicProfileRef, {
        verificationStatus: "REJECTED"
      }, { merge: true });

      await batch.commit();

      return res.status(200).json({
        ok: true,
        message: "Pengajuan berhasil ditolak."
      });
    }

    if (action === "approve") {
      const companyName = type === "supplier"
        ? pick(data.supplierName, data.companyName)
        : pick(data.businessName, data.companyName);

      batch.set(requestRef, {
        ...commonRequestUpdate,
        status: "APPROVED",
        revisionNotes: "",
        rejectionReason: ""
      }, { merge: true });

      if (type === "supplier") {
        batch.set(userRef, {
          role: "supplier",
          verificationType: "supplier",
          verificationStatus: "APPROVED",
          canCheckout: true,
          companyName,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        batch.set(publicProfileRef, {
          role: "supplier",
          verificationStatus: "APPROVED"
        }, { merge: true });

        batch.set(
          dbAdmin.collection("suppliers").doc(uid),
          buildSupplierProfileFromRequest(uid, data, adminUid),
          { merge: true }
        );
      } else {
        const businessCategory = pick(data.businessCategory, "PERUSAHAAN");

        batch.set(userRef, {
          role: "company",
          verificationType: "company",
          verificationStatus: "APPROVED",
          businessCategory,
          canCheckout: true,
          companyName,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        batch.set(publicProfileRef, {
          role: "company",
          verificationStatus: "APPROVED"
        }, { merge: true });

        batch.set(
          dbAdmin.collection("companies").doc(uid),
          buildCompanyProfileFromRequest(uid, data, adminUid),
          { merge: true }
        );
      }

      await batch.commit();

      return res.status(200).json({
        ok: true,
        message: "Verifikasi berhasil disetujui."
      });
    }

    return res.status(400).json({
      ok: false,
      message: "Action tidak dikenali."
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      message: e?.message || "Server error"
    });
  }
};