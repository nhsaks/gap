const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'state.json');

// Default State
let state = {
    autopilotOn: false,
    gapFilterOn: true,
    longGap: 10,
    shortGap: 10,
    symbols: ["QNT", "ZEC", "LINK", "GTC", "MOVR"],
    checkedSymbols: ["QNT", "ZEC", "LINK", "GTC", "MOVR"],
    trades: 0,
    wins: 0,
    losses: 0,
    feesPaid: 0,
    realizedPnl: 0,
    startTime: Date.now(),
    maxOpen: 5,
    exitDollar: 10,
    slDollar: 50,
    usdtAmt: 100
};

// Load state from file if it exists
function loadState() {
    if (fs.existsSync(STATE_FILE)) {
        try {
            const saved = JSON.parse(fs.readFileSync(STATE_FILE));
            state = { ...state, ...saved };
            // Reset start time if autopilot was left on
            if (state.autopilotOn) {
                state.startTime = Date.now();
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

// The core simulation loop (runs every 3 seconds)
function tick() {
    if (!state.autopilotOn) return;

    // Simulate a trade based on the settings
    state.trades++;
    
    // Simulate PNL (random for demo purposes)
    const pnl = (Math.random() * 4) - 1; // Range: -1 to +3
    
    if (pnl >= 0) {
        state.wins++;
    } else {
        state.losses++;
    }
    
    state.realizedPnl += pnl;
    state.feesPaid += 0.05; // Simulate fees
    
    saveState();
}

// Initialize
loadState();
setInterval(tick, 3000); // Run every 3 seconds

module.exports = {
    getState: () => ({ ...state, duration: Date.now() - state.startTime }),
    
    toggleAutopilot: (val) => {
        state.autopilotOn = val;
        if (val) state.startTime = Date.now();
        saveState();
    },
    
    toggleGapFilter: (val) => {
        state.gapFilterOn = val;
        saveState();
    },
    
    updateGaps: (longGap, shortGap) => {
        state.longGap = parseInt(longGap);
        state.shortGap = parseInt(shortGap);
        saveState();
    },
    
    toggleSymbol: (symbol, isChecked) => {
        if (isChecked) {
            if (!state.checkedSymbols.includes(symbol)) {
                state.checkedSymbols.push(symbol);
            }
        } else {
            state.checkedSymbols = state.checkedSymbols.filter(s => s !== symbol);
        }
        saveState();
    },
    
    addSymbol: (symbol) => {
        const sym = symbol.toUpperCase();
        if (!state.symbols.includes(sym)) {
            state.symbols.push(sym);
        }
        saveState();
    },
    
    reset: () => {
        state.trades = 0;
        state.wins = 0;
        state.losses = 0;
        state.feesPaid = 0;
        state.realizedPnl = 0;
        state.startTime = Date.now();
        saveState();
    }
};
