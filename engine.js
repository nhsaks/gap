const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'state.json');

// Default State
let state = {
    session: {
        startTime: Date.now(),
        trades: 0,
        wins: 0,
        losses: 0,
        feesPaid: 0,
        realizedPnl: 0,
    },
    settings: {
        symbols: ["AVAX", "SUI", "DOT", "ATOM", "ICP", "NEAR", "APT", "INJ", "QNT", "ZEC", "LINK", "GTC", "MOVR"],
        checkedSymbols: ["QNT", "ZEC", "LINK", "GTC", "MOVR"]
    },
    tradeSetup: {
        autopilotOn: false,
        gapFilterOn: true,
        longGap: 10,
        shortGap: 10,
        maxOpen: 5,
        exitDollar: 10,
        slDollar: 50,
        usdtAmt: 100
    },
    positions: [],
    logs: []
};

// Load state from file if it exists
function loadState() {
    if (fs.existsSync(STATE_FILE)) {
        try {
            const saved = JSON.parse(fs.readFileSync(STATE_FILE));
            // Merge saved state with default structure to prevent missing keys
            state = {
                session: { ...state.session, ...saved.session },
                settings: { ...state.settings, ...saved.settings },
                tradeSetup: { ...state.tradeSetup, ...saved.tradeSetup },
                positions: saved.positions || [],
                logs: saved.logs || []
            };
            // Reset start time if autopilot was left on
            if (state.tradeSetup.autopilotOn) {
                state.session.startTime = Date.now();
            }
        } catch (e) {
            console.error("Error loading state:", e);
        }
    }
}

// Save state to file
function saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Add a log message
function addLog(message) {
    const time = new Date().toLocaleTimeString();
    state.logs.unshift(`[${time}] ${message}`);
    if (state.logs.length > 50) state.logs.pop(); // Keep last 50 logs
}

// The core simulation loop (runs every 3 seconds)
function tick() {
    if (!state.tradeSetup.autopilotOn) return;

    // 1. Update existing positions
    state.positions.forEach(pos => {
        // Simulate price movement
        const priceMove = (Math.random() * 2) - 1;
        pos.current = pos.entry + priceMove;
        pos.pnl = (pos.current - pos.entry) * pos.qty;
        
        // Check Exit conditions
        if (Math.abs(pos.pnl) >= state.tradeSetup.exitDollar || Math.abs(pos.pnl) <= -state.tradeSetup.slDollar) {
            // Close position
            state.session.trades++;
            state.session.realizedPnl += pos.pnl;
            state.session.feesPaid += 0.05;
            
            if (pos.pnl >= 0) state.session.wins++;
            else state.session.losses++;
            
            addLog(`Closed ${pos.symbol} ${pos.side} at ${pos.current.toFixed(4)} | PnL: ${pos.pnl.toFixed(4)}`);
            pos.closed = true;
        }
    });

    // Remove closed positions
    state.positions = state.positions.filter(p => !p.closed);

    // 2. Open new positions if under Max Open
    if (state.positions.length < state.tradeSetup.maxOpen) {
        const availableSymbols = state.settings.checkedSymbols;
        if (availableSymbols.length > 0 && Math.random() > 0.7) { // 30% chance to open a trade
            const symbol = availableSymbols[Math.floor(Math.random() * availableSymbols.length)];
            const side = Math.random() > 0.5 ? 'LONG' : 'SHORT';
            const entry = 100 + (Math.random() * 50);
            
            state.positions.push({
                id: Date.now(),
                symbol,
                side,
                entry,
                current: entry,
                qty: 1,
                pnl: 0,
                time: Date.now()
            });
            addLog(`Opened ${symbol} ${side} at ${entry.toFixed(4)}`);
        }
    }

    saveState();
}

// Initialize
loadState();
setInterval(tick, 3000); // Run every 3 seconds

module.exports = {
    getState: () => {
        const duration = Date.now() - state.session.startTime;
        return { ...state, session: { ...state.session, duration } };
    },
    
    toggleAutopilot: (val) => {
        state.tradeSetup.autopilotOn = val;
        if (val) {
            state.session.startTime = Date.now();
            addLog("Autopilot STARTED");
        } else {
            addLog("Autopilot STOPPED");
        }
        saveState();
    },
    
    toggleGapFilter: (val) => {
        state.tradeSetup.gapFilterOn = val;
        saveState();
    },
    
    updateGaps: (longGap, shortGap) => {
        state.tradeSetup.longGap = parseInt(longGap);
        state.tradeSetup.shortGap = parseInt(shortGap);
        saveState();
    },
    
    toggleSymbol: (symbol, isChecked) => {
        if (isChecked) {
            if (!state.settings.checkedSymbols.includes(symbol)) {
                state.settings.checkedSymbols.push(symbol);
            }
        } else {
            state.settings.checkedSymbols = state.settings.checkedSymbols.filter(s => s !== symbol);
        }
        saveState();
    },
    
    addSymbol: (symbol) => {
        const sym = symbol.toUpperCase();
        if (!state.settings.symbols.includes(sym)) {
            state.settings.symbols.push(sym);
            state.settings.checkedSymbols.push(sym);
            addLog(`Added new symbol: ${sym}`);
        }
        saveState();
    },
    
    reset: () => {
        state.session = {
            startTime: Date.now(),
            trades: 0,
            wins: 0,
            losses: 0,
            feesPaid: 0,
            realizedPnl: 0,
        };
        state.positions = [];
        state.logs = [];
        addLog("Session Reset");
        saveState();
    }
};
