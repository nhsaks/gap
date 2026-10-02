// Helper to format time
function formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
    const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
    const s = String(totalSeconds % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
}

// Send an action to the server
async function sendAction(action, payload = null) {
    try {
        await fetch('/api/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, payload })
        });
        // Immediately fetch state to update UI faster
        fetchState();
    } catch (err) {
        console.error("Failed to send action:", err);
    }
}

// Fetch state from server and update UI
async function fetchState() {
    try {
        const res = await fetch('/api/state');
        const state = await res.json();
        
        // Update Stats
        document.getElementById('startTime').innerText = new Date(state.startTime).toLocaleTimeString();
        document.getElementById('duration').innerText = formatTime(state.duration);
        document.getElementById('trades').innerText = state.trades;
        document.getElementById('wl').innerText = `${state.wins} / ${state.losses}`;
        document.getElementById('fees').innerText = state.feesPaid.toFixed(2);
        
        const pnlEl = document.getElementById('pnl');
        pnlEl.innerText = (state.realizedPnl >= 0 ? '+' : '') + state.realizedPnl.toFixed(4);
        if (state.realizedPnl < 0) {
            pnlEl.classList.add('negative');
        } else {
            pnlEl.classList.remove('negative');
        }

        // Update Toggles
        document.getElementById('autopilotToggle').checked = state.autopilotOn;
        document.getElementById('gapFilterToggle').checked = state.gapFilterOn;
        document.getElementById('longGap').value = state.longGap;
        document.getElementById('shortGap').value = state.shortGap;

        // Update Symbols
        const symbolsList = document.getElementById('symbolsList');
        const checkedSymbols = state.checkedSymbols || [];
        
        // Only re-render symbols if the count changed (to prevent input focus loss)
        if (symbolsList.children.length !== state.symbols.length) {
            symbolsList.innerHTML = '';
            state.symbols.forEach(sym => {
                const isChecked = checkedSymbols.includes(sym);
                const div = document.createElement('div');
                div.className = `symbol-item ${isChecked ? 'checked' : ''}`;
                div.innerHTML = `
                    <input type="checkbox" ${isChecked ? 'checked' : ''} data-symbol="${sym}">
                    <span>${sym}</span>
                `;
                symbolsList.appendChild(div);
            });

            // Attach event listeners to new checkboxes
            document.querySelectorAll('.symbol-item input').forEach(cb => {
                cb.addEventListener('change', (e) => {
                    const sym = e.target.getAttribute('data-symbol');
                    sendAction('toggleSymbol', { symbol: sym, isChecked: e.target.checked });
                    e.target.parentElement.classList.toggle('checked', e.target.checked);
                });
            });
        }

        document.getElementById('symbolCount').innerText = checkedSymbols.length;
        document.getElementById('totalSymbols').innerText = state.symbols.length;

    } catch (err) {
        console.error("Failed to fetch state:", err);
    }
}

// --- EVENT LISTENERS ---

// Toggle Autopilot
document.getElementById('autopilotToggle').addEventListener('change', (e) => {
    sendAction('toggleAutopilot', e.target.checked);
});

// Toggle Gap Filter
document.getElementById('gapFilterToggle').addEventListener('change', (e) => {
    sendAction('toggleGapFilter', e.target.checked);
});

// Update Gap Inputs
document.getElementById('longGap').addEventListener('change', (e) => {
    const shortGap = document.getElementById('shortGap').value;
    sendAction('updateGaps', { longGap: e.target.value, shortGap });
});
document.getElementById('shortGap').addEventListener('change', (e) => {
    const longGap = document.getElementById('longGap').value;
    sendAction('updateGaps', { longGap, shortGap: e.target.value });
});

// Add Symbol
document.getElementById('addSymbolBtn').addEventListener('click', () => {
    const input = document.getElementById('newSymbol');
    if (input.value.trim()) {
        sendAction('addSymbol', { symbol: input.value.trim() });
        input.value = '';
    }
});

// Reset Session
document.getElementById('resetBtn').addEventListener('click', () => {
    if (confirm("Are you sure you want to reset the session?")) {
        sendAction('reset');
    }
});

// --- INITIALIZATION ---
// Poll the server every 1 second to keep UI in sync across all browsers
fetchState();
setInterval(fetchState, 1000);
