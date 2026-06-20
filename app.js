// ========================================================
// 🔐 GLOBAL APPLICATION CONFIGURATION & RUNTIME STATES
// ========================================================
// DO NOT initialize the WebSocket here in the global scope
let derivWS; // Global variable

function connectToDeriv() {
    if (typeof DERIV_APP_ID === 'undefined') {
        console.error("DERIV_APP_ID missing! Check config.js");
        return;
    }

    // 1. Create the instance
    const socket = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${DERIV_APP_ID}`);

    // 2. Attach listeners to the local 'socket' variable, NOT the global 'derivWS' yet
    socket.onopen = () => {
        console.log("Connected to Deriv!");
        derivWS = socket; // Now assign to the global variable
        document.querySelector('.status').innerText = "ONLINE";
    };

    socket.onerror = (err) => console.error("WS Error:", err);
    
    socket.onclose = () => {
        console.log("Connection lost.");
        document.querySelector('.status').innerText = "OFFLINE";
    };
}

window.addEventListener('load', connectToDeriv);

function connectToDeriv() {
    // Just assign it here, don't use 'const' again
    derivWS = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${DERIV_APP_ID}`);
    // ... rest of your logic
}

// const derivWS = new WebSocket(...); // <--- REMOVE THIS IF IT IS AT THE TOP

function connectToDeriv() {
    // Check if the ID exists; if not, wait 1 second and try again
    if (typeof DERIV_APP_ID === 'undefined') {
        console.warn("Config not loaded yet, waiting...");
        setTimeout(connectToDeriv, 1000);
        return;
    }

    const derivWS = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${DERIV_APP_ID}`);


    derivWS.onopen = () => {
        console.log("Connected to Deriv!");
        // Update your UI here
    };
    
    derivWS.onerror = (err) => console.error("WS Error:", err);
}

// Wait for the whole page to load before starting the connection
window.addEventListener('load', connectToDeriv);
// 1. SECURE INTEGRATED OAUTH REDIRECTION ROUTER
function loginWithDeriv() {
    const redirectUrl = window.location.href.split('?')[0]; 
    const oauthUrl = `https://oauth.deriv.com/oauth2/authorize?app_id=${DERIV_APP_ID}&l=en&brand=deriv&redirect_uri=${encodeURIComponent(redirectUrl)}`;
    window.location.href = oauthUrl;
}

function signUpWithDeriv() {
    window.location.href = "https://deriv.com/signup/";
}
const marketAssets = {
    "Continuous Indices": ["Volatility 10", "Volatility 25", "Volatility 50", "Volatility 75", "Volatility 100"],
    "1S Indices": ["Volatility 10 (1s)", "Volatility 25 (1s)", "Volatility 50 (1s)", "Volatility 75 (1s)", "Volatility 100 (1s)"],
    "Jump Indices": ["Jump 10 Index", "Jump 25 Index", "Jump 50 Index", "Jump 75 Index", "Jump 100 Index"]
};

function populateAssetDropdown() {
    const select = document.getElementById('market-asset-select');
    
    Object.keys(marketAssets).forEach(category => {
        // Create an optgroup for a cleaner UI
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

// Call this function when the page loads
document.addEventListener('DOMContentLoaded', populateAssetDropdown);

// 2. AUTOMATIC ADDRESS TOKEN URL INTERCEPT CHECKER
window.addEventListener('load', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token1'); 
    if (token) {
        window.history.replaceState({}, document.title, window.location.pathname);
        initializeWebSocketSession(token);
    }
});

// 3. SECURE WEBSOCKET HANDSHAKE CONNECTIONS MANAGER
function initializeWebSocketSession(token) {
    const statusDiv = document.getElementById('connection-status');
    if(statusDiv) {
        statusDiv.className = "text-xs p-3 rounded-lg border border-blue-500/30 bg-blue-50 text-blue-600 font-medium";
        statusDiv.innerText = "Initializing security handshake via token pass...";
        statusDiv.classList.remove('hidden');
    }

    derivWS = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${DERIV_APP_ID}`);

    derivWS.onopen = function() {
        derivWS.send(JSON.stringify({ authorize: token }));
    };

    derivWS.onmessage = function(msg) {
        const response = JSON.parse(msg.data);
        
        // Debugging logs
        console.log("Incoming Message:", response.msg_type);
        
        // Pass to your existing market data handler
        handleIncomingMarketData(response);

        // Authorization Logic
        if (response.msg_type === 'authorize') {
            if (response.error) {
                if(statusDiv) {
                    statusDiv.className = "text-xs p-3 rounded-lg border border-red-500/30 bg-red-50 text-red-600";
                    statusDiv.innerText = `Auth Error: ${response.error.message}`;
                }
            } else {
                if(statusDiv) {
                    statusDiv.className = "text-xs p-3 rounded-lg border border-emerald-500/30 bg-emerald-50 text-brandGreen font-bold";
                    statusDiv.innerText = `Connected securely as: ${response.authorize.email}`;
                }
                
                document.getElementById('balance-display').classList.remove('hidden');
                document.getElementById('login-nav-btn').classList.add('hidden');
                document.getElementById('signup-nav-btn').classList.add('hidden');
                
                const balance = parseFloat(response.authorize.balance).toFixed(2);
                const currency = response.authorize.currency;
                document.getElementById('account-balance').innerText = `${balance} ${currency}`;

                // --- AUTOMATIC TICK SUBSCRIPTION ---
                // Once authorized, start the stream for the D-Circles
                derivWS.send(JSON.stringify({
                    ticks: "R_10", 
                    subscribe: 1
                }));
            }
        }

        // --- DIGIT CIRCLES FEED ---
        if (response.msg_type === 'tick') {
            const tickPrice = response.tick.quote;
            // This function is defined in your Digit Tracker logic
            if (typeof updateDigitStats === 'function') {
                updateDigitStats(tickPrice);
            }
        }
    };
}

// 4. NAVIGATION VIEWPORT LINK SWITCHING CONTROL MATRIX
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
            const marketSelector = document.getElementById('bot-market');
            const currentAsset = marketSelector ? marketSelector.value : "OANDA:XAUUSD";
            initializeTradingViewChart(currentAsset);
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
        if (tradeType === 'accumulator') {
            accuPanel.classList.remove('hidden');
        } else {
            accuPanel.classList.add('hidden');
        }
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
        alert("Please authorize your Deriv channel configuration profile link up top first!");
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
        derivWS.send(JSON.stringify({ ticks: selectedMarket }));
        
    } else {
        isBotRunning = false;
        runBtn.innerText = "▶ RUN BOT";
        runBtn.className = "w-full bg-brandGreen hover:bg-brandGreenHover text-white font-bold py-2 rounded text-xs tracking-wider transition shadow-sm";
        logJournalMessage("Bot execution stopped safely by user.");
    }
}
// --- BOT MANAGEMENT ---
function handleBotUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const botConfig = JSON.parse(e.target.result);
            // Logic to inject botConfig into your Blockly workspace or state
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
        } else {
            lastContractId = response.buy.contract_id;
            logJournalMessage(`Contract purchased successfully! ID: ${lastContractId}. Watching outcome...`);
            totalRuns++;
            updateStatsDashboard();
        }
    }

    if (response.msg_type === 'proposal_open_contract' && response.proposal_open_contract?.contract) {
        const contract = response.proposal_open_contract.contract;

        if (contract.is_expired && contract.id === lastContractId) {
            const profit = parseFloat(contract.profit);
            lastContractId = null;

            if (profit > 0) {
                try { winAudio.play(); } catch(e){}
                totalWins++;
                currentStreak = currentStreak < 0 ? 1 : currentStreak + 1;
                totalProfitLoss += profit;
                logJournalMessage(`🎯 WINNER! Profit: +$${profit.toFixed(2)}`);
                addTransactionRowToPanel('WIN', currentStake, profit);
                currentStake = parseFloat(document.getElementById('bot-stake').value);
            } else {
                try { lossAudio.play(); } catch(e){}
                currentStreak = currentStreak > 0 ? -1 : currentStreak - 1;
                totalProfitLoss += profit; 
                logJournalMessage(`💥 LOSS. Deficit: $${profit.toFixed(2)}`);
                addTransactionRowToPanel('LOSS', currentStake, profit);
                
                const multiplier = parseFloat(document.getElementById('bot-martingale').value);
                currentStake = currentStake * multiplier;
                logJournalMessage(`Martingale calculated. Adjusting next stake to: $${currentStake.toFixed(2)}`);
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
            const growthRate = parseFloat(document.getElementById('bot-growth-rate').value || 0.03);
            extraParameters.growth_rate = growthRate;
            
            const takeProfitVal = parseFloat(document.getElementById('bot-tp').value || 0);
            if (takeProfitVal > 0) {
                extraParameters.limit_order = { take_profit: takeProfitVal };
            }
            break;

        case 'over_under':
            contractType = "DIGITOVER"; 
            barrierTarget = prediction ? prediction.toString() : "1";
            break;

        case 'even_odd':
            const isNumericEven = (parseInt(prediction) % 2 === 0);
            contractType = isNumericEven ? "DIGITEVEN" : "DIGITODD";
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
        buy: "1",
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
replicateOrderToSlaves(purchaseOrder.parameters);
    lastContractId = "pending"; 
    
    derivWS.send(JSON.stringify(purchaseOrder));
    logJournalMessage(`🎯 Strategy Triggered! Sending ${contractType} order at stake $${currentStake.toFixed(2)}...`);
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
    document.getElementById('stat-runs').innerText = totalRuns;
    document.getElementById('stat-stake').innerText = currentStake.toFixed(2);
    
    if (currentStake > peakExposure) {
        peakExposure = currentStake;
        document.getElementById('stat-peak-exposure').innerText = peakExposure.toFixed(2);
    }

    const winRate = totalRuns > 0 ? ((totalWins / totalRuns) * 100).toFixed(1) : "0.0";
    document.getElementById('stat-win-rate').innerText = `${winRate}%`;

    const streakElement = document.getElementById('stat-current-streak');
    if (streakElement) {
        streakElement.innerText = currentStreak > 0 ? `+${currentStreak}` : currentStreak;
        if (currentStreak > 0) {
            streakElement.className = "text-sm font-mono font-black text-emerald-600 mt-0.5";
        } else if (currentStreak < 0) {
            streakElement.className = "text-sm font-mono font-black text-red-500 mt-0.5";
        } else {
            streakElement.className = "text-sm font-mono font-black text-slate-800 mt-0.5";
        }
    }
    
    const profitDisplay = document.getElementById('stat-profit');
    profitDisplay.innerText = totalProfitLoss.toFixed(2);

    if (totalProfitLoss > 0) {
        profitDisplay.className = "text-sm font-mono font-black text-brandGreen mt-0.5";
    } else if (totalProfitLoss < 0) {
        profitDisplay.className = "text-sm font-mono font-black text-red-600 mt-0.5";
    } else {
        profitDisplay.className = "text-sm font-mono font-black text-slate-800 mt-0.5";
    }
}

function checkTargetThresholds() {
    const takeProfit = parseFloat(document.getElementById('bot-tp').value);
    const stopLoss = parseFloat(document.getElementById('bot-sl').value) * -1;

    if (totalProfitLoss >= takeProfit) {
        logJournalMessage(`🏆 Target Profit of $${takeProfit} smashed! Halting bot safely.`);
        toggleBotExecution();
    } else if (totalProfitLoss <= stopLoss) {
        logJournalMessage(`⚠️ Max Risk Stop Loss of $${Math.abs(stopLoss)} touched. Halting bot.`);
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
        "studies": [
            "RSI@tv-basicstudies",
            "MASimple@tv-basicstudies"
        ]
    };

    if (typeof TradingView !== 'undefined' && TradingView.widget) {
        compactChartInstance = new TradingView.widget(widgetOptions);
    } else {
        const script = document.createElement('script');
        script.src = 'https://s3.tradingview.com/tv.js';
        script.type = 'text/javascript';
        script.async = true;
        script.onload = () => {
            if (typeof TradingView !== 'undefined' && TradingView.widget) {
                compactChartInstance = new TradingView.widget(widgetOptions);
            }
        };
        document.head.appendChild(script);
    }
}

function updateLiveChartAsset() {
    const selectedSymbol = document.getElementById('bot-market').value;
    document.getElementById('chart-asset-ticker').innerText = selectedSymbol;
    logJournalMessage(`Switching layout charting feed to asset focus: ${selectedSymbol}`);
    initializeTradingViewChart(selectedSymbol);
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
        "studies": [
            "RSI@tv-basicstudies",
            "MACD@tv-basicstudies"
        ]
    };

    if (typeof TradingView !== 'undefined' && TradingView.widget) {
        standaloneChartInstance = new TradingView.widget(widgetOptions);
    } else {
        const script = document.createElement('script');
        script.src = 'https://s3.tradingview.com/tv.js';
        script.type = 'text/javascript';
        script.async = true;
        script.onload = () => {
            if (typeof TradingView !== 'undefined' && TradingView.widget) {
                standaloneChartInstance = new TradingView.widget(widgetOptions);
            }
        };
        document.head.appendChild(script);
    }
}
// ========================================================
// 👥 COPY TRADING ENGINE (Place this at the bottom of app.js)
// ========================================================

// 1. Storage array
let slaveAccounts = [];

// 2. Add New Slave function (UI triggered)
function addNewSlave() {
    const token = document.getElementById('slave-token-input').value;
    const multiplier = parseFloat(document.getElementById('slave-multiplier-input').value);
    
    if(!token) return alert("Enter Token");
    
    const slave = {
        id: Date.now(),
        token: token,
        multiplier: multiplier,
        ws: new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${DERIV_APP_ID}`)
    };
    
    slave.ws.onopen = () => slave.ws.send(JSON.stringify({ authorize: token }));
    slaveAccounts.push(slave);
    
    logJournalMessage(`Slave added (Multiplier: ${multiplier}x)`);
    renderSlaveList(); // Updates the UI list in the Copy Trading tab
}

// 3. Replicate Order function (Called by your Bot)
function replicateOrderToSlaves(orderParameters) {
    if (slaveAccounts.length === 0) return;

    slaveAccounts.forEach(slave => {
        if (slave.ws && slave.ws.readyState === WebSocket.OPEN) {
            // Apply the multiplier to the stake amount
            const scaledParams = {
                ...orderParameters,
                amount: orderParameters.amount * slave.multiplier
            };

            slave.ws.send(JSON.stringify({
                buy: 1,
                parameters: scaledParams
            }));
            logJournalMessage(`🚀 Mirroring order to Slave Account: ${slave.id}`);
        }
    });
}
function updateConnectionStatus(isConnected) {
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    dot.className = isConnected ? 'h-2 w-2 rounded-full bg-green-500 mr-2' : 'h-2 w-2 rounded-full bg-red-500 mr-2';
    text.innerText = isConnected ? 'LIVE' : 'OFFLINE';
}

// Hook into your existing derivWS connection
derivWS.onopen = () => updateConnectionStatus(true);
derivWS.onclose = () => updateConnectionStatus(false);
let stats = { wins: 0, losses: 0, totalProfit: 0 };

function processContractResult(contract) {
    if (contract.status === 'won') {
        stats.wins++;
        stats.totalProfit += parseFloat(contract.profit);
    } else {
        stats.losses++;
        stats.totalProfit += parseFloat(contract.profit);
    }
    // Update your UI elements (Runs, Win Rate, Profit/Loss)
    document.getElementById('win-rate-display').innerText = 
        ((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(2) + '%';
}
function checkStrategyConditions(rsiValue) {
    const rsiLimit = 30; // Your threshold
    if (rsiValue < rsiLimit) {
        logJournalMessage("🚀 RSI Oversold: Executing Long Strategy");
        executeContractPurchase("OVER");
    }
}
// Function to verify connection health every 5 seconds
setInterval(() => {
    if (derivWS && derivWS.readyState === WebSocket.OPEN) {
        updateConnectionStatus(true);
    } else {
        updateConnectionStatus(false);
        // Attempt to reconnect if dead
        console.warn("Connection lost. Attempting reconnection...");
        initDerivConnection(); 
    }
}, 5000);
// Listen for contract status updates
derivWS.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    
    // Check if it's a contract update
    if (data.msg_type === 'proposal_open_contract') {
        const contract = data.proposal_open_contract;
        
        // Update Stats ONLY when the contract is finished
        if (contract.is_sold) {
            updateDashboardStats(contract.profit, contract.status);
            logJournalMessage(`Trade finished: ${contract.status.toUpperCase()} | Profit: ${contract.profit}`);
        }
    }
};
// Inside your existing derivWS.onmessage...
if (data.msg_type === 'tick') {
    const tick = data.tick.quote;
    updateDigitStats(tick); // <--- Add this call
}

function updateDashboardStats(profit, status) {
    const p = parseFloat(profit);
    if (status === 'won') {
        stats.wins++;
        stats.totalProfit += p;
    } else {
        stats.losses++;
        stats.totalProfit += p;
    }
    // Update your UI elements here
    document.getElementById('total-profit').innerText = stats.totalProfit.toFixed(2);
}
// --- UPDATED BOT LOOP ---
async function botTickLoop() {
    // 1. Connection Check
    if (derivWS.readyState !== WebSocket.OPEN) return;

    // 2. Trend & Market Analysis (The "Brain")
    const trend = await getTrendAnalysis(currentSymbol); 
    const rsi = getRSIValue(); // Existing indicator

    // 3. Logic Execution (The "Action")
    if (trend.direction === 'UP' && rsi < 30) {
        logJournalMessage("🚀 Bullish Trend + RSI Oversold: Buying ONLY_UPS");
        executeContractPurchase("ONLY_UPS");
    } 
    else if (trend.direction === 'DOWN' && rsi > 70) {
        logJournalMessage("📉 Bearish Trend + RSI Overbought: Buying ONLY_DOWNS");
        executeContractPurchase("ONLY_DOWNS");
    }
}

// --- AI MARKET SUGGESTER ---
const assetsToAnalyze = ["Volatility 10", "Volatility 50", "Jump 10 Index", "1S Volatility 10"];

function suggestBestMarket() {
    logJournalMessage("🧠 AI: Analyzing markets for optimal Over/Under conditions...");
    
    // Simulate AI analysis logic
    // In a production app, this would poll historical tick data via WebSocket
    const recommendations = assetsToAnalyze.map(asset => ({
        name: asset,
        score: Math.random() * 100 // Higher score = better for Over/Under
    }));

    const bestAsset = recommendations.sort((a, b) => b.score - a.score)[0];

    // Update the UI
    const select = document.getElementById('market-asset-select');
    select.value = bestAsset.name;

    logJournalMessage(`✅ AI Suggestion: ${bestAsset.name} (Confidence: ${bestAsset.score.toFixed(0)}%)`);
    return bestAsset.name;
}
async function getMarketVolatility(symbol) {
    return new Promise((resolve) => {
        derivWS.send(JSON.stringify({
            ticks_history: symbol,
            adjust_start_time: 1,
            count: 100,
            end: "latest",
            style: "ticks"
        }));

        derivWS.onmessage = (msg) => {
            const data = JSON.parse(msg.data);
            if (data.msg_type === 'history') {
                const prices = data.history.prices;
                // Calculate volatility (Simplified: High/Low range)
                const range = Math.max(...prices) - Math.min(...prices);
                resolve(range);
            }
        };
    });
}
async function suggestBestMarket() {
    logJournalMessage("🤖 AI: Initializing secure market scan...");
    const indices = ["R_10", "R_50", "1HZ10V"]; 
    let bestAsset = { name: "", volatility: Infinity };

    for (const symbol of indices) {
        const vol = await fetchWithRetry(symbol); // Using the robust wrapper
        if (vol < bestAsset.volatility) {
            bestAsset = { name: symbol, volatility: vol };
        }
    }

    document.getElementById('market-asset-select').value = bestAsset.name;
    logJournalMessage(`🎯 AI Optimization Complete: ${bestAsset.name} selected.`);
}

// --- ROBUST AI ENGINE ---
async function fetchWithRetry(symbol, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await getMarketVolatility(symbol);
        } catch (err) {
            console.warn(`Attempt ${i + 1} failed for ${symbol}. Retrying...`);
            await new Promise(r => setTimeout(r, 1000)); // Wait 1 sec
        }
    }
    return Infinity; // If all retries fail, return neutral score
}
// --- TREND ANALYSIS ENGINE ---
async function getTrendAnalysis(symbol) {
    const history = await getTickHistory(symbol, 50); // Get last 50 ticks
    const startPrice = history[0];
    const endPrice = history[history.length - 1];
    const change = endPrice - startPrice;

    // Positive change = Upward trend, Negative = Downward
    if (change > 0) return { direction: 'UP', strength: change };
    if (change < 0) return { direction: 'DOWN', strength: Math.abs(change) };
    return { direction: 'SIDEWAYS', strength: 0 };
}
let digitCounts = new Array(10).fill(0);
let totalTicks = 0;

function updateDigitStats(tick) {
    const lastDigit = parseInt(tick.toString().slice(-1));
    digitCounts[lastDigit]++;
    totalTicks++;
    
    // Update the UI
    renderDigitCircles();
}

function renderDigitCircles() {
    const container = document.getElementById('digit-circles-container');
    container.innerHTML = ''; 

    // Create an array of digits [0, 1, ..., 9] and sort by frequency
    let ranked = digitCounts.map((count, digit) => ({ digit, count }));
    ranked.sort((a, b) => b.count - a.count); // Rank: Most frequent to least

    digitCounts.forEach((count, digit) => {
        const rank = ranked.findIndex(r => r.digit === digit);
        const percentage = totalTicks > 0 ? ((count / totalTicks) * 100).toFixed(1) : 0;
        
        // Color Logic
        let bgColor = "bg-white"; // Default
        if (rank === 0) bgColor = "bg-green-500 text-white";       // Most appearing
        else if (rank === 1) bgColor = "bg-blue-500 text-white";   // 2nd most
        else if (rank === 8) bgColor = "bg-yellow-400";            // 2nd least
        else if (rank === 9) bgColor = "bg-red-500 text-white";    // Least appearing

        const circle = document.createElement('div');
        circle.className = `digit-circle p-4 rounded-full flex flex-col items-center justify-center shadow-md ${bgColor}`;
        circle.onclick = () => { document.getElementById('bot-prediction').value = digit; };
        circle.innerHTML = `<span class="text-lg font-bold">${digit}</span><span class="text-[9px]">${percentage}%</span>`;
        container.appendChild(circle);
    });
}

const CONFIG = {
    APP_ID: "YOUR_ACTUAL_APP_ID_HERE"
};
window.addEventListener('DOMContentLoaded', () => {
    initializeTradingViewChart("OANDA:XAUUSD");
});