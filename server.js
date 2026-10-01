const express = require('express');
const path = require('path');
const engine = require('./engine');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health check for UptimeRobot
app.get('/health', (req, res) => res.status(200).send('OK'));

// Frontend polls this every few seconds
app.get('/api/state', (req, res) => res.json(engine.snapshot()));

// Control endpoints
app.post('/api/toggle-autopilot', (req, res) => {
  engine.state.autopilot = !!req.body.on;
  res.json({ autopilot: engine.state.autopilot });
});

app.post('/api/config', (req, res) => {
  Object.assign(engine.state, req.body);
  res.json({ ok: true });
});

app.post('/api/reset', (req, res) => {
  engine.state.positions = [];
  engine.state.realizedPnl = 0;
  engine.state.realizedFees = 0;
  engine.state.tradeCount = 0;
  engine.state.wins = 0;
  engine.state.losses = 0;
  engine.state.sessionStart = Date.now();
  res.json({ ok: true });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await engine.loadTickSizes();
  engine.startFeeds();
  setInterval(engine.autopilotTick, 1000);   // ← runs 24/7
  console.log('Engine started — autopilot ticking every 1s');
});
