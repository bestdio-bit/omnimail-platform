const HTTP_RELAY_URL = process.env.HTTP_RELAY_URL || 'https://api.cloudrelay.internal/v1/send';

async function send({ from, to, subject, html, text }) {
  const token = process.env.HTTP_RELAY_TOKEN || process.env.RELAY_API_KEY;
  if (!token) {
    throw new Error('HTTP_RELAY_TOKEN is not set in .env');
  }

  const body = {
    From: from,
    To: to,
    Subject: subject,
    Stream: 'outbound',
  };
  if (html) body.HtmlBody = html;
  if (text) body.TextBody = text;

  const res = await fetch(HTTP_RELAY_URL, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`HTTP Relay API error ${res.status}: ${err.Message || res.statusText}`);
  }

  const data = await res.json();
  return { providerMessageId: data.MessageID || data.id };
}

module.exports = { send, name: 'http_relay' };
