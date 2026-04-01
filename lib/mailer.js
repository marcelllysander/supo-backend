// lib/mailer.js
const nodemailer = require("nodemailer");

function getTransport() {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!user) throw new Error("Missing SMTP_USER");
  if (!pass) throw new Error("Missing SMTP_PASS");

  return nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });
}

async function sendOtpEmail(toEmail, otp, options = {}) {
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  if (!from) throw new Error("Missing MAIL_FROM");

  const transporter = getTransport();

  const subject = options.subject || "Kode OTP SUPO";
  const heading = options.heading || "Verifikasi SUPO";
  const intro = options.intro || "Kode OTP kamu:";
  const validityText = options.validityText || "Kode berlaku 10 menit. Jangan bagikan kode ini ke siapa pun.";

  const info = await transporter.sendMail({
    from,
    to: toEmail,
    subject,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5">
        <h2>${heading}</h2>
        <p>${intro}</p>
        <div style="font-size:28px;font-weight:bold;letter-spacing:4px">${otp}</div>
        <p>${validityText}</p>
      </div>
    `,
  });

  return info;
}

module.exports = { sendOtpEmail };