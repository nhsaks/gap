const express = require('express');
const cors = require('cors');
const path = require('path');
const engine = require('./engine');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- API ROUTES ---

// Get current state
app.get('/api/state', (req, res) => {
    res.json(engine.getState());
});

// Handle actions from the frontend
app.post('/api/action', (req, res) => {
    const { action, payload } = req.body;
    
    try {
        switch(action) {
            case 'toggleAutopilot': engine.toggleAutopilot(payload); break;
            case 'toggleGapFilter': engine.toggleGapFilter(payload); break;
            case 'updateGaps': engine.updateGaps(payload.longGap, payload.shortGap); break;
            case 'toggleSymbol': engine.toggleSymbol(payload.symbol, payload.isChecked); break;
            case 'addSymbol': engine.addSymbol(payload.symbol); break;
            case 'reset': engine.reset(); break;
            default: return res.status(400).json({ error: "Unknown action" });
        }
        res.json({ success: true, state: engine.getState() });
    } catch (error) {
        console.error("Action error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// --- KEEP ALIVE PING (Prevents Render sleep) ---
setInterval(() => {
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    fetch(`${url}/api/state`)
        .then(() => console.log('Keep-alive ping successful'))
        .catch(err => console.error('Keep-alive ping failed:', err.message));
}, 14 * 60 * 1000); // 14 minutes

// --- START SERVER ---
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
