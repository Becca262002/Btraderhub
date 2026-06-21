// ========================================================
// 🔐 GLOBAL APPLICATION CONFIGURATION & RUNTIME STATES
// ========================================================

let derivWS = null; // Global WebSocket instance
let isReconnecting = false; // FIX: Prevent connection storms in the reconnect loop

// FIX: Single, clean definition of connectToDeriv (was defined 3 times with conflicting logic)
function connectToDeriv() {
    if (typeof DERIV_APP_ID === 'undefined') {
        console.warn("Config not loaded yet, waiting...");
        setTimeout(connectToDeriv, 1000);
        return;
    }

    // FIX: Assign to global derivWS, then attach listeners to it (not to a local 'socket' variable)
    derivWS = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${DERIV_APP_ID}`);

    derivWS.onopen = () => {
        console.log("✅ Connected to Deriv");
        isReconnecting = false;
        const status = document.querySelector(".status");
        if (status) status.innerText = "ONLINE";
        updateConnectionStatus(true);
    };

    derivWS.onerror = (err) => console.error("WS Error:", err);

    derivWS.onclose = () => {
        console.log("Connection lost.");
        const status = document.querySelector('.status');
        if (status) status.innerText = "OFFLINE";
        updateConnectionStatus(false);
    };

    // FIX: onmessage must be set here, on the instance, not as a bare global statement
    derivWS.onmessage = (msg) => {
        const data = JSON.parse(msg.data);

        // Route to the WebSocket session handler if it's been initialized
        if (typeof handleIncomingMarketData === 'function') {
            handleIncomingMarketData(data);
        }

        // Contract status updates
        if (data.msg_type === 'proposal_open_contract') {
            const contract = data.proposal_open_contract;
            if (contract && contract.is_sold) {
                updateDashboardStats(contract.profit, contract.status);
                logJournalMessage(`Trade finished: ${contract.status.toUpperCase()} | Profit: ${contract.profit}`);
            }
        }
    };
}

// Wait for the whole page to load before starting the connection
window.addEventListener('load', connectToDeriv);

// --------------------------------------------------------
// OAuth + Signup
// --------------------------------------------------------
function loginWithDeriv() {
    // Use origin only (e.g. https://btraderhub.vercel.app) — must match exactly what you registered on api.deriv.com
    const redirectUrl = window.location.origin + "/";
    const oauthUrl = `https://oauth.deriv.com/oauth2/authorize?app_id=${DERIV_APP_ID}&l=en&brand=deriv&redirect_uri=${encodeURIComponent(redirectUrl)}`;
    window.location.href = oauthUrl;
}

function signUpWithDeriv() {
    window.location.href = "https://deriv.com/signup/";
}

// --------------------------------------------------------
// Asset Dropdown
// --------------------------------------------------------
const marketAssets = {
    "Continuous Indices": ["Volatility 10", "Volatility 25", "Volatility 50", "Volatility 75", "Volatility 100"],
    "1S Indices": ["Volatility 10 (1s)", "Volatility 25 (1s)", "Volatility 50 (1s)", "Volatility 75 (1s)", "Volatility 100 (1s)"],
    "Jump Indices": ["Jump 10 Index", "Jump 25 Index", "Jump 50 Index", "Jump 75 Index", "Jump 100 Index"]
};

function populateAssetDropdown() {
    const select = document.getElementById('market-asset-select');
    if (!select) return;

    Object.keys(marketAssets).forEach(category => {
        const group = document.createElement('optgroup');
        group.label = category;

        marketAssets[category].forEach(asset => {
            const option = document.createElement('option');
            option.value = asset;
            option.text = asset;
            group.appendChild(option);
        });

        select.appendChild(group);
    });
}

document.addEventListener('DOMContentLoaded', () => {
    populateAssetDropdown();
    initializeTradingViewChart("OANDA:XAUUSD");
});

// --------------------------------------------------------
// 2. OAuth Token URL Intercept
// --------------------------------------------------------
window.addEventListener('load', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token1');
    if (token) {
        window.history.replaceState({}, document.title, window.location.pathname);
        initializeWebSocketSession(token);
    }
});

// --------------------------------------------------------
// 3. WebSocket Session (Authorize + Subscribe)
// --------------------------------------------------------
function initializeWebSocketSession(token) {
    const statusDiv = document.getElementById('connection-status');
    if (statusDiv) {
        statusDiv.className = "text-xs p-3 rounded-lg border border-blue-500/30 bg-blue-50 text-blue-600 font-medium";
        statusDiv.innerText = "Initializing security handshake via token pass...";
        statusDiv.classList.remove('hidden');
    }

    // FIX: Use the global derivWS; reconnect if it's not open yet
    if (!derivWS || derivWS.readyState !== WebSocket.OPEN) {
        connectToDeriv();
        // Wait for the connection to open, then authorize
        const waitForOpen = setInterval(() => {
            if (derivWS && derivWS.readyState === WebSocket.OPEN) {
                clearInterval(waitForOpen);
                authorizeSession(token, statusDiv);
            }
        }, 200);
    } else {
        authorizeSession(token, statusDiv);
    }
}

function authorizeSession(token, statusDiv) {
    derivWS.send(JSON.stringify({ authorize: token }));

    // Extend the global onmessage to handle authorization flow
    const originalOnMessage = derivWS.onmessage;
    derivWS.onmessage = function (msg) {
        const response = JSON.parse(msg.data);
        console.log("Incoming Message:", response.msg_type);

        // Call original handler too
        if (originalOnMessage) originalOnMessage.call(this, msg);

        handleIncomingMarketData(response);

        if (response.msg_type === 'authorize') {
            if (response.error) {
                if (statusDiv) {
                    statusDiv.className = "text-xs p-3 rounded-lg border border-red-500/30 bg-red-50 text-red-600";
                    statusDiv.innerText = `Auth Error: ${response.error.message}`;
                }
            } else {
                if (statusDiv) {
                    statusDiv.className = "text-xs p-3 rounded-lg border border-emerald-500/30 bg-emerald-50 text-brandGreen font-bold";
                    statusDiv.innerText = `Connected securely as: ${response.authorize.email}`;
                }

                const balanceDisplay = document.getElementById('balance-display');
                const loginBtn = document.getElementById('login-nav-btn');
                const signupBtn = document.getElementById('signup-nav-btn');
                const accountBalance = document.getElementById('account-balance');

                if (balanceDisplay) balanceDisplay.classList.remove('hidden');
                if (loginBtn) loginBtn.classList.add('hidden');
                if (signupBtn) signupBtn.classList.add('hidden');

                if (accountBalance) {
                    const balance = parseFloat(response.authorize.balance).toFixed(2);
                    const currency = response.authorize.currency;
                    accountBalance.innerText = `${balance} ${currency}`;
                }

                // Subscribe to tick stream after authorization
                derivWS.send(JSON.stringify({ ticks: "R_10", subscribe: 1 }));
            }
        }

        if (response.msg_type === 'tick') {
            const tickPrice = response.tick.quote;
            if (typeof updateDigitStats === 'function') {
                updateDigitStats(tickPrice);
            }
        }
    };
}

// --------------------------------------------------------
// 4. Tab Navigation
// --------------------------------------------------------
function switchTab(tabId) {
    document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.add('hidden'));
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.className = "tab-btn px-4 py-1.5 rounded text-sm font-medium transition text-gray-600 hover:text-slate-900 hover:bg-gray-100";
    });

    const activePane = document.getElementById(`${tabId}-pane`);
    if (activePane) activePane.classList.remove('hidden');

    const activeBtn = document.getElementById(`tab-btn-${tabId}`);
    if (activeBtn) {
        activeBtn.className = "tab-btn px-4 py-1.5 rounded text-sm font-medium transition text-white bg-blue-600 shadow-sm";
    }

    if (tabId === 'bot-builder') {
        setTimeout(() => {
            // Bot builder uses Deriv iframe — just sync the symbol
            const marketSelector = document.getElementById('bot-market');
            if (marketSelector) updateLiveChartAsset();
        }, 50);
    }

    if (tabId === 'charts') {
        setTimeout(() => {
            initializeStandaloneFullScreenChart("OANDA:XAUUSD");
        }, 50);
    }
}

function toggleAccumulatorFields() {
    const tradeType = document.getElementById('bot-trade-type').value;
    const accuPanel = document.getElementById('accumulator-config-panel');
    if (accuPanel) {
        accuPanel.classList.toggle('hidden', tradeType !== 'accumulator');
    }
}


// ========================================================
// 🤖 AUTOMATED SYSTEM ALGORITHMS & MARTINGALE ENGINES
// ========================================================
let isBotRunning = false;
let currentStake = 0;
let totalProfitLoss = 0;
let totalRuns = 0;
let totalWins = 0;
let currentStreak = 0;
let peakExposure = 0;
let lastContractId = null;

const winAudio = new Audio('https://actions.google.com/sounds/v1/cartoon/slide_whistle_up.ogg');
const lossAudio = new Audio('https://actions.google.com/sounds/v1/cartoon/boing_long.ogg');

function toggleBotExecution() {
    if (!derivWS || derivWS.readyState !== WebSocket.OPEN) {
        alert("Please authorize your Deriv account first!");
        return;
    }

    const runBtn = document.getElementById('run-bot-btn');

    if (!isBotRunning) {
        isBotRunning = true;
        runBtn.innerText = "🛑 STOP BOT";
        runBtn.className = "w-full bg-red-600 hover:bg-red-700 text-white font-bold py-2 rounded text-xs tracking-wider transition shadow-sm";

        currentStake = parseFloat(document.getElementById('bot-stake').value);
        logJournalMessage("Bot initiated. Subscribing to live market stream...");

        const selectedMarket = document.getElementById('bot-market').value;
        derivWS.send(JSON.stringify({ ticks: selectedMarket, subscribe: 1 }));

    } else {
        isBotRunning = false;
        runBtn.innerText = "▶ RUN BOT";
        runBtn.className = "w-full bg-brandGreen hover:bg-brandGreenHover text-white font-bold py-2 rounded text-xs tracking-wider transition shadow-sm";
        logJournalMessage("Bot execution stopped safely by user.");
    }
}

function handleBotUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const botConfig = JSON.parse(e.target.result);
            logJournalMessage("Successfully loaded strategy: " + file.name);
        } catch (err) {
            logJournalMessage("Error parsing bot file: " + err.message);
        }
    };
    reader.readAsText(file);
}

function handleIncomingMarketData(response) {
    if (!isBotRunning) return;

    if (response.msg_type === 'tick' && response.tick) {
        const currentTickPrice = response.tick.quote.toString();
        const lastDigit = parseInt(currentTickPrice.slice(-1));

        const predictionTarget = parseInt(document.getElementById('bot-prediction').value);
        const tradeType = document.getElementById('bot-trade-type').value;

        if (tradeType === 'over_under') {
            if (lastDigit > predictionTarget) {
                executeContractPurchase(predictionTarget);
            }
        } else if (tradeType === 'even_odd') {
            executeContractPurchase(lastDigit);
        } else if (tradeType === 'rise_fall' || tradeType === 'rise_fall_equal') {
            executeContractPurchase(lastDigit);
        } else if (tradeType === 'only_ups_downs' || tradeType === 'high_low_ticks') {
            executeContractPurchase(lastDigit);
        } else if (tradeType === 'accumulator') {
            executeContractPurchase(lastDigit);
        }
    }

    if (response.msg_type === 'buy') {
        if (response.error) {
            logJournalMessage(`Execution Rejected: ${response.error.message}`);
            lastContractId = null; // FIX: Reset so bot can retry
        } else {
            lastContractId = response.buy.contract_id;
            logJournalMessage(`Contract purchased! ID: ${lastContractId}. Watching outcome...`);
            totalRuns++;
            updateStatsDashboard();
        }
    }

    if (response.msg_type === 'proposal_open_contract' && response.proposal_open_contract) {
        const contract = response.proposal_open_contract;

        if (contract.is_expired && contract.contract_id === lastContractId) {
            const profit = parseFloat(contract.profit);
            lastContractId = null;

            if (profit > 0) {
                try { winAudio.play(); } catch (e) {}
                totalWins++;
                currentStreak = currentStreak < 0 ? 1 : currentStreak + 1;
                totalProfitLoss += profit;
                logJournalMessage(`🎯 WINNER! Profit: +$${profit.toFixed(2)}`);
                addTransactionRowToPanel('WIN', currentStake, profit);
                currentStake = parseFloat(document.getElementById('bot-stake').value);
            } else {
                try { lossAudio.play(); } catch (e) {}
                currentStreak = currentStreak > 0 ? -1 : currentStreak - 1;
                totalProfitLoss += profit;
                logJournalMessage(`💥 LOSS. Deficit: $${profit.toFixed(2)}`);
                addTransactionRowToPanel('LOSS', currentStake, profit);

                const multiplier = parseFloat(document.getElementById('bot-martingale').value);
                currentStake = currentStake * multiplier;
                logJournalMessage(`Martingale applied. Next stake: $${currentStake.toFixed(2)}`);
            }
            updateStatsDashboard();
            checkTargetThresholds();
        }
    }
}

function executeContractPurchase(prediction) {
    if (!isBotRunning || lastContractId !== null) return;

    const selectedMarket = document.getElementById('bot-market').value;
    const durationTicks = parseInt(document.getElementById('bot-duration').value);
    const tradeType = document.getElementById('bot-trade-type').value;

    let contractType = "DIGITOVER";
    let barrierTarget = undefined;
    let extraParameters = {};

    switch (tradeType) {
        case 'accumulator':
            contractType = "ACCU";
            const growthRate = parseFloat(document.getElementById('bot-growth-rate')?.value || 0.03);
            extraParameters.growth_rate = growthRate;
            const takeProfitVal = parseFloat(document.getElementById('bot-tp')?.value || 0);
            if (takeProfitVal > 0) {
                extraParameters.limit_order = { take_profit: takeProfitVal };
            }
            break;
        case 'over_under':
            contractType = "DIGITOVER";
            barrierTarget = prediction !== undefined ? prediction.toString() : "1";
            break;
        case 'even_odd':
            contractType = (parseInt(prediction) % 2 === 0) ? "DIGITEVEN" : "DIGITODD";
            break;
        case 'rise_fall':
            contractType = "CALL";
            break;
        case 'rise_fall_equal':
            contractType = "CALLE";
            break;
        case 'only_ups_downs':
            contractType = "RUNHIGH";
            break;
        case 'high_low_ticks':
            contractType = "TICKHIGH";
            break;
        default:
            contractType = "DIGITOVER";
            barrierTarget = "1";
            break;
    }

    const purchaseOrder = {
        buy: 1, // FIX: Must be integer 1, not string "1"
        price: currentStake,
        parameters: {
            amount: currentStake,
            basis: "stake",
            contract_type: contractType,
            currency: "USD",
            symbol: selectedMarket
        }
    };

    if (tradeType !== 'accumulator') {
        purchaseOrder.parameters.duration = durationTicks;
        purchaseOrder.parameters.duration_unit = "t";
    }

    if (barrierTarget !== undefined) {
        purchaseOrder.parameters.barrier = barrierTarget;
    }

    if (Object.keys(extraParameters).length > 0) {
        purchaseOrder.parameters = { ...purchaseOrder.parameters, ...extraParameters };
    }

    if (typeof replicateOrderToSlaves === "function") {
        replicateOrderToSlaves(purchaseOrder.parameters);
    }

    lastContractId = "pending";
    derivWS.send(JSON.stringify(purchaseOrder));
    logJournalMessage(`🎯 Strategy Triggered! Sending ${contractType} at stake $${currentStake.toFixed(2)}...`);
}


// ========================================================
// 📺 MONITOR OUTPUT JOURNAL LOGGERS & METRICS RENDERERS
// ========================================================
function logJournalMessage(text) {
    console.log(`[Btraderhub Journal]: ${text}`);
    const terminal = document.getElementById('journal-terminal-log');
    if (!terminal) return;

    const timestamp = new Date().toLocaleTimeString();
    const logLine = document.createElement('div');
    logLine.className = "leading-tight border-l border-slate-800 pl-1";
    logLine.innerHTML = `<span class="text-slate-500">[${timestamp}]</span> ${text}`;

    terminal.appendChild(logLine);
    terminal.scrollTop = terminal.scrollHeight;
}

function addTransactionRowToPanel(type, stakeAmount, netProfit) {
    const container = document.getElementById('transaction-rows-container');
    const emptyMsg = document.getElementById('empty-rows-msg');
    if (!container) return;
    if (emptyMsg) emptyMsg.classList.add('hidden');

    const row = document.createElement('div');
    const isWin = type === 'WIN';

    row.className = `flex items-center justify-between p-2 rounded border text-xs font-medium transition duration-200 ${
        isWin ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-800'
    }`;

    row.innerHTML = `
        <div class="flex items-center gap-1.5">
            <span class="text-sm">${isWin ? '🎯' : '💥'}</span>
            <div>
                <span class="font-bold">${type}</span>
                <div class="text-[10px] text-gray-500 font-mono">Stake: $${stakeAmount.toFixed(2)}</div>
            </div>
        </div>
        <div class="text-right font-mono font-bold ${isWin ? 'text-brandGreen' : 'text-red-600'}">
            ${isWin ? '+' : ''}$${netProfit.toFixed(2)}
        </div>
    `;
    container.insertBefore(row, container.firstChild);
}

function updateStatsDashboard() {
    const statRuns = document.getElementById('stat-runs');
    const statStake = document.getElementById('stat-stake');
    const statPeakExposure = document.getElementById('stat-peak-exposure');
    const statWinRate = document.getElementById('stat-win-rate');
    const statStreak = document.getElementById('stat-current-streak');
    const profitDisplay = document.getElementById('stat-profit');

    if (statRuns) statRuns.innerText = totalRuns;
    if (statStake) statStake.innerText = currentStake.toFixed(2);

    if (currentStake > peakExposure) {
        peakExposure = currentStake;
        if (statPeakExposure) statPeakExposure.innerText = peakExposure.toFixed(2);
    }

    const winRate = totalRuns > 0 ? ((totalWins / totalRuns) * 100).toFixed(1) : "0.0";
    if (statWinRate) statWinRate.innerText = `${winRate}%`;

    if (statStreak) {
        statStreak.innerText = currentStreak > 0 ? `+${currentStreak}` : currentStreak;
        statStreak.className = currentStreak > 0
            ? "text-sm font-mono font-black text-emerald-600 mt-0.5"
            : currentStreak < 0
                ? "text-sm font-mono font-black text-red-500 mt-0.5"
                : "text-sm font-mono font-black text-slate-800 mt-0.5";
    }

    if (profitDisplay) {
        profitDisplay.innerText = totalProfitLoss.toFixed(2);
        profitDisplay.className = totalProfitLoss > 0
            ? "text-sm font-mono font-black text-brandGreen mt-0.5"
            : totalProfitLoss < 0
                ? "text-sm font-mono font-black text-red-600 mt-0.5"
                : "text-sm font-mono font-black text-slate-800 mt-0.5";
    }
}

function checkTargetThresholds() {
    const tpEl = document.getElementById('bot-tp');
    const slEl = document.getElementById('bot-sl');
    if (!tpEl || !slEl) return;

    const takeProfit = parseFloat(tpEl.value);
    const stopLoss = parseFloat(slEl.value) * -1;

    if (totalProfitLoss >= takeProfit) {
        logJournalMessage(`🏆 Target Profit of $${takeProfit} reached! Halting bot safely.`);
        toggleBotExecution();
    } else if (totalProfitLoss <= stopLoss) {
        logJournalMessage(`⚠️ Stop Loss of $${Math.abs(stopLoss)} hit. Halting bot.`);
        toggleBotExecution();
    }
}


// ========================================================
// 📈 TWIN TRADINGVIEW EMBEDDED ENGINE FUNCTIONS
// ========================================================
let compactChartInstance = null;
let standaloneChartInstance = null;

function initializeTradingViewChart(symbolName = "OANDA:XAUUSD") {
    const container = document.getElementById('tv-chart-frame');
    if (!container) return;
    container.innerHTML = "";

    const widgetOptions = {
        "width": "100%",
        "height": "100%",
        "symbol": symbolName,
        "interval": "1",
        "timezone": "Etc/UTC",
        "theme": "light",
        "style": "1",
        "locale": "en",
        "enable_publishing": false,
        "hide_side_toolbar": false,
        "allow_symbol_change": true,
        "container_id": "tv-chart-frame",
        "studies": ["RSI@tv-basicstudies", "MASimple@tv-basicstudies"]
    };

    const buildWidget = () => {
        if (typeof TradingView !== 'undefined' && TradingView.widget) {
            compactChartInstance = new TradingView.widget(widgetOptions);
        }
    };

    if (typeof TradingView !== 'undefined' && TradingView.widget) {
        buildWidget();
    } else {
        const script = document.createElement('script');
        script.src = 'https://s3.tradingview.com/tv.js';
        script.type = 'text/javascript';
        script.async = true;
        script.onload = buildWidget;
        document.head.appendChild(script);
    }
}

// Update the Deriv SmartCharts iframe when market changes
function updateLiveChartAsset() {
    const selectedSymbol = document.getElementById('bot-market').value;
    const ticker = document.getElementById('chart-asset-ticker');
    if (ticker) ticker.innerText = selectedSymbol;
    // Update iframe src with new Deriv symbol — no TradingView mapping needed
    const iframe = document.getElementById('deriv-chart-frame');
    if (iframe) iframe.src = `https://charts.deriv.com/?symbol=${selectedSymbol}&granularity=60`;
    logJournalMessage(`Switching chart to: ${selectedSymbol}`);
}

function initializeStandaloneFullScreenChart(symbolName = "OANDA:XAUUSD") {
    const container = document.getElementById('tv-standalone-frame');
    if (!container) return;
    container.innerHTML = "";

    const widgetOptions = {
        "width": "100%",
        "height": "100%",
        "symbol": symbolName,
        "interval": "5",
        "timezone": "Etc/UTC",
        "theme": "light",
        "style": "1",
        "locale": "en",
        "enable_publishing": false,
        "hide_side_toolbar": false,
        "allow_symbol_change": true,
        "container_id": "tv-standalone-frame",
        "studies": ["RSI@tv-basicstudies", "MACD@tv-basicstudies"]
    };

    const buildWidget = () => {
        if (typeof TradingView !== 'undefined' && TradingView.widget) {
            standaloneChartInstance = new TradingView.widget(widgetOptions);
        }
    };

    if (typeof TradingView !== 'undefined' && TradingView.widget) {
        buildWidget();
    } else {
        const script = document.createElement('script');
        script.src = 'https://s3.tradingview.com/tv.js';
        script.type = 'text/javascript';
        script.async = true;
        script.onload = buildWidget;
        document.head.appendChild(script);
    }
}


// ========================================================
// 👥 COPY TRADING ENGINE
// ========================================================
let slaveAccounts = [];

function addNewSlave() {
    const tokenInput = document.getElementById('slave-token-input');
    const multiplierInput = document.getElementById('slave-multiplier-input');
    if (!tokenInput || !multiplierInput) return;

    const token = tokenInput.value;
    const multiplier = parseFloat(multiplierInput.value);

    if (!token) return alert("Enter a valid token");

    const slave = {
        id: Date.now(),
        token: token,
        multiplier: multiplier,
        ws: new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${DERIV_APP_ID}`)
    };

    slave.ws.onopen = () => slave.ws.send(JSON.stringify({ authorize: token }));
    slaveAccounts.push(slave);

    logJournalMessage(`Slave added (Multiplier: ${multiplier}x)`);
    renderSlaveList();
}

// FIX: renderSlaveList was called but never defined
function renderSlaveList() {
    const container = document.getElementById('slave-list-container');
    if (!container) return;
    container.innerHTML = '';

    if (slaveAccounts.length === 0) {
        container.innerHTML = '<p class="text-xs text-gray-400">No slave accounts added yet.</p>';
        return;
    }

    slaveAccounts.forEach(slave => {
        const row = document.createElement('div');
        row.className = "flex items-center justify-between p-2 rounded border text-xs font-mono bg-slate-50 border-slate-200";
        row.innerHTML = `
            <span>ID: ${slave.id}</span>
            <span>Multiplier: ${slave.multiplier}x</span>
            <button onclick="removeSlave(${slave.id})" class="text-red-500 hover:text-red-700 text-[10px]">Remove</button>
        `;
        container.appendChild(row);
    });
}

function removeSlave(id) {
    const slave = slaveAccounts.find(s => s.id === id);
    if (slave && slave.ws) slave.ws.close();
    slaveAccounts = slaveAccounts.filter(s => s.id !== id);
    renderSlaveList();
    logJournalMessage(`Slave account ${id} removed.`);
}

function replicateOrderToSlaves(orderParameters) {
    if (slaveAccounts.length === 0) return;

    slaveAccounts.forEach(slave => {
        if (slave.ws && slave.ws.readyState === WebSocket.OPEN) {
            const scaledParams = {
                ...orderParameters,
                amount: orderParameters.amount * slave.multiplier
            };
            slave.ws.send(JSON.stringify({ buy: 1, parameters: scaledParams }));
            logJournalMessage(`🚀 Mirroring order to Slave: ${slave.id}`);
        }
    });
}


// ========================================================
// 🔌 CONNECTION STATUS & HEALTH CHECK
// ========================================================
function updateConnectionStatus(isConnected) {
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    if (dot) dot.className = isConnected
        ? 'h-2 w-2 rounded-full bg-green-500 mr-2'
        : 'h-2 w-2 rounded-full bg-red-500 mr-2';
    if (text) text.innerText = isConnected ? 'LIVE' : 'OFFLINE';
}

// FIX: Added isReconnecting guard to prevent connection storms
setInterval(() => {
    if (derivWS && derivWS.readyState === WebSocket.OPEN) {
        updateConnectionStatus(true);
        isReconnecting = false;
    } else {
        updateConnectionStatus(false);
        if (!isReconnecting) {
            isReconnecting = true;
            console.warn("Connection lost. Attempting reconnection...");
            connectToDeriv();
        }
    }
}, 5000);


// ========================================================
// 📊 STATS TRACKING
// ========================================================
let stats = { wins: 0, losses: 0, totalProfit: 0 };

function updateDashboardStats(profit, status) {
    const p = parseFloat(profit);
    if (status === 'won') {
        stats.wins++;
        stats.totalProfit += p;
    } else {
        stats.losses++;
        stats.totalProfit += p;
    }
    const totalTradeProfitEl = document.getElementById('total-profit');
    if (totalTradeProfitEl) totalTradeProfitEl.innerText = stats.totalProfit.toFixed(2);

    const winRateEl = document.getElementById('win-rate-display');
    const total = stats.wins + stats.losses;
    if (winRateEl && total > 0) {
        winRateEl.innerText = ((stats.wins / total) * 100).toFixed(2) + '%';
    }
}


// ========================================================
// 🧠 AI MARKET ANALYSIS ENGINE
// ========================================================

// FIX: Removed the duplicate sync stub; kept the real async version only
async function suggestBestMarket() {
    logJournalMessage("🤖 AI: Initializing secure market scan...");
    const indices = ["R_10", "R_50", "1HZ10V"];
    let bestAsset = { name: indices[0], volatility: Infinity };

    for (const symbol of indices) {
        const vol = await fetchWithRetry(symbol);
        if (vol < bestAsset.volatility) {
            bestAsset = { name: symbol, volatility: vol };
        }
    }

    const select = document.getElementById('market-asset-select');
    if (select) select.value = bestAsset.name;
    logJournalMessage(`🎯 AI Optimization Complete: ${bestAsset.name} selected.`);
}

async function getMarketVolatility(symbol) {
    return new Promise((resolve, reject) => {
        if (!derivWS || derivWS.readyState !== WebSocket.OPEN) {
            return reject(new Error("WebSocket not connected"));
        }

        derivWS.send(JSON.stringify({
            ticks_history: symbol,
            adjust_start_time: 1,
            count: 100,
            end: "latest",
            style: "ticks"
        }));

        // FIX: Use a one-time listener instead of overwriting onmessage globally
        const handler = (msg) => {
            const data = JSON.parse(msg.data);
            if (data.msg_type === 'history') {
                derivWS.removeEventListener('message', handler);
                const prices = data.history.prices;
                const range = Math.max(...prices) - Math.min(...prices);
                resolve(range);
            }
        };
        derivWS.addEventListener('message', handler);

        // Timeout safety
        setTimeout(() => {
            derivWS.removeEventListener('message', handler);
            reject(new Error("Timeout fetching volatility for " + symbol));
        }, 5000);
    });
}

async function fetchWithRetry(symbol, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await getMarketVolatility(symbol);
        } catch (err) {
            console.warn(`Attempt ${i + 1} failed for ${symbol}. Retrying...`);
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    return Infinity;
}

// FIX: getTickHistory was called in getTrendAnalysis but never defined
async function getTickHistory(symbol, count = 50) {
    return new Promise((resolve, reject) => {
        if (!derivWS || derivWS.readyState !== WebSocket.OPEN) {
            return reject(new Error("WebSocket not connected"));
        }

        derivWS.send(JSON.stringify({
            ticks_history: symbol,
            adjust_start_time: 1,
            count: count,
            end: "latest",
            style: "ticks"
        }));

        const handler = (msg) => {
            const data = JSON.parse(msg.data);
            if (data.msg_type === 'history') {
                derivWS.removeEventListener('message', handler);
                resolve(data.history.prices);
            }
        };
        derivWS.addEventListener('message', handler);

        setTimeout(() => {
            derivWS.removeEventListener('message', handler);
            reject(new Error("Timeout fetching tick history for " + symbol));
        }, 5000);
    });
}

async function getTrendAnalysis(symbol) {
    const history = await getTickHistory(symbol, 50);
    const startPrice = history[0];
    const endPrice = history[history.length - 1];
    const change = endPrice - startPrice;

    if (change > 0) return { direction: 'UP', strength: change };
    if (change < 0) return { direction: 'DOWN', strength: Math.abs(change) };
    return { direction: 'SIDEWAYS', strength: 0 };
}

// FIX: getRSIValue was called in botTickLoop but never defined; added a stub
// Replace this with your real RSI calculation if available
function getRSIValue() {
    // Placeholder — wire this up to your real indicator data source
    console.warn("getRSIValue() is a stub. Implement with real tick data.");
    return 50;
}

async function botTickLoop() {
    if (!derivWS || derivWS.readyState !== WebSocket.OPEN) return;

    const marketSelector = document.getElementById('bot-market');
    const currentSymbol = marketSelector ? marketSelector.value : "R_10";

    const trend = await getTrendAnalysis(currentSymbol);
    const rsi = getRSIValue();

    if (trend.direction === 'UP' && rsi < 30) {
        logJournalMessage("🚀 Bullish Trend + RSI Oversold: Buying ONLY_UPS");
        executeContractPurchase("ONLY_UPS");
    } else if (trend.direction === 'DOWN' && rsi > 70) {
        logJournalMessage("📉 Bearish Trend + RSI Overbought: Buying ONLY_DOWNS");
        executeContractPurchase("ONLY_DOWNS");
    }
}

function checkStrategyConditions(rsiValue) {
    const rsiLimit = 30;
    if (rsiValue < rsiLimit) {
        logJournalMessage("🚀 RSI Oversold: Executing Long Strategy");
        executeContractPurchase("OVER");
    }
}


// ========================================================
// 🔢 DIGIT TRACKER
// ========================================================
let digitCounts = new Array(10).fill(0);
let totalTicks = 0;

function updateDigitStats(tick) {
    const lastDigit = parseInt(tick.toString().slice(-1));
    digitCounts[lastDigit]++;
    totalTicks++;
    renderDigitCircles();
}

function renderDigitCircles() {
    const container = document.getElementById('digit-circles-container');
    if (!container) return;
    container.innerHTML = '';

    let ranked = digitCounts.map((count, digit) => ({ digit, count }));
    ranked.sort((a, b) => b.count - a.count);

    digitCounts.forEach((count, digit) => {
        const rank = ranked.findIndex(r => r.digit === digit);
        const percentage = totalTicks > 0 ? ((count / totalTicks) * 100).toFixed(1) : 0;

        let bgColor = "bg-white";
        if (rank === 0) bgColor = "bg-green-500 text-white";
        else if (rank === 1) bgColor = "bg-blue-500 text-white";
        else if (rank === 8) bgColor = "bg-yellow-400";
        else if (rank === 9) bgColor = "bg-red-500 text-white";

        const circle = document.createElement('div');
        circle.className = `digit-circle p-4 rounded-full flex flex-col items-center justify-center shadow-md ${bgColor}`;
        circle.onclick = () => {
            const pred = document.getElementById('bot-prediction');
            if (pred) pred.value = digit;
        };
        circle.innerHTML = `<span class="text-lg font-bold">${digit}</span><span class="text-[9px]">${percentage}%</span>`;
        container.appendChild(circle);
    });
}