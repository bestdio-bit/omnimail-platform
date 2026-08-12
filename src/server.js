const express = require('express');
const path = require('path');
const db = require('./db');
const worker = require('./worker');

const authRouter = require('./routes/auth');
const sendRouter = require('./routes/send');
const domainsRouter = require('./routes/domains');
const deliverabilityRouter = require('./routes/deliverability');
const templatesRouter = require('./routes/templates');
const contactsRouter = require('./routes/contacts');
const campaignsRouter = require('./routes/campaigns');
const eventsRouter = require('./routes/events');
const automationsRouter = require('./routes/automations');
const orgsRouter = require('./routes/orgs');
const keysRouter = require('./routes/keys');
const billingRouter = require('./routes/billing');
const analyticsRouter = require('./routes/analytics');
const webhooksRouter = require('./routes/webhooks');
const mcpRouter = require('./routes/mcp');
const supabaseRouter = require('./routes/supabase');
const trackRouter = require('./routes/track');
const unsubscribeRouter = require('./routes/unsubscribe');
const adminRouter = require('./routes/admin');
const cors = require('cors');

const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api/auth', authRouter);
app.use('/api', sendRouter);
app.use('/api/domains', domainsRouter);
app.use('/api/deliverability', deliverabilityRouter);
app.use('/api/templates', templatesRouter);
app.use('/api/contacts', contactsRouter);
app.use('/api/campaigns', campaignsRouter);
app.use('/api/events', eventsRouter);
app.use('/api/automations', automationsRouter);
app.use('/api/orgs', orgsRouter);
app.use('/api/keys', keysRouter);
app.use('/api/billing', billingRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/mcp', mcpRouter);
app.use('/api/integrations/supabase', supabaseRouter);
app.use('/api/track', trackRouter);
app.use('/api/unsubscribe', unsubscribeRouter);
app.use('/api/admin', adminRouter);

// Health check
app.get('/api/health', async (req, res) => {
  const queueDepth = await (await (await db.prepare("SELECT COUNT(*) as count FROM emails WHERE status = 'queued'").get())).count || 0;
  res.json({
    status: 'ok',
    platform: 'OmniMail Next-Gen Enterprise Email Infrastructure',
    version: '1.0.0',
    queue_depth: queueDepth,
    gateway_status: 'Cloud Delivery Gateway Operational (Zero Vendor Brand Leakage)'
  });
});

// SEO & Sitemap Routes
app.get('/robots.txt', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.type('text/plain');
  res.send(`User-agent: *\nDisallow: /admin\nDisallow: /api/\nSitemap: ${baseUrl}/sitemap.xml`);
});

app.get('/sitemap.xml', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const routes = [
    { url: '/', priority: '1.0' },
    { url: '/pricing', priority: '0.9' },
    { url: '/features', priority: '0.9' },
    { url: '/docs', priority: '0.8' },
    { url: '/blog', priority: '0.8' },
    { url: '/contact', priority: '0.7' },
    { url: '/login', priority: '0.5' },
    { url: '/signup', priority: '0.8' }
  ];

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  
  for (const route of routes) {
    xml += '  <url>\n';
    xml += `    <loc>${baseUrl}${route.url}</loc>\n`;
    xml += `    <changefreq>weekly</changefreq>\n`;
    xml += `    <priority>${route.priority}</priority>\n`;
    xml += '  </url>\n';
  }
  
  xml += '</urlset>';
  
  res.header('Content-Type', 'application/xml');
  res.send(xml);
});

// Marketing Website Routes
app.get(['/', '/pricing', '/features', '/docs', '/blog', '/contact', '/marketing'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public/marketing.html'));
});

// Auth & Onboarding Routes
app.get(['/login', '/signup', '/verify', '/onboarding', '/auth', '/reset-password'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public/auth.html'));
});

// Dashboard SPA Routes
app.get(['/app', '/dashboard', '/overview', '/campaigns', '/automations', '/templates', '/domains', '/settings', '/keys', '/billing', '/contacts'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public/dashboard.html'));
});

// Master Admin Dashboard Route
app.get('/admin', async (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin.html'));
});

// Fallback to marketing.html for unknown SPA routes
app.get('*', async (req, res) => {
  res.sendFile(path.join(__dirname, 'public/marketing.html'));
});

// Start background worker loop automatically
if (process.env.NODE_ENV !== 'test') {
  worker.startWorker();
  app.listen(PORT, () => {
    console.log(`🚀 [OmniMail Server] Running on http://localhost:${PORT}`);
    console.log(`📊 [Dashboard SPA] Open http://localhost:${PORT} in your browser`);
  });
}

module.exports = app;
