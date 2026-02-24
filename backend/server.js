require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Routes
app.use('/api/ingest', require('./routes/ingest'));
app.use('/api/enrich', require('./routes/enrich'));
app.use('/api/reply', require('./routes/replies'));
app.use('/api/scraper', require('./routes/scraper'));
app.use('/api/scrapers', require('./routes/scrapers'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// Dashboard data endpoint (for frontend)
app.get('/api/dashboard', async (req, res) => {
  try {
    const { getLeadStats } = require('./services/db');
    const stats = await getLeadStats();
    res.json({ success: true, stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Leads list endpoint (for frontend)
app.get('/api/leads', async (req, res) => {
  try {
    const { getLeadsPage } = require('./services/db');
    const { status, tier, limit } = req.query;
    const leads = await getLeadsPage({
      status: status || undefined,
      tier: tier || undefined,
      limit: parseInt(limit) || 50,
    });
    res.json({ success: true, leads });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Replies list endpoint (for frontend)
app.get('/api/replies', async (req, res) => {
  try {
    const { getRepliesPage } = require('./services/db');
    const { classification, limit } = req.query;
    const replies = await getRepliesPage({
      classification: classification || undefined,
      limit: parseInt(limit) || 50,
    });
    res.json({ success: true, replies });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual trigger endpoints
app.post('/api/trigger/cleanup', async (req, res) => {
  try {
    const { runCleanup } = require('./cron/cleanup');
    await runCleanup();
    res.json({ success: true, message: 'Cleanup complete' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trigger/dashboard', async (req, res) => {
  try {
    const { runDashboard } = require('./cron/dashboard');
    const report = await runDashboard();
    res.json({ success: true, report });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cron Jobs
// Weekly cleanup: Sunday 11pm EST
cron.schedule('0 23 * * 0', async () => {
  console.log('[cron] Running weekly cleanup...');
  const { runCleanup } = require('./cron/cleanup');
  await runCleanup();
}, { timezone: 'America/New_York' });

// Weekly dashboard: Monday 8am EST
cron.schedule('0 8 * * 1', async () => {
  console.log('[cron] Running weekly dashboard...');
  const { runDashboard } = require('./cron/dashboard');
  await runDashboard();
}, { timezone: 'America/New_York' });

// Start
app.listen(PORT, () => {
  console.log(`\n🚀 Story Group GTM Engine running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health`);
  console.log(`   Ingest: POST http://localhost:${PORT}/api/ingest`);
  console.log(`   Enrich: POST http://localhost:${PORT}/api/enrich`);
  console.log(`   Reply:  POST http://localhost:${PORT}/api/reply`);
  console.log(`   Scraper: POST http://localhost:${PORT}/api/scraper`);
  console.log(`   Scrapers: http://localhost:${PORT}/api/scrapers`);
  console.log(`\n   Cron: Cleanup Sun 11pm EST, Dashboard Mon 8am EST\n`);
});
