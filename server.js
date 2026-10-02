const express = require('express');
const cors = require('cors');
const path = require('path');
const engine = require('./engine');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', (req, res) => res.json(engine.getState()));

app.post('/api/action', async (req, res) => {
  const { action, payload } = req.body || {};
  try {
    switch (action) {
      case 'toggleAutopilot':  engine.toggleAutopilot(payload); break;
      case 'updateTradeSetup': engine.updateTradeSetup(payload || {}); break;
      case 'toggleSymbol':     engine.toggleSymbol(payload.symbol, payload.isChecked); break;
      case 'addSymbol':        engine.addSymbol(payload.symbol); break;
      case 'removeSymbol':     engine.removeSymbol(payload.symbol); break;
      case 'resetSession':     engine.resetSession(); break;
      case 'exitAll':          engine.exitAll(); break;
      case 'closePosition':    engine.closePosition(payload.id); break;
      case 'fetchPrices':      await engine.fetchPrices(); break;
      default: return res.status(400).json({ error: 'Unknown action' });
    }
    res.json({ success: true });
  } catch (e) {
    console.error("Action error:", e);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
  engine.boot();
});
