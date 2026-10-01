const express = require('express');
const cors = require('cors');
const path = require('path');
const compression = require('compression');
const helmet = require('helmet');
const morgan = require('morgan');

const app = express();
const PORT = process.env.PORT || 3000;
const START_TIME = Date.now();

// Middleware
app.use(compression());
app.use(helmet({
  contentSecurityPolicy: false, // allow binance ws and inline scripts from your HTML
  crossOriginEmbedderPolicy: false
}));
app.use(cors());
app.use(morgan('tiny'));
app.use(express.json());

// No-cache for dynamic routes
app.use((req, res, next) => {
  if (req.path.startsWith('/health') || req.path.startsWith('/ping') || req.path.startsWith('/api')) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  }
  next();
});

// --- 24/7 KEEP ALIVE ROUTES FOR UPTIMEROBOT ---
// UptimeRobot should ping /ping every 5 minutes
app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

app.get('/health', (req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - START_TIME) / 1000);
  const uptimeHuman = `${Math.floor(uptimeSeconds/3600)}h ${Math.floor((uptimeSeconds%3600)/60)}m ${uptimeSeconds%60}s`;
  res.json({
    status: 'online',
    uptime_seconds: uptimeSeconds,
    uptime_human: uptimeHuman,
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage(),
    service: 'delta-neutral-simulator',
    message: 'Server is running 24/7 on Render.com'
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    online: true,
    serverTime: new Date().toISOString(),
    binanceSpotWs: 'wss://stream.binance.com:9443/ws',
    binanceFutWs: 'wss://fstream.binance.com/ws',
    tip: 'Frontend connects directly to Binance from browser'
  });
});

// Serve static files - support both /public and root
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use(express.static(__dirname, { 
  maxAge: '1h',
  index: false // we handle index manually
}));

// Root route
app.get('/', (req, res) => {
  // try public/index.html first, then root index.html
  const publicIndex = path.join(__dirname, 'public', 'index.html');
  const rootIndex = path.join(__dirname, 'index.html');
  const fs = require('fs');
  if (fs.existsSync(publicIndex)) {
    res.sendFile(publicIndex);
  } else if (fs.existsSync(rootIndex)) {
    res.sendFile(rootIndex);
  } else {
    res.status(404).send('index.html not found');
  }
});

// Catch all - SPA fallback
app.get('*', (req, res) => {
  const publicIndex = path.join(__dirname, 'public', 'index.html');
  const rootIndex = path.join(__dirname, 'index.html');
  const fs = require('fs');
  if (fs.existsSync(publicIndex)) {
    res.sendFile(publicIndex);
  } else if (fs.existsSync(rootIndex)) {
    res.sendFile(rootIndex);
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Delta Neutral Server running on port ${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/health`);
  console.log(`🏓 Ping: http://localhost:${PORT}/ping`);
  console.log(`🌐 App: http://localhost:${PORT}/`);
  console.log(`⏰ Started: ${new Date().toISOString()}\n`);
});

// Keep alive log every 5 minutes - helps see Render logs
setInterval(() => {
  const up = Math.floor((Date.now() - START_TIME)/1000);
  console.log(`[keep-alive] uptime ${up}s - ${new Date().toISOString()} - memory ${Math.round(process.memoryUsage().heapUsed/1024/1024)}MB`);
}, 5 * 60 * 1000);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
                       
