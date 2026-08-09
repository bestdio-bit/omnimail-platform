const smtp = require('./smtp');
const ses = require('./ses');
const httpRelay = require('./httpRelay');
const gateway = require('./gateway');

const providers = {
  smtp,
  ses,
  http_relay: httpRelay,
  gateway: {
    name: 'gateway',
    send: async (options) => {
      const res = await gateway.sendEmail(options);
      return { providerMessageId: res.messageId };
    }
  }
};

async function getProvider() {
  const key = process.env.EMAIL_PROVIDER || 'gateway';
  const provider = providers[key] || providers.gateway;
  return provider;
}

module.exports = { getProvider, providers };
