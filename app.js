// ================================================================
// BTRADERHUB app.js — Clean Focused Build
// Auth: Amy-verified PKCE (DO NOT CHANGE)
// ================================================================

const DERIV_CLIENT_ID = "33ByqD0GecGTE5whirko8";
const DERIV_APP_ID    = "33ByqD0GecGTE5whirko8";
const DERIV_REDIRECT  = "https://btraderhub.vercel.app/";

// ── State ──────────────────────────────────────────────────────
let derivWS          = null;
let accessToken      = null;
let accountId        = null;
let allAccounts      = [];
let isReconnecting   = false;
let reconnectTimer   = null;

// Bot state
let isBotRunning     = false;
let botDirection     = "over";
let currentStake     = 1.00;
let baseStake        = 1.00;
let totalPL          = 0;
let totalStake       = 0;
let totalPayout      = 0;
let totalRuns        = 0;
let totalWins        = 0;
let totalLosses      = 0;
let currentStreak    = 0;
let lastContractId   = null;
let lastEntrySpot    = null;
let aiAutoEnabled    = true;
let pendingContract  = false;

// Digit data — real ticks only
let digitData        = {};
let currentDigitMkt  = "R_10";
let activeTickSubs   = new Set();
let lastDigit        = null;
let consecutiveSame  = 0;
let marketMemory     = {};

// Signal tracking
let seenSignals      = new Set();
let signalHistory    = [];

// Audio
const winAudio  = new Audio('https://actions.google.com/sounds/v1/cartoon/slide_whistle_up.ogg');
const lossAudio = new Audio('https://actions.google.com/sounds/v1/cartoon/boing_long.ogg');

// Market labels — valid Deriv underlying_symbols only
const MKT = {
    "R_10":     "Volatility 10",
    "R_25":     "Volatility 25",
    "R_50":     "Volatility 50",
    "R_75":     "Volatility 75",
    "R_100":    "Volatility 100",
    "1HZ10V":   "Volatility 10 (1s)",
    "1HZ25V":   "Volatility 25 (1s)",
    "1HZ50V":   "Volatility 50 (1s)",
    "1HZ75V":   "Volatility 75 (1s)",
    "1HZ100V":  "Volatility 100 (1s)",
    "jump_10":  "Jump 10 Index",
    "jump_25":  "Jump 25 Index",
    "jump_50":  "Jump 50 Index",
    "jump_75":  "Jump 75 Index",
    "jump_100": "Jump 100 Index",
};

const ALL_MKTS = ["R_10","R_25","R_50","R_75","R_100","1HZ10V","1HZ25V","1HZ50V","1HZ75V","1HZ100V"];

// Pending proposal tracking
let pendingProposalId  = null;
let pendingProposalPrice = null;
let reqIdCounter       = 1;
function nextReqId() { return ++reqIdCounter; }

// Contract type map
const CONTRACT_MAP = {
    over_under:     { over:"DIGITOVER", under:"DIGITUNDER" },
    even_odd:       { even:"DIGITEVEN", odd:"DIGITODD" },
    rise_fall:      { rise:"CALL", fall:"PUT" },
    only_ups_downs: { ups:"RUNHIGH", downs:"RUNLOW" }
};

// ================================================================
// PAGE LOAD
// ================================================================
window.addEventListener('load', async () => {
    onTypeChange();
    updateInfoBar();

    const params = new URLSearchParams(window.location.search);
    const code   = params.get('code');
    const state  = params.get('state');
    if (code && state) {
        window.history.replaceState({}, document.title, window.location.pathname);
        await handleOAuthCallback(code, state);
    }
});

// ================================================================
// TAB & PANEL NAVIGATION
// ================================================================
function switchTab(id) {
    document.querySelectorAll('.tab-pane').forEach(p => {
        p.style.display = 'none';
        p.classList.remove('active');
    });
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));

    const pane = document.getElementById(id + '-pane');
    const btn  = document.getElementById('tab-btn-' + id);
    if (pane) {
        pane.classList.add('active');
        if (pane.classList.contains('scroll')) {
            pane.style.display = 'block';
        } else {
            pane.style.display = 'flex';
        }
    }
    if (btn) btn.classList.add('active');

    if (id === 'digits') {
        changeDigitMarket(document.getElementById('digit-market')?.value || 'R_10');
    }
    if (id === 'scanner') runFullScan();
}

function switchPanel(name, el) {
    // Hide all panels
    ['summary','transactions','journal'].forEach(p => {
        const el2 = document.getElementById('panel-' + p);
        if (el2) el2.style.display = 'none';
    });
    document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));

    const target = document.getElementById('panel-' + name);
    if (target) {
        if (name === 'transactions' || name === 'journal') {
            target.style.display = 'flex';
        } else {
            target.style.display = 'block';
            target.style.overflow = 'auto';
        }
    }
    if (el) el.classList.add('active');
}

// ================================================================
// AUTH — STEP 1: PKCE Login (Amy-verified — DO NOT CHANGE)
// ================================================================
async function loginWithDeriv() {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const rnd = crypto.getRandomValues(new Uint8Array(64));
    const code_verifier = Array.from(rnd).map(v => charset[v % charset.length]).join('');

    const encoder = new TextEncoder();
    const hash    = await crypto.subtle.digest('SHA-256', encoder.encode(code_verifier));
    const bytes   = new Uint8Array(hash);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const code_challenge = btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

    const stateBytes = crypto.getRandomValues(new Uint8Array(16));
    const state = Array.from(stateBytes).map(b => b.toString(16).padStart(2,'0')).join('');

    sessionStorage.setItem('pkce_code_verifier', code_verifier);
    sessionStorage.setItem('oauth_state', state);

    const url = new URL('https://auth.deriv.com/oauth2/auth');
    url.searchParams.set('response_type',         'code');
    url.searchParams.set('client_id',             DERIV_CLIENT_ID);
    url.searchParams.set('redirect_uri',          DERIV_REDIRECT);
    url.searchParams.set('scope',                 'trade');
    url.searchParams.set('state',                 state);
    url.searchParams.set('code_challenge',        code_challenge);
    url.searchParams.set('code_challenge_method', 'S256');

    window.location.href = url.toString();
}

function signUpWithDeriv() {
    window.location.href = "https://track.deriv.com/_Yi8lkjLk8sFMjdsyM5hasGNd7ZgqdRLk/1/";
}

// ================================================================
// AUTH — STEP 2: Callback
// ================================================================
async function handleOAuthCallback(code, state) {
    const savedState    = sessionStorage.getItem('oauth_state');
    const code_verifier = sessionStorage.getItem('pkce_code_verifier');
    sessionStorage.removeItem('oauth_state');
    sessionStorage.removeItem('pkce_code_verifier');

    if (state !== savedState) { showStatus("Security error. Please try again.", 'err'); return; }
    showStatus("Authorizing...", 'info');

    try {
        const resp = await fetch('/api/deriv-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, code_verifier, redirect_uri: DERIV_REDIRECT, client_id: DERIV_CLIENT_ID })
        });
        const tokens = await resp.json();
        if (!resp.ok) { showStatus(`Auth failed: ${tokens.error || 'Unknown'}`, 'err'); return; }
        accessToken = tokens.access_token;
        showStatus("Loading accounts...", 'info');
        await loadAccounts();
    } catch(err) {
        showStatus("Connection error. Please try again.", 'err');
        console.error(err);
    }
}

// ================================================================
// AUTH — STEP 3: Load accounts
// ================================================================
async function loadAccounts() {
    try {
        const headers = { 'Authorization': `Bearer ${accessToken}`, 'Deriv-App-ID': DERIV_APP_ID };

        let resp = await fetch('https://api.derivws.com/trading/v1/options/accounts', { method: 'GET', headers });
        let data = await resp.json();
        allAccounts = Array.isArray(data?.data) ? data.data : [];

        if (allAccounts.length === 0) {
            showStatus("Creating demo account...", 'info');
            resp = await fetch('https://api.derivws.com/trading/v1/options/accounts', {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({ currency: "USD", group: "row", account_type: "demo" })
            });
            data = await resp.json();
            if (!resp.ok || !data?.data) { showStatus("Failed to create account.", 'err'); return; }
            allAccounts = [data.data];
        }

        // Populate switcher
        const sw = document.getElementById('acct-switcher');
        if (sw) {
            sw.innerHTML = '';
            allAccounts.forEach(acc => {
                const opt = document.createElement('option');
                opt.value = acc.account_id;
                opt.text  = `${acc.account_type === 'demo' ? '🟡 Demo' : '🟢 Real'} — ${acc.currency || 'USD'}`;
                sw.appendChild(opt);
            });
        }

        const demo = allAccounts.find(a => a.account_type === 'demo') || allAccounts[0];
        accountId  = demo.account_id;
        if (sw) sw.value = accountId;

        await openWS();
    } catch(err) {
        showStatus("Failed to load accounts.", 'err');
        console.error(err);
    }
}

async function switchAccount(newId) {
    if (newId === accountId) return;
    accountId = newId;
    log("Switching account...", 'i');
    if (derivWS) { derivWS.close(); derivWS = null; }
    activeTickSubs.clear();
    await openWS();
}

// ================================================================
// AUTH — STEP 4: OTP → WebSocket
// ================================================================
async function openWS() {
    try {
        showStatus("Opening secure connection...", 'info');
        const headers = { 'Authorization': `Bearer ${accessToken}`, 'Deriv-App-ID': DERIV_APP_ID };

        const otpResp = await fetch(
            `https://api.derivws.com/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
            { method: 'POST', headers }
        );
        const otpData = await otpResp.json();

        if (!otpResp.ok || !otpData?.data?.url) {
            showStatus(`Connection failed: ${otpData?.error?.message || 'No URL returned'}`, 'err');
            return;
        }

        derivWS = new WebSocket(otpData.data.url);

        derivWS.onopen = () => {
            isReconnecting = false;
            updateConnStatus(true);
            showStatus("✅ Connected!", 'ok');
            onConnected();
        };

        derivWS.onerror = () => updateConnStatus(false);

        derivWS.onclose = () => {
            updateConnStatus(false);
            log("WS closed. Will reconnect...", 'x');
            scheduleReconnect();
        };

        derivWS.onmessage = (msg) => {
            try { routeMsg(JSON.parse(msg.data)); } catch(e) {}
        };

    } catch(err) {
        showStatus("Failed to connect.", 'err');
        console.error(err);
        scheduleReconnect();
    }
}

function scheduleReconnect() {
    if (isReconnecting || !accessToken || !accountId) return;
    isReconnecting = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(async () => {
        log("Reconnecting...", 'x');
        await openWS();
    }, 4000);
}

function onConnected() {
    // Show account UI
    document.getElementById('btn-login')?.classList.add('hidden');
    document.getElementById('btn-signup')?.classList.add('hidden');
    const aw = document.getElementById('acct-wrap');
    if (aw) aw.style.display = 'flex';
    document.getElementById('auth-card')?.style && (document.getElementById('auth-card').style.display = 'none');
    const ds = document.getElementById('dash-stats');
    if (ds) ds.style.display = 'block';
    const bi = document.getElementById('bar-info');
    if (bi) bi.style.display = 'flex';

    // Subscribe to balance + ticks
    derivWS.send(JSON.stringify({ balance: 1, subscribe: 1 }));

    // Fetch valid active symbols from Deriv
    derivWS.send(JSON.stringify({
        active_symbols: "brief",
        product_type:   "basic",
        req_id:         nextReqId()
    }));

    // Subscribe to digit feeds
    subscribeDigitFeed(currentDigitMkt);
    subscribeDigitFeed(document.getElementById('bot-market')?.value || 'R_10');

    // Start AI scan loop
    startAILoop();
    log("✅ Connected to Deriv API", 'i');
}

// ================================================================
// MESSAGE ROUTER
// ================================================================
function routeMsg(r) {
    // Balance update
    if (r.msg_type === 'balance' && r.balance) {
        const el = document.getElementById('balance');
        if (el) el.textContent = `${parseFloat(r.balance.balance).toFixed(2)} ${r.balance.currency}`;
    }

    // Tick — REAL data only
    if (r.msg_type === 'tick' && r.tick) {
        processRealTick(r.tick.symbol, r.tick.quote);
    }

    // Tick history — REAL bulk data
    if (r.msg_type === 'history' && r.history) {
        const sym = r.echo_req?.ticks_history;
        if (sym) processHistory(sym, r.history);
    }

    // Active symbols — log valid symbols for debugging
    if (r.msg_type === 'active_symbols' && r.active_symbols) {
        const digitMkts = r.active_symbols.filter(s =>
            s.market === 'synthetic_index' && s.submarket !== 'random_daily'
        );
        log(`📡 ${digitMkts.length} valid markets loaded from Deriv`, 'i');
        // Update valid symbol list dynamically
        digitMkts.slice(0, 5).forEach(s => {
            log(`   ${s.symbol} = ${s.display_name}`, 'd');
        });
    }

    // STEP 2: Proposal response — extract ID and ask_price, then buy
    if (r.msg_type === 'proposal') {
        if (r.error) {
            pendingContract = false;
            lastContractId  = null;
            log(`❌ Proposal rejected: ${r.error.message}`, 'x');
            log(`   Code: ${r.error.code} | Check market symbol and contract params`, 'x');
        } else if (r.proposal && isBotRunning) {
            const proposalId = r.proposal.id;
            const askPrice   = r.proposal.ask_price;
            log(`✅ Proposal received: ${proposalId} | Ask: $${askPrice}`, 'i');
            buyFromProposal(proposalId, parseFloat(askPrice));
        }
    }

    // STEP 3: Buy response
    if (r.msg_type === 'buy') handleBuyResponse(r);

    // Contract settled
    if (r.msg_type === 'proposal_open_contract' && r.proposal_open_contract) {
        handleContractResult(r.proposal_open_contract);
    }
}

// ================================================================
// REAL TICK PROCESSING — no fake data ever
// ================================================================
function processRealTick(symbol, quote) {
    const digit = parseInt(quote.toString().slice(-1));
    if (isNaN(digit)) return;

    if (!digitData[symbol])    digitData[symbol]    = { counts: new Array(10).fill(0), ticks: 0 };
    if (!marketMemory[symbol]) marketMemory[symbol] = { prices: [], digits: [], ticks: 0 };

    const d  = digitData[symbol];
    const mm = marketMemory[symbol];

    d.counts[digit]++;
    d.ticks = Math.min(d.ticks + 1, 1000);

    mm.prices.push(quote);
    mm.digits.push(digit);
    mm.ticks++;
    if (mm.prices.length > 500) { mm.prices.shift(); mm.digits.shift(); }

    // Consecutive tracking
    if (digit === lastDigit) consecutiveSame++;
    else { consecutiveSame = 1; lastDigit = digit; }

    // Update digit stats tab if active
    if (symbol === currentDigitMkt) {
        const lastEl = document.getElementById('d-last');
        const tickEl = document.getElementById('d-ticks');
        if (lastEl) lastEl.textContent = digit;
        if (tickEl) tickEl.textContent = d.ticks;
        renderDigitCircles(symbol);
        updateDigitStats(symbol);
    }

    // Bot engine — if running and symbol matches
    const botMkt = document.getElementById('bot-market')?.value;
    if (isBotRunning && symbol === botMkt) {
        runBotLogic(digit, quote);
    }

    // AI mini update
    if (symbol === (document.getElementById('bot-market')?.value)) {
        updateAIMini(symbol);
    }
}

function processHistory(symbol, history) {
    if (!history?.prices) return;
    if (!digitData[symbol])    digitData[symbol]    = { counts: new Array(10).fill(0), ticks: 0 };
    if (!marketMemory[symbol]) marketMemory[symbol] = { prices: [], digits: [], ticks: 0 };

    const d  = digitData[symbol];
    const mm = marketMemory[symbol];

    history.prices.forEach(price => {
        const digit = parseInt(price.toString().slice(-1));
        if (!isNaN(digit)) { d.counts[digit]++; mm.digits.push(digit); mm.prices.push(price); }
    });
    d.ticks = Math.min(d.ticks + history.prices.length, 1000);
    mm.ticks += history.prices.length;
    if (mm.prices.length > 500) { mm.prices = mm.prices.slice(-500); mm.digits = mm.digits.slice(-500); }

    log(`Loaded ${history.prices.length} ticks for ${MKT[symbol]||symbol}`, 'i');

    if (symbol === currentDigitMkt) { renderDigitCircles(symbol); updateDigitStats(symbol); }
    updateAIMini(symbol);
}

function subscribeDigitFeed(symbol) {
    if (!derivWS || derivWS.readyState !== WebSocket.OPEN) return;
    if (activeTickSubs.has(symbol)) return;

    // Fetch 500 real ticks first, then subscribe to live stream
    derivWS.send(JSON.stringify({
        ticks_history: symbol,
        adjust_start_time: 1,
        count: 500,
        end: "latest",
        style: "ticks",
        subscribe: 1
    }));
    activeTickSubs.add(symbol);
}

// ================================================================
// BOT LOGIC
// ================================================================
function toggleBot() {
    if (!derivWS || derivWS.readyState !== WebSocket.OPEN) {
        notify("Not Connected", "Please log in to your Deriv account first.", 'err');
        return;
    }
    if (!botDirection) {
        notify("No Direction", "Please select a trade direction first.", 'warn');
        return;
    }

    const btn = document.getElementById('run-btn');

    if (!isBotRunning) {
        // Pre-flight validation
        const err = validateBot();
        if (err) { notify("Cannot Start", err, 'err'); log("❌ " + err, 'x'); return; }

        isBotRunning = true;
        baseStake    = parseFloat(document.getElementById('bot-stake')?.value || 1);
        currentStake = baseStake;

        if (btn) { btn.textContent = '⬛ Stop'; btn.classList.remove('btn-run'); btn.classList.add('btn-stop'); }

        // Subscribe to bot market feed
        const mkt = document.getElementById('bot-market')?.value || 'R_10';
        subscribeDigitFeed(mkt);

        updateActiveBotName();
        updateInfoBar();
        log(`🟢 Bot started | ${MKT[mkt]||mkt} | ${document.getElementById('bot-type')?.value} | ${botDirection.toUpperCase()}`, 'i');
        log(`   Stake: $${currentStake.toFixed(2)} | TP: $${document.getElementById('bot-tp')?.value} | SL: $${document.getElementById('bot-sl')?.value}`, 'i');

        // Switch to transactions tab
        switchPanel('transactions', document.querySelectorAll('.panel-tab')[1]);

    } else {
        isBotRunning = false;
        pendingContract = false;
        lastContractId  = null;

        if (btn) { btn.textContent = '▶ Run'; btn.classList.remove('btn-stop'); btn.classList.add('btn-run'); }
        log("🔴 Bot stopped.", 'x');
    }

    updateBotBar();
}

function validateBot() {
    if (!derivWS || derivWS.readyState !== WebSocket.OPEN) return "API not connected.";
    if (!accountId) return "No trading account.";
    const stake = parseFloat(document.getElementById('bot-stake')?.value || 0);
    if (stake < 0.35) return `Stake $${stake.toFixed(2)} is below minimum $0.35.`;
    if (!document.getElementById('bot-market')?.value) return "No market selected.";
    if (!botDirection) return "No trade direction selected.";
    return null;
}

function runBotLogic(digit, quote) {
    if (!isBotRunning || pendingContract) return;

    const type = document.getElementById('bot-type')?.value || 'over_under';
    const pred = parseInt(document.getElementById('bot-pred')?.value || 5);

    let shouldTrade = false;

    switch(type) {
        case 'over_under':
            if (botDirection === 'over'  && digit > pred)  shouldTrade = true;
            if (botDirection === 'under' && digit < pred)  shouldTrade = true;
            break;
        case 'even_odd':
            if (botDirection === 'even' && digit % 2 === 0) shouldTrade = true;
            if (botDirection === 'odd'  && digit % 2 !== 0) shouldTrade = true;
            break;
        case 'rise_fall':
        case 'only_ups_downs':
            shouldTrade = true;
            break;
    }

    if (shouldTrade) {
        lastEntrySpot = quote;
        executeContract(quote);
    }
}

// ── STEP 1: Send proposal (Amy-verified flow) ──
function executeContract(entrySpot) {
    if (!isBotRunning || pendingContract) return;

    const market    = document.getElementById('bot-market')?.value || 'R_10';
    const type      = document.getElementById('bot-type')?.value   || 'over_under';
    const pred      = parseInt(document.getElementById('bot-pred')?.value || 5);
    const duration  = parseInt(document.getElementById('bot-dur')?.value  || 1);

    // Map to Deriv contract type
    const typeMap      = CONTRACT_MAP[type];
    const contractType = typeMap?.[botDirection];

    if (!contractType) {
        log(`❌ Invalid direction "${botDirection}" for type "${type}"`, 'x');
        return;
    }

    // Validate stake minimum
    if (currentStake < 0.35) {
        currentStake = 0.35;
        log(`⚠️ Stake adjusted to minimum $0.35`, 'x');
    }

    const isDigit    = ['DIGITEVEN','DIGITODD','DIGITOVER','DIGITUNDER','DIGITMATCH','DIGITDIFF'].includes(contractType);
    const isRiseFall = ['CALL','PUT'].includes(contractType);
    const isRunHL    = ['RUNHIGH','RUNLOW'].includes(contractType);

    // Build proposal — Amy confirmed: use underlying_symbol not symbol
    const proposal = {
        proposal:           1,
        amount:             parseFloat(currentStake.toFixed(2)),
        basis:              "stake",
        contract_type:      contractType,
        currency:           "USD",
        underlying_symbol:  market,
        req_id:             nextReqId()
    };

    // Duration rules per contract type
    if (isDigit) {
        proposal.duration      = Math.max(1, Math.min(10, duration));
        proposal.duration_unit = "t";
    } else if (isRunHL) {
        proposal.duration      = Math.max(2, Math.min(10, duration));
        proposal.duration_unit = "t";
    } else if (isRiseFall) {
        proposal.duration      = Math.max(1, duration);
        proposal.duration_unit = "m";
    }

    // Barrier for over/under
    if (type === 'over_under') {
        proposal.barrier = pred.toString();
    }

    pendingContract  = true;
    lastContractId   = "pending";
    lastEntrySpot    = entrySpot;

    log(`📋 Proposal: ${contractType} @ $${currentStake.toFixed(2)} | ${MKT[market]||market} | dur:${proposal.duration||'?'}${proposal.duration_unit||''}${proposal.barrier?' barrier:'+proposal.barrier:''}`, 'i');
    derivWS.send(JSON.stringify(proposal));
}

// ── STEP 2: Buy using proposal ID (Amy-verified flow) ──
function buyFromProposal(proposalId, askPrice) {
    if (!isBotRunning) return;

    const buyOrder = {
        buy:    proposalId,
        price:  parseFloat(askPrice.toFixed(2)),
        req_id: nextReqId()
    };

    log(`🎯 Buying proposal ${proposalId} @ $${askPrice.toFixed(2)}`, 'i');
    derivWS.send(JSON.stringify(buyOrder));
}

function handleBuyResponse(r) {
    if (r.error) {
        pendingContract = false;
        lastContractId  = null;
        const reason = r.error.message || 'Unknown error';
        const code   = r.error.code   || '';
        log(`❌ Buy rejected: ${reason} (${code})`, 'x');
        log(`   Market: ${document.getElementById('bot-market')?.value} | Type: ${document.getElementById('bot-type')?.value} | Dir: ${botDirection}`, 'x');
        // Only notify on first rejection per minute to avoid spam
        const nKey = `buy-err-${Math.floor(Date.now()/60000)}`;
        if (!seenSignals.has(nKey)) {
            seenSignals.add(nKey);
            notify("Trade Rejected", `${reason}`, 'err');
        }
    } else if (r.buy) {
        lastContractId = r.buy.contract_id;
        totalRuns++;
        log(`✅ Contract #${lastContractId} confirmed | Buy price: $${r.buy.buy_price}`, 'w');
        updateAllStats();
        // Subscribe to this contract for result
        derivWS.send(JSON.stringify({
            proposal_open_contract: 1,
            contract_id: lastContractId,
            subscribe: 1
        }));
    }
}

function handleContractResult(c) {
    if (!c) return;
    // Only process when contract is fully settled
    if (!c.is_sold && !c.is_expired) return;
    if (c.contract_id !== lastContractId) return;

    pendingContract = false;
    lastContractId  = null;

    const profit     = parseFloat(c.profit);
    const buyPrice   = parseFloat(c.buy_price || currentStake);
    const payout     = buyPrice + profit;
    const exitSpot   = c.exit_tick_display_value || c.entry_tick_display_value;
    const entrySpot2 = c.entry_tick_display_value || lastEntrySpot;

    totalStake  += buyPrice;
    totalPayout += Math.max(0, payout);
    totalPL     += profit;

    if (profit > 0) {
        try { winAudio.play(); } catch(e) {}
        totalWins++;
        currentStreak = currentStreak < 0 ? 1 : currentStreak + 1;
        log(`✅ WIN +$${profit.toFixed(2)} | Payout: $${payout.toFixed(2)}`, 'w');
        addTxRow(c.contract_type, entrySpot2, exitSpot, buyPrice, profit, true);
        // Reset stake on win
        currentStake = baseStake;

    } else {
        try { lossAudio.play(); } catch(e) {}
        totalLosses++;
        currentStreak = currentStreak > 0 ? -1 : currentStreak - 1;
        log(`❌ LOSS $${profit.toFixed(2)}`, 'l');
        addTxRow(c.contract_type, entrySpot2, exitSpot, buyPrice, profit, false);
        // Martingale
        const mg     = parseFloat(document.getElementById('bot-mg')?.value || 2.1);
        currentStake = parseFloat((currentStake * mg).toFixed(2));
        log(`📐 Martingale: next stake $${currentStake.toFixed(2)}`, 'x');
    }

    updateAllStats();
    checkThresholds();

    // AI auto-update after result
    if (aiAutoEnabled) {
        const mkt = document.getElementById('bot-market')?.value || 'R_10';
        const sig = generateSignal(mkt);
        if (sig && sig.confidence >= 70) {
            const oldDir = botDirection;
            botDirection = sig.botDirection;
            if (botDirection !== oldDir) {
                log(`🧠 AI updated direction: ${oldDir.toUpperCase()} → ${botDirection.toUpperCase()} (${sig.confidence}% confidence)`, 'i');
                renderDirButtons();
                updateInfoBar();
            }
        }
    }
}

// ================================================================
// TRANSACTION ROW — exactly like screenshot
// ================================================================
function addTxRow(contractType, entrySpot, exitSpot, stake, profit, isWin) {
    const container = document.getElementById('tx-list');
    if (!container) return;

    // Remove empty state
    const empty = container.querySelector('div[style*="text-align:center"]');
    if (empty) empty.remove();

    const icons = {
        DIGITOVER:'↑', DIGITUNDER:'↓', DIGITEVEN:'2x', DIGITODD:'!!',
        CALL:'📈', PUT:'📉', RUNHIGH:'↑↑', RUNLOW:'↓↓'
    };
    const icon    = icons[contractType] || '?';
    const payout  = stake + profit;
    const profitColor = isWin ? 'var(--green)' : 'var(--red)';

    const row = document.createElement('div');
    row.className = 'tx-row';
    row.innerHTML = `
        <div class="tx-type-icon" style="background:${isWin?'#00d79e18':'#ff444f18'};color:${isWin?'var(--green)':'var(--red)'};font-weight:900;font-size:14px;">
            ${icon}
        </div>
        <div class="tx-spots">
            <div class="tx-entry">
                <span class="spot-dot entry"></span>
                <span class="tx-price">${entrySpot || '—'}</span>
            </div>
            <div class="tx-exit">
                <span class="spot-dot exit"></span>
                <span class="tx-price" style="color:var(--muted);">${exitSpot || '—'}</span>
            </div>
        </div>
        <div class="tx-pnl">
            <div class="tx-stake">$${stake.toFixed(2)} USD</div>
            <div class="tx-profit ${isWin?'':'loss'}">${isWin?'+':''}$${profit.toFixed(2)} USD</div>
        </div>`;

    container.insertBefore(row, container.firstChild);
    if (container.children.length > 100) container.removeChild(container.lastChild);

    // Mirror to dashboard recent trades
    const rt = document.getElementById('recent-trades');
    if (rt) {
        const empty2 = rt.querySelector('[style*="text-align:center"]');
        if (empty2) empty2.remove();
        const r2 = document.createElement('div');
        r2.style.cssText = `display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:11px;`;
        r2.innerHTML = `<span style="color:var(--muted);">${contractType}</span><span style="color:${profitColor};font-weight:700;font-family:monospace;">${isWin?'+':''}$${profit.toFixed(2)}</span>`;
        rt.insertBefore(r2, rt.firstChild);
        if (rt.children.length > 6) rt.removeChild(rt.lastChild);
    }
}

function clearTransactions() {
    const c = document.getElementById('tx-list');
    if (c) c.innerHTML = '<div style="font-size:11px;color:var(--dim);text-align:center;padding:30px;">No transactions yet.</div>';
}

function downloadTransactions() {
    const rows = document.querySelectorAll('#tx-list .tx-row');
    let csv = 'Type,Entry,Exit,Stake,Profit\n';
    rows.forEach(r => {
        const prices = r.querySelectorAll('.tx-price');
        const stake  = r.querySelector('.tx-stake')?.textContent || '';
        const profit = r.querySelector('.tx-profit')?.textContent || '';
        csv += `${r.querySelector('.tx-type-icon')?.textContent?.trim()},${prices[0]?.textContent},${prices[1]?.textContent},${stake},${profit}\n`;
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type:'text/csv' }));
    a.download = `btraderhub_transactions_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
}

// ================================================================
// STATS UPDATE
// ================================================================
function updateAllStats() {
    const wr  = totalRuns > 0 ? ((totalWins / totalRuns) * 100).toFixed(1) : "0.0";
    const set = (id, val, col) => {
        const el = document.getElementById(id);
        if (el) { el.textContent = val; if (col) el.style.color = col; }
    };

    // Summary panel
    set('sum-wr',          `${wr}%`, parseFloat(wr) >= 50 ? 'var(--teal)' : 'var(--red)');
    set('sum-pl',          `${totalPL >= 0 ? '+' : ''}$${totalPL.toFixed(2)}`, totalPL >= 0 ? 'var(--green)' : 'var(--red)');
    set('sum-runs',        totalRuns);
    set('sum-wins',        totalWins);
    set('sum-losses',      totalLosses);
    set('sum-total-stake', `$${totalStake.toFixed(2)}`);
    set('sum-total-payout',`$${totalPayout.toFixed(2)}`, 'var(--green)');
    set('sum-no-runs',     totalRuns);
    set('sum-won2',        totalWins);
    set('sum-pl2',         `${totalPL >= 0 ? '+' : ''}$${totalPL.toFixed(2)}`, totalPL >= 0 ? 'var(--green)' : 'var(--red)');

    const wrBar = document.getElementById('sum-wr-bar');
    if (wrBar) wrBar.style.width = `${wr}%`;

    // Dashboard
    set('ds-runs', totalRuns);
    set('ds-wr',   `${wr}%`, parseFloat(wr) >= 50 ? 'var(--teal)' : 'var(--red)');
    set('ds-pl',   `$${totalPL.toFixed(2)}`, totalPL >= 0 ? 'var(--green)' : 'var(--red)');

    updateBotBar();
}

function checkThresholds() {
    const tp = parseFloat(document.getElementById('bot-tp')?.value || 0);
    const sl = parseFloat(document.getElementById('bot-sl')?.value || 0);
    if (tp > 0 && totalPL >= tp) {
        log(`🏆 Take Profit $${tp} hit! Stopping bot.`, 'w');
        notify("Take Profit Hit! 🏆", `Profit of $${tp} reached. Bot stopped.`, 'ok');
        toggleBot();
    } else if (sl > 0 && totalPL <= -sl) {
        log(`⚠️ Stop Loss $${sl} hit! Stopping bot.`, 'x');
        notify("Stop Loss Hit ⚠️", `Loss of $${sl} reached. Bot stopped.`, 'err');
        toggleBot();
    }
}

function updateBotBar() {
    const wr  = totalRuns > 0 ? ((totalWins / totalRuns) * 100).toFixed(1) : "0.0";
    const set = (id, val, col) => { const el = document.getElementById(id); if (el) { el.textContent = val; if (col) el.style.color = col; } };
    set('bar-bot',  document.getElementById('active-bot-name')?.textContent || '—');
    set('bar-runs', totalRuns);
    set('bar-pl',   `$${totalPL.toFixed(2)}`, totalPL >= 0 ? 'var(--green)' : 'var(--red)');
    set('bar-wr',   `${wr}%`);
    set('ds-bot',   document.getElementById('active-bot-name')?.textContent || 'None');
}

function updateActiveBotName() {
    const mkt  = MKT[document.getElementById('bot-market')?.value] || '—';
    const type = document.getElementById('bot-type')?.value?.replace(/_/g,' ') || '—';
    const name = `${mkt} · ${type} · ${botDirection?.toUpperCase() || '—'}`;
    const el   = document.getElementById('active-bot-name');
    if (el) el.textContent = name;
}

// ================================================================
// DIRECTION CONTROLS
// ================================================================
function onTypeChange() {
    const type = document.getElementById('bot-type')?.value || 'over_under';
    const wrap = document.getElementById('dir-controls');
    const pred = document.getElementById('pred-wrap');
    if (!wrap) return;

    wrap.innerHTML = '';

    const dirMap = {
        over_under:     [['over','Over Only'],['under','Under Only']],
        even_odd:       [['even','Even Only'],['odd','Odd Only']],
        rise_fall:      [['rise','Rise Only'],['fall','Fall Only']],
        only_ups_downs: [['ups','Only Ups'],['downs','Only Downs']]
    };

    const opts = dirMap[type] || [];
    opts.forEach(([val, label]) => {
        const btn = document.createElement('button');
        btn.className    = 'dir-btn';
        btn.textContent  = label;
        btn.dataset.dir  = val;
        btn.onclick      = () => selectDir(val);
        wrap.appendChild(btn);
    });

    // Show prediction for digit types
    if (pred) pred.style.display = ['over_under'].includes(type) ? 'block' : 'none';

    if (opts.length > 0) selectDir(opts[0][0]);
    updateInfoBar();
}

function selectDir(dir) {
    botDirection = dir;
    const neg = ['under','odd','fall','downs'];
    document.querySelectorAll('#dir-controls .dir-btn').forEach(b => {
        b.classList.remove('pos','neg');
        if (b.dataset.dir === dir) b.classList.add(neg.includes(dir) ? 'neg' : 'pos');
    });
    updateInfoBar();
}

function renderDirButtons() {
    // Re-render after AI update
    document.querySelectorAll('#dir-controls .dir-btn').forEach(b => {
        b.classList.remove('pos','neg');
        if (b.dataset.dir === botDirection) {
            b.classList.add(['under','odd','fall','downs'].includes(botDirection) ? 'neg' : 'pos');
        }
    });
}

function onMarketChange() {
    const mkt = document.getElementById('bot-market')?.value || 'R_10';
    subscribeDigitFeed(mkt);
    updateInfoBar();
    updateActiveBotName();
    // Update AI panel
    setTimeout(() => { updateAIMini(mkt); runAIScan(); }, 500);
}

function updateInfoBar() {
    const mkt  = document.getElementById('bot-market')?.value || '—';
    const type = document.getElementById('bot-type')?.value || '—';
    const set  = (id, val, col) => { const el=document.getElementById(id); if(el){el.textContent=val;if(col)el.style.color=col;} };
    set('info-market', MKT[mkt] || mkt);
    set('info-type',   type.replace(/_/g,' '));
    set('info-dir',    botDirection?.toUpperCase() || '—',
        ['under','odd','fall','downs'].includes(botDirection) ? 'var(--red)' : 'var(--teal)');
    set('info-stake',  `$${parseFloat(document.getElementById('bot-stake')?.value||1).toFixed(2)}`);
}

// ================================================================
// AI ENGINE — real data driven, realistic probability
// ================================================================
function generateSignal(symbol) {
    const data = digitData[symbol];
    const mm   = marketMemory[symbol];
    if (!data || data.ticks < 50) return null;

    const counts = data.counts;
    const total  = Math.max(data.ticks, 1);
    const ranked = counts.map((c,d) => ({d,c})).sort((a,b) => b.c - a.c);

    // Even/Odd ratio from real ticks
    const evenCount = counts.filter((_,i) => i%2===0).reduce((a,b)=>a+b,0);
    const overCount = counts.slice(5).reduce((a,b)=>a+b,0); // digits 5-9
    const evenPct   = (evenCount / total) * 100;
    const overPct   = (overCount / total) * 100;

    // Momentum from real price movement
    let momentum = 0;
    if (mm && mm.prices.length >= 20) {
        const recent = mm.prices.slice(-20);
        const rising = recent.filter((p,i) => i > 0 && p > recent[i-1]).length;
        momentum = ((rising / 19) - 0.5) * 2; // -1 to +1
    }

    // Consecutive digit pressure
    const consecBonus = Math.min(consecutiveSame * 2, 10);

    // Calculate signals
    let best = { confidence: 0 };

    // Even/Odd signal
    if (evenPct > 54) {
        const conf = Math.min(92, Math.round(evenPct + consecBonus * 0.3));
        if (conf > best.confidence) best = { type:'even_odd', botDirection:'even', direction:'Even Only', confidence:conf, reason:`Even digits ${evenPct.toFixed(1)}% of last ${total} ticks`, color:'var(--green)' };
    }
    if (evenPct < 46) {
        const conf = Math.min(92, Math.round((100-evenPct) + consecBonus * 0.3));
        if (conf > best.confidence) best = { type:'even_odd', botDirection:'odd', direction:'Odd Only', confidence:conf, reason:`Odd digits ${(100-evenPct).toFixed(1)}% of last ${total} ticks`, color:'var(--teal)' };
    }

    // Over/Under signal
    if (overPct > 54) {
        const conf = Math.min(90, Math.round(overPct + consecBonus * 0.2));
        if (conf > best.confidence) best = { type:'over_under', botDirection:'over', direction:'Over 4', confidence:conf, reason:`${overPct.toFixed(1)}% ticks landed digit 5+`, color:'var(--blue)' };
    }
    if (overPct < 46) {
        const conf = Math.min(90, Math.round((100-overPct) + consecBonus * 0.2));
        if (conf > best.confidence) best = { type:'over_under', botDirection:'under', direction:'Under 5', confidence:conf, reason:`${(100-overPct).toFixed(1)}% ticks landed digit 0-4`, color:'var(--purple)' };
    }

    // Rise/Fall from momentum
    if (Math.abs(momentum) > 0.3) {
        const dir  = momentum > 0 ? 'rise' : 'fall';
        const conf = Math.min(88, Math.round(55 + Math.abs(momentum) * 30));
        if (conf > best.confidence) best = { type:'rise_fall', botDirection:dir, direction:dir==='rise'?'Rise Only':'Fall Only', confidence:conf, reason:`Price momentum ${momentum>0?'bullish':'bearish'} (${(Math.abs(momentum)*100).toFixed(0)}%)`, color:momentum>0?'var(--green)':'var(--red)' };
    }

    best.symbol     = symbol;
    best.label      = MKT[symbol] || symbol;
    best.hotDigit   = ranked[0]?.d;
    best.coldDigit  = ranked[9]?.d;
    best.evenPct    = evenPct.toFixed(1);
    best.overPct    = overPct.toFixed(1);
    best.totalTicks = total;

    return best.confidence > 0 ? best : null;
}

function runAIScan() {
    const mkt = document.getElementById('bot-market')?.value || 'R_10';
    const sig = generateSignal(mkt);
    updateAIPanel(sig, mkt);
}

function startAILoop() {
    // Run AI analysis every 30 seconds
    setInterval(() => {
        if (!derivWS || derivWS.readyState !== WebSocket.OPEN) return;
        const mkt = document.getElementById('bot-market')?.value || 'R_10';
        const sig = generateSignal(mkt);
        updateAIPanel(sig, mkt);

        // If AI auto-update is on and bot is running, update direction
        if (aiAutoEnabled && isBotRunning && sig && sig.confidence >= 75) {
            const oldDir = botDirection;
            botDirection = sig.botDirection;
            if (botDirection !== oldDir) {
                log(`🧠 AI updated direction: ${oldDir.toUpperCase()} → ${botDirection.toUpperCase()} (${sig.confidence}% confidence)`, 'i');
                renderDirButtons();
                updateInfoBar();
            }
        }

        // Notify on strong signals
        if (sig && sig.confidence >= 80) {
            const key = `${mkt}-${sig.direction}-${Math.floor(Date.now()/60000)}`;
            if (!seenSignals.has(key)) {
                seenSignals.add(key);
                notify(`🧠 ${sig.label}`, `${sig.direction} | ${sig.confidence}% confidence\n${sig.reason}`, 'ok');
                addSignalHistory(sig);
            }
        }
    }, 30000);

    // Initial scan after 2 seconds
    setTimeout(runAIScan, 2000);
}

function updateAIPanel(sig, symbol) {
    const data = digitData[symbol] || { counts: new Array(10).fill(0), ticks: 0 };

    // Confidence meter
    const confVal = document.getElementById('ai-confidence-val');
    const confBar = document.getElementById('ai-conf-bar');
    const confLbl = document.getElementById('ai-conf-label');

    if (sig) {
        if (confVal) { confVal.textContent = `${sig.confidence}%`; confVal.style.color = sig.confidence >= 75 ? 'var(--teal)' : sig.confidence >= 60 ? 'var(--amber)' : 'var(--red)'; }
        if (confBar) { confBar.style.width = `${sig.confidence}%`; confBar.style.background = sig.confidence >= 75 ? 'var(--teal)' : sig.confidence >= 60 ? 'var(--amber)' : 'var(--red)'; }
        if (confLbl) confLbl.textContent = sig.confidence >= 75 ? 'High probability setup' : sig.confidence >= 60 ? 'Moderate setup' : 'Weak signal';

        const st = document.getElementById('ai-signal-text');
        const sd = document.getElementById('ai-signal-detail');
        if (st) { st.textContent = `${sig.direction}`; st.style.color = sig.color || 'var(--teal)'; }
        if (sd) sd.textContent = `${sig.reason} | Hot: ${sig.hotDigit} Cold: ${sig.coldDigit}`;
    } else {
        if (confVal) { confVal.textContent = `—%`; confVal.style.color = 'var(--muted)'; }
        if (confBar) confBar.style.width = '0%';
        if (confLbl) confLbl.textContent = data.ticks < 50 ? `Collecting data (${data.ticks}/50 ticks)...` : 'No strong signal';
        const st = document.getElementById('ai-signal-text');
        if (st) { st.textContent = 'No clear signal'; st.style.color = 'var(--muted)'; }
    }

    // Market state
    const state = classifyMarket(symbol);
    const ms    = document.getElementById('ai-market-state');
    const md    = document.getElementById('ai-market-detail');
    if (ms) ms.textContent = state.label;
    if (md) md.textContent = `${data.ticks} real ticks | Even: ${sig?.evenPct||'—'}% | Over: ${sig?.overPct||'—'}%`;

    // Update scanner tab too
    updateScannerResults();
}

function updateAIMini(symbol) {
    const data = digitData[symbol];
    if (!data) return;
    const counts = data.counts;
    const total  = Math.max(data.ticks, 1);
    const ranked = counts.map((c,d)=>({d,c})).sort((a,b)=>b.c-a.c);

    const el = document.getElementById('ai-digit-mini');
    if (!el) return;
    el.innerHTML = '';

    counts.forEach((count, digit) => {
        const pct  = ((count/total)*100).toFixed(0);
        const rank = ranked.findIndex(r => r.d === digit);
        const col  = rank===0?'var(--green)':rank===9?'var(--red)':'var(--muted)';
        const span = document.createElement('div');
        span.style.cssText = `text-align:center;width:22px;`;
        span.innerHTML = `<div style="font-size:9px;font-weight:700;color:${col};">${digit}</div><div style="font-size:8px;color:var(--dim);">${pct}%</div>`;
        el.appendChild(span);
    });
}

function classifyMarket(symbol) {
    const mm = marketMemory[symbol];
    if (!mm || mm.prices.length < 20) return { label: "Analyzing..." };

    const recent  = mm.prices.slice(-30);
    const rising  = recent.filter((p,i) => i>0 && p>recent[i-1]).length;
    const ratio   = rising / (recent.length - 1);
    const range   = Math.max(...recent) - Math.min(...recent);
    const avgP    = recent.reduce((a,b)=>a+b,0)/recent.length;
    const volatPct = (range/avgP) * 100;

    if (ratio > 0.68)  return { label:"📈 Strong Uptrend" };
    if (ratio > 0.57)  return { label:"↗ Uptrend" };
    if (ratio < 0.32)  return { label:"📉 Strong Downtrend" };
    if (ratio < 0.43)  return { label:"↘ Downtrend" };
    if (volatPct > 0.4)return { label:"⚡ High Volatility" };
    if (volatPct < 0.05)return { label:"😴 Low Volatility" };
    return { label:"➡ Sideways / Consolidating" };
}

function addSignalHistory(sig) {
    signalHistory.unshift(sig);
    if (signalHistory.length > 10) signalHistory.pop();

    const el = document.getElementById('ai-signal-history');
    if (!el) return;
    el.innerHTML = '';
    signalHistory.slice(0,5).forEach(s => {
        const row = document.createElement('div');
        row.style.cssText = 'background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:6px 8px;font-size:10px;';
        row.innerHTML = `<div style="display:flex;justify-content:space-between;"><span style="color:${s.color||'var(--teal)'};font-weight:700;">${s.direction}</span><span class="badge badge-teal">${s.confidence}%</span></div><div style="color:var(--muted);margin-top:2px;">${s.label}</div>`;
        el.appendChild(row);
    });
}

// ================================================================
// AI SCANNER TAB — all markets
// ================================================================
function runFullScan() {
    const container = document.getElementById('scan-results');
    const bestBox   = document.getElementById('best-signal-content');
    if (!container) return;

    // Subscribe to all markets for data
    ALL_MKTS.forEach(sym => subscribeDigitFeed(sym));

    const results = ALL_MKTS.map(sym => ({
        sym,
        signal: generateSignal(sym),
        data:   digitData[sym] || { ticks: 0 },
        state:  classifyMarket(sym)
    })).sort((a,b) => (b.signal?.confidence||0) - (a.signal?.confidence||0));

    // Best opportunity
    const best = results[0];
    if (bestBox) {
        if (best.signal && best.signal.confidence > 0) {
            bestBox.innerHTML = `
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                    <span style="font-size:14px;font-weight:900;color:var(--text);">${best.signal.label}</span>
                    <span class="badge badge-teal">${best.signal.confidence}% Win Probability</span>
                </div>
                <div style="font-size:16px;font-weight:900;color:${best.signal.color||'var(--teal)'};margin-bottom:6px;">${best.signal.direction}</div>
                <div style="font-size:11px;color:var(--muted);">${best.signal.reason}</div>
                <div style="font-size:11px;color:var(--muted);margin-top:4px;">State: ${best.state.label} | ${best.signal.totalTicks} real ticks | Hot: ${best.signal.hotDigit} | Cold: ${best.signal.coldDigit}</div>
                <button onclick="applyBestSignal()" class="btn btn-teal" style="margin-top:10px;padding:7px 16px;font-size:11px;">✅ Apply to Bot</button>`;
        } else {
            bestBox.innerHTML = '<div style="color:var(--muted);font-size:12px;">Not enough data yet. Markets are loading tick history...</div>';
        }
    }

    // All results grid
    container.innerHTML = '';
    results.forEach((r, idx) => {
        const sig   = r.signal;
        const color = sig ? (sig.color || 'var(--teal)') : 'var(--border)';
        const card  = document.createElement('div');
        card.className = 'scanner-signal' + (sig && sig.confidence >= 75 ? ' strong' : sig && sig.confidence >= 60 ? ' medium' : '');
        card.style.borderColor = color;
        card.style.cursor = 'pointer';
        card.onclick = () => {
            if (sig) applySignalToBot(sig);
        };
        card.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
                <div style="display:flex;align-items:center;gap:5px;">
                    <span>${idx===0?'🥇':idx===1?'🥈':idx===2?'🥉':'📊'}</span>
                    <span style="font-size:12px;font-weight:900;">${MKT[r.sym]||r.sym}</span>
                </div>
                ${sig ? `<span class="badge badge-teal">${sig.confidence}%</span>` : ''}
            </div>
            <div style="font-size:13px;font-weight:900;color:${color};margin-bottom:4px;">${sig ? sig.direction : 'No clear signal'}</div>
            <div style="font-size:10px;color:var(--muted);">${r.state.label}</div>
            <div style="font-size:9px;color:var(--dim);margin-top:3px;">${r.data.ticks} ticks${sig?` | ${sig.reason}`:''}</div>`;
        container.appendChild(card);
    });
}

function applyBestSignal() {
    const results = ALL_MKTS.map(sym => ({
        sym, signal: generateSignal(sym)
    })).sort((a,b) => (b.signal?.confidence||0) - (a.signal?.confidence||0));
    if (results[0]?.signal) applySignalToBot(results[0].signal);
}

function applySignalToBot(sig) {
    if (!sig) return;

    // Update bot settings to match signal
    const mktSel  = document.getElementById('bot-market');
    const typeSel = document.getElementById('bot-type');
    if (mktSel)  mktSel.value  = sig.symbol;
    if (typeSel) { typeSel.value = sig.type; onTypeChange(); }
    selectDir(sig.botDirection);

    updateInfoBar();
    updateActiveBotName();
    log(`🧠 AI applied signal: ${sig.label} | ${sig.direction} | ${sig.confidence}% confidence`, 'i');
    notify("AI Signal Applied ✅", `${sig.label}\n${sig.direction} — ${sig.confidence}% win probability`, 'ok');
    switchTab('bot');
}

function updateScannerResults() {
    // Lightweight update of scan results if scanner tab active
    const container = document.getElementById('scan-results');
    if (!container || !container.children.length) return;
    // Full refresh
    runFullScan();
}

// ================================================================
// AI AUTO TOGGLE
// ================================================================
function toggleAIAuto() {
    aiAutoEnabled = !aiAutoEnabled;
    const track = document.getElementById('ai-toggle-track');
    const thumb = document.getElementById('ai-toggle-thumb');
    const badge = document.getElementById('ai-status-badge');
    if (track) track.style.background = aiAutoEnabled ? 'var(--teal)' : 'var(--border)';
    if (thumb) thumb.style.left       = aiAutoEnabled ? '18px' : '3px';
    if (badge) { badge.textContent    = aiAutoEnabled ? '🧠 AI Active' : '🧠 AI Off'; badge.className = aiAutoEnabled ? 'badge badge-teal' : 'badge badge-amber'; }
    log(`🧠 AI Auto-Update: ${aiAutoEnabled ? 'ON' : 'OFF'}`, 'i');
}

// ================================================================
// DIGIT STATS TAB
// ================================================================
function changeDigitMarket(symbol) {
    currentDigitMkt = symbol;
    subscribeDigitFeed(symbol);
    const data = digitData[symbol];
    if (data && data.ticks > 0) {
        renderDigitCircles(symbol);
        updateDigitStats(symbol);
    } else {
        const c = document.getElementById('d-circles');
        if (c) c.innerHTML = '<div style="font-size:11px;color:var(--dim);padding:10px;">Loading real tick data...</div>';
    }
}

function renderDigitCircles(symbol) {
    const circlesEl = document.getElementById('d-circles');
    const barsEl    = document.getElementById('d-bars');
    if (!circlesEl) return;

    const data   = digitData[symbol] || { counts: new Array(10).fill(0), ticks: 0 };
    const counts = data.counts;
    const total  = Math.max(data.ticks, 1);
    const pred   = parseInt(document.getElementById('bot-pred')?.value ?? -1);
    const ranked = counts.map((c,d) => ({d,c})).sort((a,b) => b.c - a.c);

    circlesEl.innerHTML = '';
    if (barsEl) barsEl.innerHTML = '';

    counts.forEach((count, digit) => {
        const rank = ranked.findIndex(r => r.d === digit);
        const pct  = ((count / total) * 100).toFixed(1);

        let cls = '';
        if (rank === 0) cls = 'r0';
        else if (rank === 1) cls = 'r1';
        else if (rank === 8) cls = 'r8';
        else if (rank === 9) cls = 'r9';

        const circle = document.createElement('div');
        circle.className = `d-circle ${cls} ${digit === pred ? 'pred' : ''}`;
        circle.title     = `Digit ${digit}: ${count} times (${pct}% of ${total} ticks)`;
        circle.onclick   = () => {
            const p = document.getElementById('bot-pred');
            if (p) { p.value = digit; renderDigitCircles(symbol); log(`Prediction set to: ${digit}`, 'i'); }
        };
        circle.innerHTML = `
            <span style="font-size:19px;font-weight:900;line-height:1;">${digit}</span>
            <span style="font-size:9px;opacity:.8;">${pct}%</span>
            <span style="font-size:8px;color:rgba(255,255,255,.4);">${count}</span>`;
        circlesEl.appendChild(circle);

        // Bar
        if (barsEl) {
            const col  = cls==='r0'?'var(--teal)':cls==='r9'?'var(--red)':'var(--muted)';
            const row  = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:10px;';
            row.innerHTML = `
                <span style="width:14px;text-align:right;font-weight:900;">${digit}</span>
                <div style="flex:1;height:5px;background:var(--border);border-radius:2px;">
                    <div style="height:100%;border-radius:2px;background:${col};width:${pct}%;transition:width .5s;"></div>
                </div>
                <span style="width:36px;text-align:right;font-family:monospace;color:var(--muted);">${pct}%</span>
                <span style="width:28px;text-align:right;font-family:monospace;color:var(--dim);">${count}</span>`;
            barsEl.appendChild(row);
        }
    });

    // Update hot/cold
    const set = (id,v) => { const el=document.getElementById(id); if(el) el.textContent=v; };
    set('d-hot',  ranked[0]?.d ?? '—');
    set('d-cold', ranked[9]?.d ?? '—');
}

function updateDigitStats(symbol) {
    const data   = digitData[symbol] || { counts: new Array(10).fill(0), ticks: 0 };
    const counts = data.counts;
    const total  = Math.max(data.ticks, 1);
    const even   = counts.filter((_,i) => i%2===0).reduce((a,b)=>a+b,0);
    const over   = counts.slice(5).reduce((a,b)=>a+b,0);
    const set    = (id,v) => { const el=document.getElementById(id); if(el) el.textContent=v; };
    set('d-even', `${((even/total)*100).toFixed(1)}%`);
    set('d-over', `${((over/total)*100).toFixed(1)}%`);
}

// ================================================================
// CHART TAB
// ================================================================
function loadChart(sym) {
    const f = document.getElementById('chart-frame');
    if (f) f.src = `https://charts.deriv.com/?symbol=${sym}&granularity=60`;
}

// ================================================================
// CONNECTION STATUS
// ================================================================
function updateConnStatus(on) {
    ['status-dot','bar-dot'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.classList.toggle('live', on); }
    });
    ['status-text','bar-status'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.textContent = on ? 'LIVE' : 'OFFLINE'; el.style.color = on ? 'var(--teal)' : 'var(--muted)'; }
    });
}

// ================================================================
// UI HELPERS
// ================================================================
function showStatus(msg, type) {
    const el = document.getElementById('conn-status');
    if (!el) return;
    const colors = { info:'var(--blue)', ok:'var(--teal)', err:'var(--red)' };
    const c = colors[type] || 'var(--muted)';
    el.style.cssText = `display:block;border-color:${c};color:${c};background:${c}14;font-size:11px;padding:10px;border-radius:8px;border:1px solid;margin-top:12px;`;
    el.textContent = msg;
}

function notify(title, body, type = 'info') {
    const container = document.getElementById('notif-wrap');
    if (!container) return;
    const colors = { ok:'var(--teal)', err:'var(--red)', warn:'var(--amber)', info:'var(--blue)' };
    const color  = colors[type] || 'var(--teal)';
    const notif  = document.createElement('div');
    notif.className = `notif ${type==='err'?'err':type==='warn'?'warn':''}`;
    notif.style.borderColor = color;
    notif.innerHTML = `
        <div style="display:flex;justify-content:space-between;gap:8px;">
            <div>
                <div style="font-size:12px;font-weight:900;color:${color};margin-bottom:4px;">${title}</div>
                <div style="font-size:10px;color:var(--muted);white-space:pre-line;line-height:1.4;">${body}</div>
            </div>
            <button onclick="this.parentElement.parentElement.remove()" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:14px;padding:0;flex-shrink:0;">✕</button>
        </div>`;
    container.appendChild(notif);
    setTimeout(() => { try { notif.remove(); } catch(e){} }, 8000);
}

function log(text, type='d') {
    const container = document.getElementById('journal-log');
    if (!container) return;
    const line = document.createElement('div');
    line.className = `jline ${type}`;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
    container.appendChild(line);
    container.scrollTop = container.scrollHeight;
    if (container.children.length > 500) container.removeChild(container.firstChild);
}

function clearJournal() {
    const el = document.getElementById('journal-log');
    if (el) el.innerHTML = '<div class="jline d">[Cleared]</div>';
}