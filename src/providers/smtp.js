const nodemailer = require('nodemailer');

let transporter = null;

async function getTransporter() {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  return transporter;
}

async function send({ from, to, subject, html, text, dkim }) {
  const t = getTransporter();
  const mailOptions = { from, to, subject, html, text };
  if (dkim) mailOptions.dkim = dkim;
  const info = await t.sendMail(mailOptions);
  return { providerMessageId: info.messageId };
}

module.exports = { send, name: 'smtp' };
