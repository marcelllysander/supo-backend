async function sendOtpWhatsapp(toE164, otp) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const version = process.env.WHATSAPP_API_VERSION || "v21.0";

  if (!token) throw new Error("Missing WHATSAPP_TOKEN");
  if (!phoneNumberId) throw new Error("Missing WHATSAPP_PHONE_NUMBER_ID");

  const url = `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: toE164,
    type: "text",
    text: { body: `Kode OTP SUPO kamu: ${otp}\nBerlaku 10 menit. Jangan bagikan kode ini.` },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error?.message || "Failed to send WhatsApp message");
  return data;
}

module.exports = { sendOtpWhatsapp };
