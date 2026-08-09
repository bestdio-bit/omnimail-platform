let SESClient, SendEmailCommand;

async function getClient() {
  if (!SESClient) {
    const sdk = require('@aws-sdk/client-ses');
    SESClient = sdk.SESClient;
    SendEmailCommand = sdk.SendEmailCommand;
  }

  return new SESClient({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
}

async function send({ from, to, subject, html, text }) {
  const client = getClient();

  const Body = {};
  if (html) Body.Html = { Data: html, Charset: 'UTF-8' };
  if (text) Body.Text = { Data: text, Charset: 'UTF-8' };

  const command = new SendEmailCommand({
    Source: from,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body,
    },
  });

  const response = await client.send(command);
  return { providerMessageId: response.MessageId };
}

module.exports = { send, name: 'ses' };
