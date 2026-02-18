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

async function sendOtpEmail(toEmail, otp) {
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  if (!from) throw new Error("Missing MAIL_FROM");

  const transporter = getTransport();

  const info = await transporter.sendMail({
    from,
    to: toEmail,
    subject: "Kode OTP Reset Password SUPO",
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5">
        <h2>Reset Password SUPO</h2>
        <p>Kode OTP kamu:</p>
        <div style="font-size:28px;font-weight:bold;letter-spacing:4px">${otp}</div>
        <p>Kode berlaku 10 menit. Jangan bagikan kode ini ke siapa pun.</p>
      </div>
    `,
  });

  return info;
}

module.exports = { sendOtpEmail };
