// Format milliseconds to HH:MM:SS
function formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
    const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
    const s = String(totalSeconds % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
}

// Send action to server
async function sendAction(action, payload = null) {
    try {
        await fetch('/api/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, payload })
        });
        fetchState(); // Instantly refresh UI
    } catch (err) {
        console.error("Action failed:", err);
    }
}

// Fetch state from server and render everything
async function fetchState() {
    try {
        const res = await fetch('/api/state');
        const state = await res.json();
        
        // 1. Render Session
        document.getElementById('startTime').innerText = new Date(state.session.startTime).toLocaleTimeString();
        document.getElementById('duration').innerText = formatTime(state.session.duration);
        document.getElementById('trades').innerText = state.session.trades;
        document.getElementById('wl').innerText = `${state.session.wins} / ${state.session.losses}`;
        document.getElementById('fees').innerText = state.session.feesPaid.toFixed(2);
        
        const pnlEl = document.getElementById('pnl');
        pnlEl.innerText = (state.session.realizedPnl >= 0 ? '+' : '') + state.session.realizedPnl.toFixed(4);
        pnlEl.className = state.session.realizedPnl < 0 ? 'pnl-value negative' : 'pnl-value';

        // 2. Render Settings (Symbols)
        const symbolsList = document.getElementById('symbolsList');
        const checkedSymbols = state.settings.checkedSymbols || [];
        
        // Only redraw symbols if the list length has changed to prevent input focus loss
        if (symbolsList.children.length !== state.settings.symbols.length) {
            symbolsList.innerHTML = '';
            state.settings.symbols.forEach(sym => {
                const isChecked = checkedSymbols.includes(sym);
                const div = document.createElement('div');
                div.className = `symbol-item ${isChecked ? 'checked' : ''}`;
                div.innerHTML = `
                    <input type="checkbox" ${isChecked ? 'checked' : ''} data-symbol="${sym}">
                    <span>${sym}</span>
                `;
                symbolsList.appendChild(div);
            });

            document.querySelectorAll('.symbol-item input').forEach(cb => {
                cb.addEventListener('change', (e) => {
                    const sym = e.target.getAttribute('data-symbol');
                    sendAction('toggleSymbol', { symbol: sym, isChecked: e.target.checked });
                    e.target.parentElement.classList.toggle('checked', e.target.checked);
                });
            });
        }
        document.getElementById('symbolCount').innerText = checkedSymbols.length;
        document.getElementById('totalSymbols').innerText = state.settings.symbols.length;

        // 3. Render Trade Setup
        document.getElementById('autopilotToggle').checked = state.tradeSetup.autopilotOn;
        document.getElementById('gapFilterToggle').checked = state.tradeSetup.gapFilterOn;
        document.getElementById('longGap').value = state.tradeSetup.longGap;
        document.getElementById('shortGap').value = state.tradeSetup.shortGap;

        // 4. Render Positions Table
        const posBody = document.getElementById('positionsTableBody');
        if (state.positions.length === 0) {
            posBody.innerHTML = `<tr><td colspan="6" class="no-data">No active positions</td></tr>`;
        } else {
            posBody.innerHTML = state.positions.map(pos => {
                const pnlClass = pos.pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
                const pnlSign = pos.pnl >= 0 ? '+' : '';
                return `
                    <tr>
                        <td>${new Date(pos.time).toLocaleTimeString()}</td>
                        <td>${pos.symbol}</td>
                        <td>${pos.side}</td>
                        <td>${pos.entry.toFixed(4)}</td>
                        <td>${pos.current.toFixed(4)}</td>
                        <td class="${pnlClass}">${pnlSign}${pos.pnl.toFixed(4)}</td>
                    </tr>
                `;
            }).join('');
        }

        // 5. Render Logs
        const logsContainer = document.getElementById('logsContainer');
        if (state.logs.length === 0) {
            logsContainer.innerHTML = `<div class="no-data">No logs yet</div>`;
        } else {
            logsContainer.innerHTML = state.logs.map(log => `<div>${log}</div>`).join('');
        }

    } catch (err) {
        console.error("Failed to fetch state:", err);
    }
}

// --- EVENT LISTENERS ---

document.getElementById('autopilotToggle').addEventListener('change', (e) => {
    sendAction('toggleAutopilot', e.target.checked);
});

document.getElementById('gapFilterToggle').addEventListener('change', (e) => {
    sendAction('toggleGapFilter', e.target.checked);
});

document.getElementById('longGap').addEventListener('change', (e) => {
    const shortGap = document.getElementById('shortGap').value;
    sendAction('updateGaps', { longGap: e.target.value, shortGap });
});

document.getElementById('shortGap').addEventListener('change', (e) => {
    const longGap = document.getElementById('longGap').value;
    sendAction('updateGaps', { longGap, shortGap: e.target.value });
});

document.getElementById('addSymbolBtn').addEventListener('click', () => {
    const input = document.getElementById('newSymbol');
    if (input.value.trim()) {
        sendAction('addSymbol', { symbol: input.value.trim() });
        input.value = '';
    }
});

document.getElementById('resetBtn').addEventListener('click', () => {
    if (confirm("Are you sure you want to reset the session? This will clear all PnL, positions, and logs.")) {
        sendAction('reset');
    }
});

// --- INITIALIZATION ---
// Poll the server every 1 second to keep UI perfectly synced across all browsers
fetchState();
setInterval(fetchState, 1000);
