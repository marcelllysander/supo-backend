// lib/whatsapp.js
async function sendOtpWhatsapp(toE164, otp) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const version = process.env.WHATSAPP_API_VERSION || "v21.0";

  const templateName = process.env.WHATSAPP_TEMPLATE_NAME;
  const templateLang = process.env.WHATSAPP_TEMPLATE_LANG || "id";

  if (!token) throw new Error("Missing WHATSAPP_TOKEN");
  if (!phoneNumberId) throw new Error("Missing WHATSAPP_PHONE_NUMBER_ID");
  if (!templateName) throw new Error("Missing WHATSAPP_TEMPLATE_NAME");

  const url = `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;

  // Template harus disesuaikan dengan template approved di WhatsApp Manager.
  // Contoh template body: "Kode OTP SUPO kamu: {{1}}. Berlaku 10 menit."
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toE164,
    type: "template",
    template: {
      name: templateName,
      language: { code: templateLang },
      components: [
        {
          type: "body",
          parameters: [{ type: "text", text: otp }],
        },
      ],
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    throw new Error(data?.error?.message || "Failed to send WhatsApp OTP");
  }

  return data;
}

async function sendOtpSms(toE164, otp) {
  // Sengaja belum diaktifkan agar Anda fokus mengecek alur keseluruhan lebih dulu.
  // Nanti kalau register sudah stabil, baru kita sambungkan ke provider SMS.
  throw new Error("SMS belum dikonfigurasi. Gunakan WhatsApp terlebih dahulu.");
}

module.exports = { sendOtpWhatsapp, sendOtpSms };