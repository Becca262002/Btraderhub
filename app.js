// ================================================================
// BTRADERHUB app.js — Clean Focused Build
// Auth: Amy-verified PKCE (DO NOT CHANGE)
// ================================================================

const DERIV_CLIENT_ID = "33ByqD0GecGTE5whirko8";
const DERIV_APP_ID    = "33ByqD0GecGTE5whirko8";
// Auto-detect domain — works for both btraderhub.com AND btraderhub.vercel.app
// Both must be registered as redirect URIs in your Deriv app dashboard
const DERIV_REDIRECT = (
    window.location.hostname === 'btraderhub.com' ||
    window.location.hostname === 'www.btraderhub.com'
) ? 'https://btraderhub.com/' : 'https://btraderhub.vercel.app/';

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

// Audio — coins for win, cash register ding, realistic loss sound
const winAudio  = new Audio('https://assets.mixkit.co/active_storage/sfx/2000/2000-preview.mp3'); // coins
const lossAudio = new Audio('https://assets.mixkit.co/active_storage/sfx/2955/2955-preview.mp3'); // fail thud

// Preload
winAudio.volume  = 0.7;
lossAudio.volume = 0.6;
winAudio.load();
lossAudio.load();

function playWin() {
    try {
        winAudio.currentTime = 0;
        winAudio.play().catch(() => {
            // Fallback: Web Audio API coin sound
            playCoinSound();
        });
    } catch(e) { playCoinSound(); }
}

function playLoss() {
    try {
        lossAudio.currentTime = 0;
        lossAudio.play().catch(() => {
            playLossSound();
        });
    } catch(e) { playLossSound(); }
}

// Web Audio API fallback — coin jingle
function playCoinSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        // Play 3 quick coin pings
        [0, 0.08, 0.16].forEach((delay, i) => {
            const osc  = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type      = 'sine';
            osc.frequency.setValueAtTime(880 + (i * 220), ctx.currentTime + delay);
            osc.frequency.exponentialRampToValueAtTime(1200 + (i * 200), ctx.currentTime + delay + 0.1);
            gain.gain.setValueAtTime(0.4, ctx.currentTime + delay);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.2);
            osc.start(ctx.currentTime + delay);
            osc.stop(ctx.currentTime + delay + 0.2);
        });
    } catch(e) {}
}

// Web Audio API fallback — dull thud for loss
function playLossSound() {
    try {
        const ctx  = new (window.AudioContext || window.webkitAudioContext)();
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(150, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(60, ctx.currentTime + 0.3);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.4);
    } catch(e) {}
}

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
let pendingProposalId    = null;
let pendingProposalPrice = null;
let reqIdCounter         = 1;
function nextReqId() { return ++reqIdCounter; }

// Pip sizes per symbol — populated from active_symbols
let activePipSizes = {};

// Session tracking — resets on each "Reset & Continue"
let sessionBasePL = 0; // PL at the start of current session

// Smart Recovery System
// Tracks consecutive losses and switches to high-probability recovery trade
let consecutiveLosses  = 0;
let isInRecoveryMode   = false;
let originalDirection  = null;  // what user originally set
let originalPrediction = null;  // what user originally set
const RECOVERY_TRIGGER = 2;     // losses before switching to recovery
// Recovery map: if trading Over X, recover with Under (9-X) and vice versa
// e.g. Over 1 → recover with Under 8 | Over 2 → recover with Under 7
function getRecoveryTrade(direction, pred) {
    if (direction === 'over') {
        // Recovery: switch to Under (9 - pred) for high win probability
        const recoveryPred = Math.min(9, Math.max(5, 9 - pred));
        return { direction: 'under', pred: recoveryPred };
    } else if (direction === 'under') {
        // Recovery: switch to Over (9 - pred) for high win probability
        const recoveryPred = Math.max(0, Math.min(4, 9 - pred));
        return { direction: 'over', pred: recoveryPred };
    }
    return null;
}

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

    // Start public WebSocket for digit stats
    connectPublicWS();

    const params     = new URLSearchParams(window.location.search);
    const code       = params.get('code');
    const oauthState = params.get('state');

    if (code && oauthState) {
        // Fresh OAuth callback
        try { window.history.replaceState({}, document.title, window.location.pathname); } catch(e) {}
        await handleOAuthCallback(code, oauthState);

    } else {
        // Check for token set by callback.html
        const cbToken = sessionStorage.getItem('deriv_access_token');
        if (cbToken) {
            sessionStorage.removeItem('deriv_access_token');
            sessionStorage.removeItem('deriv_token_expiry');
            accessToken = cbToken;
            showStatus("Connecting...", 'info');
            await loadAccounts();

        } else {
            // Auto-reconnect from saved token (stays logged in for 30 days)
            const savedToken     = localStorage.getItem('bth_access_token');
            const savedAccountId = localStorage.getItem('bth_account_id');
            const connectedAt    = parseInt(localStorage.getItem('bth_connected_at') || '0');
            const ageHours       = (Date.now() - connectedAt) / 3600000;

            if (savedToken && ageHours < 720) {
                accessToken = savedToken;
                if (savedAccountId) accountId = savedAccountId;
                showStatus("Reconnecting to your account...", 'info');
                log("🔄 Auto-reconnecting from saved session...", 'i');
                await loadAccounts();
            }
        }
    }

    // Show risk disclaimer on first visit
    if (!localStorage.getItem('risk-accepted')) {
        setTimeout(() => {
            showLegal('risk');
            const origClose = window.closeLegal;
            window.closeLegal = function() {
                localStorage.setItem('risk-accepted', '1');
                origClose();
                window.closeLegal = origClose;
            };
        }, 1500);
    }
});;

// ================================================================
// TAB & PANEL NAVIGATION
// ================================================================
// Mobile bot settings panel toggle
function toggleMobileBotSettings() {
    const sidebar = document.querySelector('#bot-pane .sidebar');
    const btn     = document.getElementById('mobile-bot-settings-btn');
    if (!sidebar) return;
    const isOpen = sidebar.classList.contains('mobile-open');
    if (isOpen) {
        sidebar.classList.remove('mobile-open');
        if (btn) btn.textContent = '⚙️ Bot Settings';
    } else {
        sidebar.classList.add('mobile-open');
        if (btn) btn.textContent = '✕ Close Settings';
        // Scroll to top of settings
        sidebar.scrollTop = 0;
    }
}

// Auto-close settings panel when bot starts running on mobile
function closeMobileBotSettings() {
    const sidebar = document.querySelector('#bot-pane .sidebar');
    const btn     = document.getElementById('mobile-bot-settings-btn');
    if (sidebar) sidebar.classList.remove('mobile-open');
    if (btn) btn.textContent = '⚙️ Bot Settings';
}

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
    if (id === 'mt5')     { connectMT5Feed(); setTimeout(renderMT5Signals, 800); }
    if (id === 'chart')   { setTimeout(() => updateChartIndicators(), 500); }
    if (id === 'accu')    { onAccuMarketChange(document.getElementById('accu-market')?.value || 'R_10'); updateAccuProfitCalc(); }
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
    const loginBtn = document.getElementById('btn-login');
    if (loginBtn) { loginBtn.textContent = 'Connecting...'; loginBtn.disabled = true; }
    showStatus("Starting secure login...", 'info');

    try {
        // Call server to generate PKCE — no browser storage needed (Amy's fix)
        const resp = await fetch('/api/oauth-start', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!resp.ok) {
            const err = await resp.text();
            showStatus("Login server error. Please try again.", 'err');
            console.error('oauth-start failed:', resp.status, err);
            if (loginBtn) { loginBtn.textContent = 'Log in'; loginBtn.disabled = false; }
            return;
        }

        const cfg = await resp.json();

        if (!cfg.state || !cfg.code_challenge) {
            showStatus("Invalid server response. Please try again.", 'err');
            if (loginBtn) { loginBtn.textContent = 'Log in'; loginBtn.disabled = false; }
            return;
        }

        // Build auth URL with server-generated values
        const params = new URLSearchParams({
            response_type:         'code',
            client_id:             cfg.client_id,
            redirect_uri:          cfg.redirect_uri,
            scope:                 cfg.scope,
            state:                 cfg.state,
            code_challenge:        cfg.code_challenge,
            code_challenge_method: cfg.code_challenge_method
        });

        const authUrl = `${cfg.authorization_endpoint}?${params.toString()}`;
        console.log('Redirecting to:', authUrl.substring(0, 80) + '...');

        // Force open in browser tab — prevents Deriv app from intercepting on mobile
        // Using window.open with _blank forces browser, not installed app
        const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
        if (isMobile) {
            // On mobile, open in same tab but with a small delay to prevent app interception
            setTimeout(() => {
                window.location.href = authUrl;
            }, 100);
        } else {
            window.location.replace(authUrl);
        }

    } catch(err) {
        showStatus("Network error. Please check your connection.", 'err');
        console.error('loginWithDeriv error:', err);
        if (loginBtn) { loginBtn.textContent = 'Log in'; loginBtn.disabled = false; }
    }
}


function signUpWithDeriv() {
    window.location.href = "https://track.deriv.com/_Yi8lkjLk8sFMjdsyM5hasGNd7ZgqdRLk/1/";
}

// ================================================================
// AUTH — STEP 2: Callback
// ================================================================
async function handleOAuthCallback(code, oauthState) {
    // Read from localStorage, sessionStorage, or cookie — whichever has the value
    function readAndClear(key) {
        let val = null;
        try { val = localStorage.getItem(key); localStorage.removeItem(key); } catch(e) {}
        if (!val) { try { val = sessionStorage.getItem(key); sessionStorage.removeItem(key); } catch(e) {} }
        if (!val) {
            // Try cookie fallback
            const cookieKey = key === 'oauth_state' ? 'pkce_st' : 'pkce_cv';
            const match = document.cookie.match(new RegExp(cookieKey + '=([^;]+)'));
            if (match) { val = decodeURIComponent(match[1]); document.cookie = `${cookieKey}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`; }
        }
        return val;
    }
    const savedState    = readAndClear('oauth_state');
    const code_verifier = readAndClear('pkce_code_verifier');

    if (oauthState !== savedState) {
        if (!savedState) {
            // Storage was fully cleared during redirect (common on mobile)
            // Continue anyway — the code itself is single-use so still secure
            log('PKCE state not found in storage — proceeding without state check', 'x');
        } else {
            // Real mismatch — reject
            showStatus("Security error. Please click Log in again.", 'err');
            return;
        }
    }
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

        // Real account appears first — then demo
        const real = allAccounts.find(a => a.account_type === 'real');
        const demo = allAccounts.find(a => a.account_type === 'demo');
        const preferred = real || demo || allAccounts[0];
        accountId  = preferred.account_id;
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
    localStorage.setItem('bth_account_id', newId);
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
            clearInterval(pingInterval);
            log("WS closed. Will reconnect...", 'x');
            // If Auto Mode was running, pause it (do not lose settings) and notify —
            // per spec, connection loss should stop Auto Mode automatically.
            if (accuAutoEnabled) {
                stopAccuAuto('connection_lost');
            }
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
    // Save token to localStorage so user stays logged in
    if (accessToken) {
        localStorage.setItem('bth_access_token', accessToken);
        localStorage.setItem('bth_account_id',   accountId || '');
        localStorage.setItem('bth_connected_at',  Date.now().toString());
    }

    // Hide login/signup buttons, show account UI
    const btnLogin  = document.getElementById('btn-login');
    const btnSignup = document.getElementById('btn-signup');
    if (btnLogin)  { btnLogin.style.display  = 'none'; }
    if (btnSignup) { btnSignup.style.display = 'none'; }

    const aw = document.getElementById('acct-wrap');
    if (aw) aw.style.display = 'flex';

    const authCard = document.getElementById('auth-card');
    if (authCard) authCard.style.display = 'none';

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

    // Digit stats run on public WS (already started on page load)
    // Ensure public WS is connected
    if (!publicWsReady) connectPublicWS();

    // Start AI scan loop
    startAILoop();
    startKeepAlivePing();
    log("✅ Connected to Deriv API", 'i');
}

// Keep-alive ping — Amy's recommendation to prevent silent disconnects
let pingInterval = null;
function startKeepAlivePing() {
    clearInterval(pingInterval);
    pingInterval = setInterval(() => {
        if (derivWS && derivWS.readyState === WebSocket.OPEN) {
            derivWS.send(JSON.stringify({ ping: 1, req_id: nextReqId() }));
        }
    }, 30000);
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

    // Tick and history from authenticated WS — routed to stub
    // (real digit data comes from public WS)
    if (r.msg_type === 'tick' && r.tick) {
        processRealTick(r.tick.symbol, r.tick.quote);
    }
    if (r.msg_type === 'history' && r.history) {
        const sym = r.echo_req?.ticks_history;
        if (sym) processHistory(sym, r.history);
    }

    // Active symbols — store pip sizes per Amy's tip for correct last digit
    if (r.msg_type === 'active_symbols' && r.active_symbols) {
        const synthetics = r.active_symbols.filter(s =>
            s.market === 'synthetic_index'
        );
        synthetics.forEach(s => {
            if (s.pip) activePipSizes[s.symbol] = s.pip;
        });
        log(`📡 ${synthetics.length} synthetic markets loaded | pip sizes stored`, 'i');
    }

    // STEP 2: Proposal response — extract ID and ask_price, then buy
    if (r.msg_type === 'proposal') {
        clearProposalTimeout();
        if (r.error) {
            pendingContract = false;
            lastContractId  = null;
            log(`❌ Proposal rejected: ${r.error.message}`, 'x');
            log(`   Code: ${r.error.code} | Check market symbol and contract params`, 'x');
            // If accumulator proposal failed
            if (accuRunning) {
                accuRunning = false;
                notify("Accumulator Error", r.error.message, 'err');
                resetAccuUI();
                // Don't silently keep retrying auto mode against a rejected proposal —
                // stop it and surface the error instead of looping forever.
                if (accuAutoEnabled) stopAccuAuto('api_error');
            }
        } else if (r.proposal) {
            // Accumulator proposal — buy immediately
            if (r.proposal.contract_type === 'ACCU' || accuRunning) {
                const proposalId = r.proposal.id;
                const askPrice   = r.proposal.ask_price;
                log(`📈 Accumulator proposal: ${proposalId} | Ask: $${askPrice}`, 'i');
                derivWS.send(JSON.stringify({ buy: proposalId, price: parseFloat(askPrice), req_id: nextReqId() }));
            } else if (isBotRunning) {
                // Regular bot proposal
                const proposalId = r.proposal.id;
                const askPrice   = r.proposal.ask_price;
                log(`✅ Proposal: ${proposalId} | Ask: $${askPrice}`, 'i');
                buyFromProposal(proposalId, parseFloat(askPrice));
            }
        }
    }

    // STEP 3: Buy response
    if (r.msg_type === 'buy') handleBuyResponse(r);

    // Sell response (for accumulator manual sell)
    if (r.msg_type === 'sell') {
        if (r.error) {
            log(`❌ Sell error: ${r.error.message}`, 'x');
        } else {
            log(`✅ Contract sold | Price: $${r.sell?.sold_for || '—'}`, 'w');
        }
    }

    // Contract update/settlement
    if (r.msg_type === 'proposal_open_contract' && r.proposal_open_contract) {
        const c = r.proposal_open_contract;
        // Full debug log on settlement — logs ALL fields so we can see what Deriv sends
        if (c.is_sold || c.is_expired) {
            const debugFields = {
                entry_tick:          c.entry_tick,
                entry_tick_display:  c.entry_tick_display_value,
                entry_spot:          c.entry_spot,
                entry_spot_display:  c.entry_spot_display_value,
                exit_tick:           c.exit_tick,
                exit_tick_display:   c.exit_tick_display_value,
                exit_spot:           c.exit_spot,
                exit_spot_display:   c.exit_spot_display_value,
                sell_spot:           c.sell_spot,
                sell_spot_display:   c.sell_spot_display_value,
                sell_price:          c.sell_price,
            };
            // Log only fields that have values
            const found = Object.entries(debugFields)
                .filter(([k,v]) => v !== undefined && v !== null && v !== '')
                .map(([k,v]) => `${k}=${v}`)
                .join(' | ');
            log(`📋 Spots: ${found || 'NO SPOT FIELDS FOUND'}`, 'd');
        }
        // Route to accumulator handler or bot handler
        if (c.contract_type === 'ACCU' || (accuContractId && c.contract_id === accuContractId)) {
            accuContractId = c.contract_id;
            handleAccuContractUpdate(c);
        } else {
            handleContractResult(c);
        }
    }
}

// ================================================================
// REAL TICK PROCESSING — no fake data ever
// ================================================================
// ================================================================
// DIGIT STATS — Amy's verified implementation (public WS)
// Uses separate public WebSocket for market data
// OTP authenticated WS used only for trading
// ================================================================

const ROLLING_WINDOW = 1000;
const PUBLIC_WS_URL  = 'wss://api.derivws.com/trading/v1/options/ws/public';

let publicWS      = null;
let publicWsReady = false;
let pubNextId     = 1;
function pubReqId() { return pubNextId++; }

// Amy's exact extractLastDigit — normalizes by decimals from pip_size
function extractLastDigit(quote, decimals) {
    const s = Number(quote).toFixed(decimals || 0);
    for (let i = s.length - 1; i >= 0; i--) {
        const ch = s[i];
        if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
    }
    return NaN;
}

// Amy's addDigit — exact rolling window implementation
function addDigitToRolling(sym, d) {
    if (!digitData[sym]) {
        digitData[sym] = { window: [], counts: Array(10).fill(0), ticks: 0, decimals: 2 };
    }
    const st = digitData[sym];
    st.window.push(d);
    st.counts[d]++;
    if (st.window.length > ROLLING_WINDOW) {
        const removed = st.window.shift();
        st.counts[removed]--;
    }
    st.ticks = st.window.length;
}

// Connect to public WebSocket for digit stats (separate from trading WS)
function connectPublicWS() {
    if (publicWS && publicWS.readyState === WebSocket.OPEN) return;

    publicWS = new WebSocket(PUBLIC_WS_URL);

    publicWS.onopen = () => {
        publicWsReady = true;
        log('📡 Public WS connected for digit stats', 'i');

        // Step 1: Get active_symbols to read pip_size per symbol
        publicWS.send(JSON.stringify({
            active_symbols: 'brief',
            req_id: pubReqId()
        }));

        // Keep-alive ping every 30s
        setInterval(() => {
            if (publicWS && publicWS.readyState === WebSocket.OPEN) {
                publicWS.send(JSON.stringify({ ping: 1 }));
            }
        }, 30000);
    };

    publicWS.onmessage = (ev) => {
        const data = JSON.parse(ev.data);
        if (data.error) {
            log(`📡 Public WS error: ${data.error.code} ${data.error.message}`, 'x');
            return;
        }

        // Step 2: active_symbols — read pip_size and seed each symbol
        if (data.msg_type === 'active_symbols') {
            const bySymbol = {};
            (data.active_symbols || []).forEach(s => {
                if (ALL_MKTS.includes(s.underlying_symbol)) {
                    bySymbol[s.underlying_symbol] = s;
                }
            });

            ALL_MKTS.forEach(sym => {
                const info = bySymbol[sym];
                if (!info) return;

                const pipSize  = info.pip_size;
                const decimals = String(pipSize).includes('.')
                    ? String(pipSize).split('.')[1].length
                    : 0;

                // Initialize with correct decimals from Deriv
                digitData[sym] = {
                    window:   [],
                    counts:   Array(10).fill(0),
                    ticks:    0,
                    decimals: decimals
                };
                activePipSizes[sym] = pipSize;

                // Step 3: Warm up with ticks_history (1000 ticks)
                publicWS.send(JSON.stringify({
                    ticks_history: sym,
                    end:           'latest',
                    count:         ROLLING_WINDOW,
                    style:         'ticks',
                    req_id:        pubReqId()
                }));
            });
            return;
        }

        // Step 4: History response — seed rolling window
        if (data.msg_type === 'history' && data.history) {
            const sym = data.echo_req?.ticks_history;
            if (!sym || !digitData[sym]) return;

            const st     = digitData[sym];
            const quotes = data.history.prices || [];

            // Reset and rebuild from history using pip_size decimals
            st.window = [];
            st.counts = Array(10).fill(0);

            quotes.forEach(price => {
                const d = extractLastDigit(price, st.decimals);
                if (!isNaN(d)) addDigitToRolling(sym, d);
            });

            log(`📊 ${MKT[sym]||sym}: ${st.ticks} ticks seeded`, 'i');

            // Step 5: Subscribe to live ticks after warmup
            publicWS.send(JSON.stringify({
                ticks:     sym,
                subscribe: 1,
                req_id:    pubReqId()
            }));

            // Update UI if this is the active digit market
            if (sym === currentDigitMkt) {
                renderDigitCircles(sym);
                updateDigitStats(sym);
            }
            return;
        }

        // Step 6: Live tick — update rolling window
        if (data.msg_type === 'tick' && data.tick) {
            const sym = data.tick.symbol;
            const st  = digitData[sym];
            if (!st) return;

            // Use tick.pip_size if available (integer = decimals), else stored decimals
            const decimals = Number.isInteger(data.tick.pip_size)
                ? data.tick.pip_size
                : st.decimals;

            const d = extractLastDigit(data.tick.quote, decimals);
            if (isNaN(d)) return;

            addDigitToRolling(sym, d);

            // Update market memory for AI
            if (!marketMemory[sym]) marketMemory[sym] = { prices: [], digits: [], ticks: 0 };
            const mm = marketMemory[sym];
            mm.prices.push(data.tick.quote);
            mm.digits.push(d);
            mm.ticks++;
            if (mm.prices.length > 500) { mm.prices.shift(); mm.digits.shift(); }

            // Consecutive tracking
            if (d === lastDigit) consecutiveSame++;
            else { consecutiveSame = 1; lastDigit = d; }

            // Update digit stats UI
            if (sym === currentDigitMkt) {
                const lastEl = document.getElementById('d-last');
                const tickEl = document.getElementById('d-ticks');
                if (lastEl) lastEl.textContent = d;
                if (tickEl) tickEl.textContent = st.ticks;
                renderDigitCircles(sym);
                updateDigitStats(sym);
            }

            // AI mini panel update
            if (sym === document.getElementById('bot-market')?.value) {
                updateAIMini(sym);
            }

            // Bot engine
            const botMkt = document.getElementById('bot-market')?.value;
            if (isBotRunning && sym === botMkt) {
                runBotLogic(d, data.tick.quote);
            }

            // Update accumulator live price display + drive multi-factor analysis
            if (sym === accuMarket) {
                const priceEl = document.getElementById('accu-price');
                const digitEl = document.getElementById('accu-last-digit');
                if (priceEl) priceEl.textContent = data.tick.quote;
                if (digitEl) digitEl.textContent = `Last digit: ${d}`;
                // Update analysis every 5 ticks — more responsive multi-factor engine
                if (st.ticks % 5 === 0) updateAccuAnalysis(sym);
            }
        }
    };

    publicWS.onerror = (e) => {
        log('📡 Public WS error', 'x');
        console.error(e);
    };

    publicWS.onclose = () => {
        publicWsReady = false;
        log('📡 Public WS closed. Reconnecting in 2s...', 'x');
        // Amy: reset state and reconnect to avoid gaps
        setTimeout(() => {
            ALL_MKTS.forEach(sym => {
                if (digitData[sym]) {
                    digitData[sym].window = [];
                    digitData[sym].counts = Array(10).fill(0);
                    digitData[sym].ticks  = 0;
                }
            });
            connectPublicWS();
        }, 2000);
    };
}

// Legacy function — now routes to public WS
function subscribeDigitFeed(symbol) {
    // Digit feeds handled by public WS — just ensure it's connected
    if (!publicWsReady) connectPublicWS();
}

// processRealTick still called from authenticated WS for bot logic
function processRealTick(symbol, quote) {
    // Digits now handled by public WS — this just feeds bot if needed
    const botMkt = document.getElementById('bot-market')?.value;
    if (isBotRunning && symbol === botMkt) {
        const st  = digitData[symbol];
        const dec = st?.decimals || 2;
        const d   = extractLastDigit(quote, dec);
        if (!isNaN(d)) runBotLogic(d, quote);
    }
}

// processHistory — now handled inside public WS onmessage
function processHistory(symbol, history) {
    // Handled by public WS — kept as stub to avoid errors
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
        closeMobileBotSettings(); // close settings panel on mobile when bot starts
        log(`🟢 Bot started | ${MKT[mkt]||mkt} | ${document.getElementById('bot-type')?.value} | ${botDirection.toUpperCase()}`, 'i');
        log(`   Stake: $${currentStake.toFixed(2)} | TP: $${document.getElementById('bot-tp')?.value} | SL: $${document.getElementById('bot-sl')?.value}`, 'i');

        // Switch to transactions tab
        switchPanel('transactions', document.querySelectorAll('.panel-tab')[1]);

    } else {
        isBotRunning = false;
        pendingContract = false;
        lastContractId  = null;

        // Reset recovery state when bot stops
        if (isInRecoveryMode && originalDirection !== null) {
            botDirection = originalDirection;
            const predEl = document.getElementById('bot-pred');
            if (predEl && originalPrediction !== null) predEl.value = originalPrediction;
            isInRecoveryMode   = false;
            originalDirection  = null;
            originalPrediction = null;
            renderDirButtons();
            updateInfoBar();
            log('🔄 Recovery mode reset — original settings restored', 'i');
        }
        consecutiveLosses = 0;

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

// Proposal timeout tracker
let proposalTimeout = null;

function runBotLogic(digit, quote) {
    if (!isBotRunning || pendingContract) return;

    const type = document.getElementById('bot-type')?.value || 'over_under';
    const pred = parseInt(document.getElementById('bot-pred')?.value || 5);

    // ALL contract types trade on every tick at full Deriv speed
    // Deriv's engine decides win/loss — we just fire as fast as possible
    switch(type) {
        case 'over_under':
            // Only trade when digit confirms direction (improves win rate)
            if (botDirection === 'over'  && digit > pred)  { lastEntrySpot = quote; executeContract(quote); }
            if (botDirection === 'under' && digit < pred)  { lastEntrySpot = quote; executeContract(quote); }
            break;

        case 'even_odd':
        case 'rise_fall':
        case 'only_ups_downs':
            // Trade on EVERY tick — maximum speed, same as Deriv
            lastEntrySpot = quote;
            executeContract(quote);
            break;
    }
}

// Auto-reset pendingContract if proposal takes too long (5 seconds)
function startProposalTimeout() {
    clearProposalTimeout();
    proposalTimeout = setTimeout(() => {
        if (pendingContract && lastContractId === "pending") {
            log("⏱ Proposal timed out — resetting", 'x');
            pendingContract = false;
            lastContractId  = null;
            // Retry immediately
            const mkt = document.getElementById('bot-market')?.value || 'R_10';
            const mm  = marketMemory[mkt];
            if (isBotRunning && mm && mm.prices.length > 0) {
                const lastPrice = mm.prices[mm.prices.length - 1];
                const lastDig   = mm.digits[mm.digits.length - 1];
                runBotLogic(lastDig, lastPrice);
            }
        }
    }, 3000);
}

function clearProposalTimeout() {
    if (proposalTimeout) {
        clearTimeout(proposalTimeout);
        proposalTimeout = null;
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
        log(`❌ Invalid direction "${botDirection}" for type "${type}" — auto-fixing...`, 'x');
        // Auto-fix: pick first valid direction for this type
        const validDirs = Object.keys(typeMap || {});
        if (validDirs.length > 0) {
            botDirection = validDirs[0];
            log(`🔧 Auto-corrected direction to: ${botDirection}`, 'i');
            renderDirButtons();
            updateInfoBar();
            // Retry with fixed direction
            setTimeout(() => { if (isBotRunning && !pendingContract) executeContract(entrySpot); }, 200);
        }
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

    // Start timeout — reset if proposal takes more than 5 seconds
    startProposalTimeout();
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
    clearProposalTimeout();
    // Handle accumulator buy separately
    if (accuRunning && r.buy && !r.error) {
        accuContractId = r.buy.contract_id;
        // Reset the per-contract settlement guard for this brand-new contract
        accuSettledContractIds.delete(accuContractId);
        accuTickCount = 0;
        log(`✅ Accumulator #${accuContractId} started | Buy price: $${r.buy.buy_price}`, 'w');
        notify('📈 Accumulator Running!', `Contract started. Growth: ${(accuGrowthRate*100)}% per tick. Sell anytime!`, 'ok');
        // Subscribe to contract updates
        derivWS.send(JSON.stringify({ proposal_open_contract: 1, contract_id: accuContractId, subscribe: 1 }));
        return;
    }
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
        // Subscribe to contract updates — this gives us entry/exit spots
        derivWS.send(JSON.stringify({
            proposal_open_contract: 1,
            contract_id: lastContractId,
            subscribe: 1
        }));
    }
}

function handleContractResult(c) {
    if (!c) return;

    // Update exit spot on open contracts even before settlement
    if (c.contract_id && c.exit_tick_display_value) {
        updateTxRowExitSpot(c.contract_id, c.exit_tick_display_value);
    }

    // Only process final result when fully settled
    if (!c.is_sold && !c.is_expired) return;
    if (c.contract_id !== lastContractId) return;

    pendingContract = false;
    lastContractId  = null;

    const profit     = parseFloat(c.profit);
    const buyPrice   = parseFloat(c.buy_price || currentStake);
    const payout     = buyPrice + profit;

    // Deriv sends entry_spot and exit_spot (confirmed from debug log)
    const entrySpot2 = c.entry_spot
                    || c.entry_tick_display_value
                    || c.entry_spot_display_value
                    || lastEntrySpot
                    || '—';
    const exitSpot   = c.exit_spot
                    || c.exit_tick_display_value
                    || c.exit_spot_display_value
                    || c.sell_spot
                    || '—';

    totalStake  += buyPrice;
    totalPayout += Math.max(0, payout);
    totalPL     += profit;

    if (profit > 0) {
        playWin();
        totalWins++;
        currentStreak     = currentStreak < 0 ? 1 : currentStreak + 1;
        consecutiveLosses = 0;
        log(`✅ WIN +$${profit.toFixed(2)} | Payout: $${payout.toFixed(2)}`, 'w');
        addTxRow(c.contract_type, entrySpot2, exitSpot, buyPrice, profit, true);
        // Reset stake on win
        currentStake = baseStake;

        // If in recovery mode — switch BACK to original trade after win
        const currentType = document.getElementById('bot-type')?.value;
        if (currentType === 'over_under' && isInRecoveryMode && originalDirection !== null) {
            isInRecoveryMode  = false;
            botDirection      = originalDirection;
            const predEl      = document.getElementById('bot-pred');
            if (predEl && originalPrediction !== null) predEl.value = originalPrediction;
            originalDirection  = null;
            originalPrediction = null;
            consecutiveLosses  = 0;
            renderDirButtons();
            updateInfoBar();
            log(`🔄 Recovery complete! Back to ${botDirection.toUpperCase()} ${document.getElementById('bot-pred')?.value}`, 'i');
            notify('✅ Recovery Complete!', `Won in recovery!
Switched back to original: ${botDirection.toUpperCase()} ${document.getElementById('bot-pred')?.value}`, 'ok');
        }

    } else {
        playLoss();
        totalLosses++;
        currentStreak      = currentStreak > 0 ? -1 : currentStreak - 1;
        consecutiveLosses++;
        log(`❌ LOSS $${profit.toFixed(2)} | Consecutive: ${consecutiveLosses}`, 'l');
        addTxRow(c.contract_type, entrySpot2, exitSpot, buyPrice, profit, false);

        // Martingale
        const mg     = parseFloat(document.getElementById('bot-mg')?.value || 2.1);
        currentStake = parseFloat((currentStake * mg).toFixed(2));
        log(`📐 Martingale: next stake $${currentStake.toFixed(2)}`, 'x');

        // ── SMART RECOVERY — only for over_under ──
        // After 2 consecutive losses, switch to high-probability recovery trade
        // Over 1/2 → recover with Under 8/7 and vice versa
        const currentType2 = document.getElementById('bot-type')?.value;
        if (currentType2 === 'over_under' &&
            consecutiveLosses >= RECOVERY_TRIGGER &&
            !isInRecoveryMode) {

            const currentPred = parseInt(document.getElementById('bot-pred')?.value || 0);
            const recovery    = getRecoveryTrade(botDirection, currentPred);

            if (recovery) {
                // Save original settings before switching
                originalDirection  = botDirection;
                originalPrediction = currentPred;
                isInRecoveryMode   = true;

                // Apply recovery trade
                botDirection = recovery.direction;
                const predEl = document.getElementById('bot-pred');
                if (predEl) predEl.value = recovery.pred;

                renderDirButtons();
                updateInfoBar();

                log(`🚨 ${consecutiveLosses} losses! RECOVERY MODE: ${recovery.direction.toUpperCase()} ${recovery.pred}`, 'x');
                notify(
                    '🚨 Recovery Mode Activated',
                    `${consecutiveLosses} consecutive losses!
Switching to ${recovery.direction.toUpperCase()} ${recovery.pred} to recover.
Will return to ${originalDirection.toUpperCase()} ${originalPrediction} after win.`,
                    'warn'
                );
            }
        }
    }
    updateAllStats();
    checkThresholds();

    // IMMEDIATELY fire next trade after result — no delay
    // This matches Deriv's own bot speed
    if (isBotRunning && !pendingContract) {
        const mkt = document.getElementById('bot-market')?.value || 'R_10';
        const mm  = marketMemory[mkt];
        if (mm && mm.prices.length > 0) {
            const lastPrice = mm.prices[mm.prices.length - 1];
            const lastDig   = mm.digits[mm.digits.length - 1];
            // Small 100ms delay to let Deriv breathe, then fire
            setTimeout(() => {
                if (isBotRunning && !pendingContract) {
                    runBotLogic(lastDig, lastPrice);
                }
            }, 100);
        }
    }

    // AI auto-update after result — NEVER for over_under (user controls direction+barrier)
    if (aiAutoEnabled) {
        const mkt         = document.getElementById('bot-market')?.value || 'R_10';
        const currentType = document.getElementById('bot-type')?.value || 'over_under';
        if (currentType !== 'over_under') {
            const sig = generateSignal(mkt);
            if (sig && sig.confidence >= 70 && sig.type === currentType) {
                const validDirs = Object.keys(CONTRACT_MAP[currentType] || {});
                if (validDirs.includes(sig.botDirection)) {
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
    }
}

// ================================================================
// TRANSACTION ROW — exactly like screenshot
// ================================================================
// Update exit spot on an existing transaction row
function updateTxRowExitSpot(contractId, exitSpot) {
    const rows = document.querySelectorAll('.tx-row[data-contract-id="' + contractId + '"]');
    rows.forEach(row => {
        const exitEl = row.querySelector('.tx-exit-spot');
        if (exitEl && exitSpot) exitEl.textContent = exitSpot;
    });
}

function addTxRow(contractType, entrySpot, exitSpot, stake, profit, isWin) {
    const container = document.getElementById('tx-list');
    if (!container) return;

    // Remove empty state
    const empty = container.querySelector('div[style*="text-align:center"]');
    if (empty) empty.remove();

    // Icons matching Deriv's style
    const icons = {
        DIGITOVER:'↑', DIGITUNDER:'↓', DIGITEVEN:'2x', DIGITODD:'!!',
        DIGITMATCH:'=', DIGITDIFF:'≠',
        CALL:'↑', PUT:'↓', RUNHIGH:'↑↑', RUNLOW:'↓↓'
    };
    const icon       = icons[contractType] || '?';
    const iconBg     = isWin ? '#00d79e18' : '#ff444f18';
    const iconColor  = isWin ? 'var(--green)' : 'var(--red)';
    const profitColor = isWin ? 'var(--green)' : 'var(--red)';

    // Format spots exactly like Deriv — show full price
    const fmtSpot = (s) => {
        if (!s || s === '—') return '—';
        // Return as-is — Deriv already formats it correctly
        return String(s);
    };

    const row = document.createElement('div');
    row.className = 'tx-row';
    if (lastContractId) row.dataset.contractId = lastContractId;
    row.innerHTML = `
        <div class="tx-type-icon" style="background:${iconBg};color:${iconColor};font-weight:900;font-size:14px;border-radius:8px;">
            ${icon}
        </div>
        <div class="tx-spots">
            <div class="tx-entry">
                <span class="spot-dot entry"></span>
                <span class="tx-price" style="font-family:monospace;">${fmtSpot(entrySpot)}</span>
            </div>
            <div class="tx-exit">
                <span class="spot-dot exit"></span>
                <span class="tx-price tx-exit-spot" style="color:var(--muted);font-family:monospace;">${fmtSpot(exitSpot)}</span>
            </div>
        </div>
        <div class="tx-pnl">
            <div class="tx-stake" style="color:var(--muted);font-size:11px;">$${stake.toFixed(2)} USD</div>
            <div class="tx-profit ${isWin?'':'loss'}" style="font-family:monospace;">${isWin?'+':''}$${profit.toFixed(2)} USD</div>
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

    // Use session PL — measured from last reset, not all-time total
    const sessionPL = totalPL - sessionBasePL;

    if (tp > 0 && sessionPL >= tp) {
        log(`🏆 TAKE PROFIT $${tp} HIT! Session P/L: $${sessionPL.toFixed(2)}`, 'w');
        isBotRunning   = false;
        pendingContract = false;
        lastContractId  = null;
        const btn = document.getElementById('run-btn');
        if (btn) { btn.textContent = '▶ Run'; btn.classList.remove('btn-stop'); btn.classList.add('btn-run'); }
        updateBotBar();
        showTargetModal('tp', tp, sessionPL);

    } else if (sl > 0 && sessionPL <= -sl) {
        log(`⛔ STOP LOSS $${sl} HIT! Session P/L: $${sessionPL.toFixed(2)}`, 'x');
        isBotRunning   = false;
        pendingContract = false;
        lastContractId  = null;
        const btn = document.getElementById('run-btn');
        if (btn) { btn.textContent = '▶ Run'; btn.classList.remove('btn-stop'); btn.classList.add('btn-run'); }
        updateBotBar();
        showTargetModal('sl', sl, sessionPL);
    }
}

function showTargetModal(type, amount, sessionPL) {
    sessionPL = sessionPL || totalPL;
    // Remove existing modal if any
    const existing = document.getElementById('target-modal');
    if (existing) existing.remove();

    const isTP   = type === 'tp';
    const color  = isTP ? '#00d2c8' : '#ff444f';
    const emoji  = isTP ? '🏆' : '⛔';
    const title  = isTP ? 'TAKE PROFIT HIT!' : 'STOP LOSS HIT!';
    const msg    = isTP
        ? `Congratulations! You reached your profit target of $${amount.toFixed(2)}.`
        : `Your stop loss of $${amount.toFixed(2)} has been reached.`;
    const sub    = isTP
        ? 'Would you like to reset and continue trading or stop here?'
        : 'Would you like to reset and try again or stop trading?';

    const modal = document.createElement('div');
    modal.id    = 'target-modal';
    modal.style.cssText = `
        position:fixed;inset:0;z-index:999999;
        background:#000000cc;
        display:flex;align-items:center;justify-content:center;
        padding:16px;animation:fadeInModal .3s ease;
    `;
    modal.innerHTML = `
        <style>
            @keyframes fadeInModal{from{opacity:0;transform:scale(.9);}to{opacity:1;transform:scale(1);}}
            @keyframes pulse-ring{0%{box-shadow:0 0 0 0 ${color}66;}70%{box-shadow:0 0 0 20px transparent;}100%{box-shadow:0 0 0 0 transparent;}}
        </style>
        <div style="background:#161b27;border:2px solid ${color};border-radius:16px;padding:30px 24px;
                    max-width:400px;width:100%;text-align:center;
                    box-shadow:0 0 40px ${color}44;animation:pulse-ring 1.5s infinite;">
            <div style="font-size:56px;margin-bottom:12px;">${emoji}</div>
            <div style="font-size:22px;font-weight:900;color:${color};margin-bottom:8px;">${title}</div>
            <div style="font-size:14px;color:#e2e8f0;margin-bottom:6px;">${msg}</div>
            <div style="font-size:12px;color:#718096;margin-bottom:8px;">${sub}</div>

            <!-- Current session stats -->
            <div style="background:#0e1118;border:1px solid #2d3748;border-radius:10px;padding:14px;margin:16px 0;display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
                <div>
                    <div style="font-size:9px;color:#718096;text-transform:uppercase;margin-bottom:4px;">Runs</div>
                    <div style="font-size:18px;font-weight:900;color:#e2e8f0;">${totalRuns}</div>
                </div>
                <div>
                    <div style="font-size:9px;color:#718096;text-transform:uppercase;margin-bottom:4px;">Win Rate</div>
                    <div style="font-size:18px;font-weight:900;color:${color};">${totalRuns>0?((totalWins/totalRuns)*100).toFixed(1):0}%</div>
                </div>
                <div>
                    <div style="font-size:9px;color:#718096;text-transform:uppercase;margin-bottom:4px;">Session P/L</div>
                    <div style="font-size:18px;font-weight:900;color:${color};">$${sessionPL.toFixed(2)}</div>
                </div>
            </div>

            <div style="display:flex;gap:10px;flex-direction:column;">
                <button onclick="resetAndContinue()" style="
                    background:${color};color:${isTP?'#000':'#fff'};border:none;
                    border-radius:10px;padding:14px;font-size:14px;font-weight:900;
                    cursor:pointer;width:100%;letter-spacing:.03em;">
                    🔄 Reset & Continue Trading
                </button>
                <button onclick="stopAndClose()" style="
                    background:transparent;color:#718096;border:1px solid #2d3748;
                    border-radius:10px;padding:12px;font-size:13px;font-weight:700;
                    cursor:pointer;width:100%;">
                    ✋ Stop Trading
                </button>
            </div>
        </div>`;

    document.body.appendChild(modal);

    // Play sound
    if (isTP) { try { winAudio.currentTime=0; winAudio.play(); } catch(e){} }
    else       { try { lossAudio.currentTime=0; lossAudio.play(); } catch(e){} }
}

function resetAndContinue() {
    // Remove modal
    document.getElementById('target-modal')?.remove();

    // Reset session tracking — totalPL keeps accumulating but session resets
    // TP/SL checks against sessionPL (profit since last reset) not totalPL
    sessionBasePL     = totalPL; // new session starts from current PL
    totalRuns         = 0;
    totalWins         = 0;
    totalLosses       = 0;
    totalStake        = 0;
    totalPayout       = 0;
    currentStreak     = 0;
    consecutiveLosses = 0;
    currentStake      = parseFloat(document.getElementById('bot-stake')?.value || 1);
    baseStake         = currentStake;
    lastContractId    = null;
    pendingContract   = false;
    log(`🔄 New session started. TP/SL reset. Cumulative P/L: $${totalPL.toFixed(2)}`, 'i');

    // Reset recovery state
    if (isInRecoveryMode && originalDirection !== null) {
        botDirection = originalDirection;
        const predEl = document.getElementById('bot-pred');
        if (predEl && originalPrediction !== null) predEl.value = originalPrediction;
        renderDirButtons();
        updateInfoBar();
    }
    isInRecoveryMode   = false;
    originalDirection  = null;
    originalPrediction = null;

    // Clear transactions list
    const txList = document.getElementById('tx-list');
    if (txList) txList.innerHTML = '<div style="font-size:11px;color:var(--dim);text-align:center;padding:30px;">No transactions yet.</div>';

    // Reset summary stats display
    updateAllStats();
    log('🔄 Stats reset — continuing trading session', 'i');

    // Auto-start bot again
    toggleBot();
}

function stopAndClose() {
    document.getElementById('target-modal')?.remove();
    log('✋ Trading stopped by user after target.', 'i');
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

    // Even/Odd from real ticks
    const evenCount = counts.filter((_,i) => i%2===0).reduce((a,b)=>a+b,0);
    const evenPct   = (evenCount / total) * 100;
    const oddPct    = 100 - evenPct;

    // Momentum
    let momentum = 0;
    if (mm && mm.prices.length >= 20) {
        const recent = mm.prices.slice(-20);
        const rising = recent.filter((p,i) => i > 0 && p > recent[i-1]).length;
        momentum = ((rising / 19) - 0.5) * 2;
    }

    const consecBonus = Math.min(consecutiveSame * 2, 8);

    // Collect ALL possible signals
    const signals = [];

    // ── EVEN/ODD ──
    if (evenPct > 52) {
        signals.push({
            type:'even_odd', botDirection:'even',
            direction:'Even Only',
            confidence: Math.min(93, Math.round(evenPct + consecBonus * 0.3)),
            reason: `Even digits: ${evenPct.toFixed(1)}% of ${total} ticks`,
            color:'var(--green)', pred: null
        });
    }
    if (oddPct > 52) {
        signals.push({
            type:'even_odd', botDirection:'odd',
            direction:'Odd Only',
            confidence: Math.min(93, Math.round(oddPct + consecBonus * 0.3)),
            reason: `Odd digits: ${oddPct.toFixed(1)}% of ${total} ticks`,
            color:'var(--teal)', pred: null
        });
    }

    // ── OVER/UNDER — scan ALL barriers 0-9 ──
    // Over X = probability that digit > X
    // Under X = probability that digit < X
    for (let barrier = 0; barrier <= 9; barrier++) {
        // Over barrier: digits > barrier
        const overCount = counts.slice(barrier + 1).reduce((a,b)=>a+b,0);
        const overPct   = (overCount / total) * 100;

        // Under barrier: digits < barrier
        const underCount = counts.slice(0, barrier).reduce((a,b)=>a+b,0);
        const underPct   = (underCount / total) * 100;

        // Only use barriers with GOOD risk/reward ratio:
        // Win probability must be between 52% and 85%
        // Above 85% = too likely = tiny payout = unprofitable even when winning
        if (overPct > 52 && overPct <= 85 && barrier < 9) {
            const conf = Math.min(88, Math.round(overPct + consecBonus * 0.2));
            signals.push({
                type:'over_under', botDirection:'over',
                direction:`Over ${barrier}`,
                confidence: conf,
                reason: `${overPct.toFixed(1)}% ticks above ${barrier} | Balanced payout`,
                color:'var(--blue)', pred: barrier
            });
        }

        if (underPct > 52 && underPct <= 85 && barrier > 0) {
            const conf = Math.min(88, Math.round(underPct + consecBonus * 0.2));
            signals.push({
                type:'over_under', botDirection:'under',
                direction:`Under ${barrier}`,
                confidence: conf,
                reason: `${underPct.toFixed(1)}% ticks below ${barrier} | Balanced payout`,
                color:'var(--purple)', pred: barrier
            });
        }
    }

    // ── RISE/FALL from momentum ──
    if (Math.abs(momentum) > 0.25) {
        const dir  = momentum > 0 ? 'rise' : 'fall';
        const conf = Math.min(88, Math.round(54 + Math.abs(momentum) * 30));
        signals.push({
            type:'rise_fall', botDirection:dir,
            direction: dir === 'rise' ? 'Rise Only' : 'Fall Only',
            confidence: conf,
            reason: `Price ${momentum>0?'rising':'falling'} momentum (${(Math.abs(momentum)*100).toFixed(0)}%)`,
            color: momentum > 0 ? 'var(--green)' : 'var(--red)', pred: null
        });
    }

    // ── ONLY UPS / ONLY DOWNS — stronger momentum ──
    if (Math.abs(momentum) > 0.4) {
        const dir  = momentum > 0 ? 'ups' : 'downs';
        const conf = Math.min(85, Math.round(52 + Math.abs(momentum) * 25));
        signals.push({
            type:'only_ups_downs', botDirection:dir,
            direction: dir === 'ups' ? 'Only Ups' : 'Only Downs',
            confidence: conf,
            reason: `Strong ${momentum>0?'upward':'downward'} trend detected`,
            color: momentum > 0 ? 'var(--teal)' : 'var(--red)', pred: null
        });
    }

    // ── HOT DIGIT MATCHES ──
    // If a digit appears far more than expected (>14% vs expected 10%)
    ranked.slice(0, 3).forEach(({d, c}) => {
        const pct = (c / total) * 100;
        if (pct > 13) {
            signals.push({
                type:'over_under', botDirection:'over',
                direction:`Matches ${d}`,
                confidence: Math.min(88, Math.round(pct * 5)),
                reason: `Digit ${d} appeared ${pct.toFixed(1)}% (expected 10%)`,
                color:'var(--amber)', pred: d
            });
        }
    });

    // Sort all signals by confidence, pick the best
    signals.sort((a,b) => b.confidence - a.confidence);
    const best = signals[0];
    if (!best) return null;

    best.symbol      = symbol;
    best.label       = MKT[symbol] || symbol;
    best.hotDigit    = ranked[0]?.d;
    best.coldDigit   = ranked[9]?.d;
    best.evenPct     = evenPct.toFixed(1);
    best.totalTicks  = total;
    best.allSignals  = signals.slice(0, 5); // top 5 for display

    return best;
}

// ================================================================
// BOLLINGER BANDS + RSI ENGINE
// For Only Ups / Only Downs 3-tick signal generation
// ================================================================

function calcRSI(prices, period = 14) {
    if (prices.length < period + 1) return null;
    const recent = prices.slice(-period - 1);
    let gains = 0, losses = 0;
    for (let i = 1; i < recent.length; i++) {
        const diff = recent[i] - recent[i-1];
        if (diff > 0) gains  += diff;
        else          losses -= diff;
    }
    const avgGain = gains  / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs  = avgGain / avgLoss;
    return parseFloat((100 - (100 / (1 + rs))).toFixed(2));
}

function calcBollingerBands(prices, period = 20, multiplier = 2) {
    if (prices.length < period) return null;
    const recent = prices.slice(-period);
    const sma    = recent.reduce((a,b) => a+b, 0) / period;
    const variance = recent.reduce((sum, p) => sum + Math.pow(p - sma, 2), 0) / period;
    const stdDev   = Math.sqrt(variance);
    return {
        upper:  parseFloat((sma + multiplier * stdDev).toFixed(5)),
        middle: parseFloat(sma.toFixed(5)),
        lower:  parseFloat((sma - multiplier * stdDev).toFixed(5)),
        stdDev: parseFloat(stdDev.toFixed(5)),
        bandwidth: parseFloat(((multiplier * 2 * stdDev / sma) * 100).toFixed(2))
    };
}

// ── EMA (Exponential Moving Average) — used by the accumulator trend filter ──
function calcEMA(prices, period) {
    if (!prices || prices.length < period) return null;
    const k = 2 / (period + 1);
    // Seed with SMA of the first `period` values
    let ema = prices.slice(0, period).reduce((a,b) => a+b, 0) / period;
    for (let i = period; i < prices.length; i++) {
        ema = prices[i] * k + ema * (1 - k);
    }
    return ema;
}

// ── ATR (Average True Range) approximation from tick data ──
// Real ATR needs OHLC bars. Ticks only give us a price stream, so we
// approximate "true range" per tick as the absolute price change from the
// previous tick — this is a reasonable proxy for short-horizon volatility
// on synthetic indices, which move on every tick rather than in bars.
function calcATR(prices, period = 14) {
    if (!prices || prices.length < period + 1) return null;
    const recent = prices.slice(-(period + 1));
    let sum = 0;
    for (let i = 1; i < recent.length; i++) sum += Math.abs(recent[i] - recent[i-1]);
    return sum / period;
}

// ── ADX (Average Directional Index) approximation from tick data ──
// Standard ADX needs high/low/close bars. We approximate directional
// movement using consecutive tick-to-tick price changes as a simplified
// +DM/-DM proxy, smoothed with Wilder's method. This gives a workable
// 0-100 trend-strength reading for a continuous tick stream.
function calcADX(prices, period = 14) {
    if (!prices || prices.length < period * 2) return null;
    const plusDM = [], minusDM = [], tr = [];
    for (let i = 1; i < prices.length; i++) {
        const change = prices[i] - prices[i-1];
        plusDM.push(change > 0 ? change : 0);
        minusDM.push(change < 0 ? Math.abs(change) : 0);
        tr.push(Math.abs(change) || 1e-9);
    }
    const smooth = (arr, p) => {
        const out = [];
        let sum = arr.slice(0, p).reduce((a,b)=>a+b, 0);
        out.push(sum);
        for (let i = p; i < arr.length; i++) {
            sum = sum - (sum / p) + arr[i];
            out.push(sum);
        }
        return out;
    };
    const smTR    = smooth(tr, period);
    const smPlus  = smooth(plusDM, period);
    const smMinus = smooth(minusDM, period);
    const dx = [];
    for (let i = 0; i < smTR.length; i++) {
        const plusDI  = (smPlus[i]  / smTR[i]) * 100;
        const minusDI = (smMinus[i] / smTR[i]) * 100;
        const sumDI   = plusDI + minusDI;
        dx.push(sumDI === 0 ? 0 : (Math.abs(plusDI - minusDI) / sumDI) * 100);
    }
    if (dx.length < period) return null;
    const adxSeries = dx.slice(-period);
    const adx = adxSeries.reduce((a,b)=>a+b, 0) / adxSeries.length;
    return parseFloat(adx.toFixed(1));
}

// ── Tick stability — analyse the last 100 ticks for smoothness ──
function calcTickStability(prices) {
    if (!prices || prices.length < 10) return null;
    const recent = prices.slice(-100);
    const moves  = [];
    for (let i = 1; i < recent.length; i++) moves.push(Math.abs(recent[i] - recent[i-1]));
    if (moves.length === 0) return null;
    const avgMove = moves.reduce((a,b)=>a+b, 0) / moves.length;
    const variance = moves.reduce((s,m) => s + Math.pow(m - avgMove, 2), 0) / moves.length;
    const stdDev   = Math.sqrt(variance);
    // A "jump" is a move more than 3x the average tick move
    const jumpThreshold = avgMove * 3;
    const jumps    = moves.filter(m => m > jumpThreshold).length;
    const jumpFreq = jumps / moves.length; // 0..1
    // Stability score: lower relative std dev + fewer jumps = higher score
    const relStd   = avgMove > 0 ? stdDev / avgMove : 0;
    const score    = Math.max(0, Math.min(100, 100 - (relStd * 40) - (jumpFreq * 300)));
    return { avgMove, stdDev, jumpFreq, jumps, sampleSize: moves.length, score: Math.round(score) };
}

function generateOnlyUpsDownsSignal(symbol) {
    const mm = marketMemory[symbol];
    if (!mm || mm.prices.length < 25) return null;

    const prices = mm.prices;
    const last   = prices[prices.length - 1];

    const rsi = calcRSI(prices, 14);
    const bb  = calcBollingerBands(prices, 20, 2);
    if (!rsi || !bb) return null;

    const aboveMiddle = last > bb.middle;
    const belowMiddle = last < bb.middle;
    const nearUpper   = last >= bb.upper * 0.999;
    const nearLower   = last <= bb.lower * 1.001;
    const expanding   = bb.bandwidth > 0.1; // bands expanding = good momentum

    // Recent momentum — last 5 ticks
    const last5   = prices.slice(-5);
    const rising5 = last5.filter((p,i) => i > 0 && p > last5[i-1]).length;
    const momentum = rising5 / 4; // 0 to 1

    let signal = null;

    // ── ONLY UPS signal ──
    // RSI 50-65 (rising, not overbought) + price above middle BB + expanding bands
    if (rsi >= 48 && rsi <= 68 && aboveMiddle && !nearUpper && expanding && momentum >= 0.6) {
        const conf = Math.min(88, Math.round(
            50 +
            (rsi - 48) * 0.8 +         // RSI contribution
            momentum * 15 +             // momentum contribution
            (expanding ? 8 : 0) +       // expanding bands bonus
            (!nearUpper ? 5 : 0)        // not overbought bonus
        ));
        signal = {
            direction:    'Only Ups',
            botDirection: 'ups',
            type:         'only_ups_downs',
            confidence:   conf,
            ticks:        momentum >= 0.75 ? 2 : 3,
            rsi:          rsi,
            bb:           bb,
            lastPrice:    last,
            reason:       `RSI ${rsi} (bullish zone) | Price above BB middle | ${(momentum*100).toFixed(0)}% upward momentum | Bands ${expanding?'expanding':'stable'}`,
            color:        'var(--green)',
            pred:         null
        };
    }

    // ── ONLY DOWNS signal ──
    // RSI 32-50 (falling, not oversold) + price below middle BB + expanding bands
    if (rsi >= 32 && rsi <= 52 && belowMiddle && !nearLower && expanding && momentum <= 0.4) {
        const conf = Math.min(88, Math.round(
            50 +
            (52 - rsi) * 0.8 +
            (1 - momentum) * 15 +
            (expanding ? 8 : 0) +
            (!nearLower ? 5 : 0)
        ));
        signal = {
            direction:    'Only Downs',
            botDirection: 'downs',
            type:         'only_ups_downs',
            confidence:   conf,
            ticks:        momentum <= 0.25 ? 2 : 3,
            rsi:          rsi,
            bb:           bb,
            lastPrice:    last,
            reason:       `RSI ${rsi} (bearish zone) | Price below BB middle | ${((1-momentum)*100).toFixed(0)}% downward momentum | Bands ${expanding?'expanding':'stable'}`,
            color:        'var(--red)',
            pred:         null
        };
    }

    return signal;
}

// ================================================================
// PROFESSIONAL TRADING STRATEGIES
// Based on digit bar analysis (Red/Yellow/Green/Blue)
// ================================================================

function analyzeStrategies(symbol) {
    const data = digitData[symbol];
    const mm   = marketMemory[symbol];
    if (!data || data.ticks < 100) return [];

    const counts = data.counts;
    const total  = Math.max(data.ticks, 1);

    // Calculate percentages for each digit
    const pcts = counts.map(c => parseFloat(((c/total)*100).toFixed(2)));

    // Sort digits by frequency to get bar colors
    const ranked = pcts.map((p,d) => ({d, p})).sort((a,b) => b.p - a.p);
    const green  = ranked[0];  // Most appearing
    const blue   = ranked[1];  // 2nd most appearing
    const yellow = ranked[ranked.length-2]; // 2nd least appearing
    const red    = ranked[ranked.length-1]; // Least appearing

    const signals = [];
    const recentDigits = mm?.digits?.slice(-10) || [];
    const lastDigit    = recentDigits[recentDigits.length - 1];

    // ════════════════════════════════════════════════════
    // STRATEGY 1: OVER 1,2,3
    // ════════════════════════════════════════════════════
    (() => {
        const lowDigits  = [0,1,2,3];
        const highDigits = [4,5,6,7,8,9];

        // Check if digits 0,1,2,3 all below 10%
        const allLow = lowDigits.every(d => pcts[d] < 10);
        // Check if at least 2 of digits 4-9 are above 11%
        const highAbove11 = highDigits.filter(d => pcts[d] >= 11);
        // Green and blue should be in high range
        const greenInHigh = highDigits.includes(green.d);
        const blueInHigh  = highDigits.includes(blue.d);
        // Red or yellow should be in low digits
        const redOrYellowLow = lowDigits.includes(red.d) || lowDigits.includes(yellow.d);

        if (allLow && highAbove11.length >= 2 && greenInHigh && blueInHigh && redOrYellowLow) {
            // Full conditions met — Over 3
            const conf = Math.round(65 + (highAbove11.length * 3) + (10 - Math.max(...lowDigits.map(d=>pcts[d]))));
            signals.push({
                strategy: 'OVER 1,2,3',
                direction: 'Over 3',
                type: 'over_under', botDirection: 'over', pred: 3,
                confidence: Math.min(90, conf),
                color: 'var(--blue)',
                reason: `Digits 0-3 all below 10% | ${highAbove11.length} digits 4-9 above 11% | G:${green.d}(${green.p}%) B:${blue.d}(${blue.p}%)`,
                entryHint: `Wait for digit ${Math.min(...[1,2,3].filter(d=>pcts[d] === Math.min(...[1,2,3].map(d=>pcts[d]))))} to appear, then next tick enter if digit 4-9 appears`,
                priority: true
            });
        } else {
            // Partial — check if only 0,1,2 are below 10%
            const partialLow = [0,1,2].every(d => pcts[d] < 10);
            if (partialLow && highAbove11.length >= 2 && greenInHigh) {
                // Can trade Over 0,1 or 2
                const bestBarrier = [0,1,2].reduce((a,b) => pcts[a] < pcts[b] ? a : b);
                signals.push({
                    strategy: 'OVER 1,2,3 (Partial)',
                    direction: `Over ${bestBarrier}`,
                    type: 'over_under', botDirection: 'over', pred: bestBarrier,
                    confidence: Math.min(82, 60 + highAbove11.length * 3),
                    color: 'var(--blue)',
                    reason: `Digits 0-2 below 10% | Over ${bestBarrier} recommended | G:${green.d}(${green.p}%) B:${blue.d}(${blue.p}%)`,
                    entryHint: `Wait for digit ${bestBarrier} to appear, next tick enter if digit 4-9 appears`,
                    priority: false
                });
            }
        }
    })();

    // ════════════════════════════════════════════════════
    // STRATEGY 2: UNDER 8,7,6
    // ════════════════════════════════════════════════════
    (() => {
        const highDigits = [6,7,8,9];
        const lowDigits  = [0,1,2,3,4,5];

        // Check if digits 6,7,8,9 all below 10%
        const allLow = highDigits.every(d => pcts[d] < 10);
        // Check if at least 2 of digits 0-5 are above 11%
        const lowAbove11 = lowDigits.filter(d => pcts[d] >= 11);
        // Green and blue should be in low range (0-5)
        const greenInLow = lowDigits.includes(green.d);
        const blueInLow  = lowDigits.includes(blue.d);
        // Red or yellow should be in high digits
        const redOrYellowHigh = highDigits.includes(red.d) || highDigits.includes(yellow.d);

        if (allLow && lowAbove11.length >= 2 && greenInLow && blueInLow && redOrYellowHigh) {
            // Full conditions — Under 6
            const conf = Math.round(65 + (lowAbove11.length * 3) + (10 - Math.max(...highDigits.map(d=>pcts[d]))));
            signals.push({
                strategy: 'UNDER 8,7,6',
                direction: 'Under 6',
                type: 'over_under', botDirection: 'under', pred: 6,
                confidence: Math.min(90, conf),
                color: 'var(--purple)',
                reason: `Digits 6-9 all below 10% | ${lowAbove11.length} digits 0-5 above 11% | G:${green.d}(${green.p}%) B:${blue.d}(${blue.p}%)`,
                entryHint: `Wait for digit ${Math.min(...[6,7,8].filter(d=>pcts[d] === Math.min(...[6,7,8].map(d=>pcts[d]))))} to appear, next tick enter if digit 0-4 appears`,
                priority: true
            });
        } else {
            // Partial — only 9,8,7 below 10%
            const partialHigh = [7,8,9].every(d => pcts[d] < 10);
            if (partialHigh && lowAbove11.length >= 2 && greenInLow) {
                const bestBarrier = [7,8,9].reduce((a,b) => pcts[a] < pcts[b] ? a : b);
                signals.push({
                    strategy: 'UNDER 8,7,6 (Partial)',
                    direction: `Under ${bestBarrier}`,
                    type: 'over_under', botDirection: 'under', pred: bestBarrier,
                    confidence: Math.min(82, 60 + lowAbove11.length * 3),
                    color: 'var(--purple)',
                    reason: `Digits 7-9 below 10% | Under ${bestBarrier} recommended | G:${green.d}(${green.p}%) B:${blue.d}(${blue.p}%)`,
                    entryHint: `Wait for digit ${bestBarrier} to appear, next tick enter if digit 0-4 appears`,
                    priority: false
                });
            }
        }
    })();

    // ════════════════════════════════════════════════════
    // STRATEGY 3: ODD STRATEGY
    // ════════════════════════════════════════════════════
    (() => {
        const oddDigits  = [1,3,5,7,9];
        const evenDigits = [0,2,4,6,8];

        // Green and blue must be on odd digits with 11%+
        const greenOnOdd = oddDigits.includes(green.d) && green.p >= 11;
        const blueOnOdd  = oddDigits.includes(blue.d)  && blue.p  >= 11;
        // Red and yellow must be on even digits
        const redOnEven    = evenDigits.includes(red.d)    && red.p    <= 8.6;
        const yellowOnEven = evenDigits.includes(yellow.d) && yellow.p <= 9.5;

        if (greenOnOdd && blueOnOdd && redOnEven && yellowOnEven) {
            // Check recent ticks for trigger — 2 consecutive odds in last 5 ticks
            const last5     = recentDigits.slice(-5);
            let consecOdds  = 0;
            let maxConsec   = 0;
            last5.forEach(d => {
                if (oddDigits.includes(d)) { consecOdds++; maxConsec = Math.max(maxConsec, consecOdds); }
                else consecOdds = 0;
            });

            const triggered = maxConsec >= 2;
            const conf      = Math.min(88, 68 + (triggered ? 10 : 0) + Math.round((green.p + blue.p - 22) / 2));

            signals.push({
                strategy: 'ODD STRATEGY',
                direction: 'Odd Only',
                type: 'even_odd', botDirection: 'odd', pred: null,
                confidence: conf,
                color: 'var(--teal)',
                reason: `G:${green.d}(${green.p}%) B:${blue.d}(${blue.p}%) both ODD 11%+ | R:${red.d}(${red.p}%) Y:${yellow.d}(${yellow.p}%) both EVEN | ${triggered ? '✅ 2 consecutive odds seen' : '⏳ Wait for 2 consecutive odds in next 5 ticks'}`,
                entryHint: triggered
                    ? '✅ ENTER NOW — 2 consecutive odds detected in last 5 ticks'
                    : `Wait for least appearing even digit (${red.d} or ${yellow.d}), then 2 consecutive odds in next 5 ticks`,
                priority: triggered,
                warning: 'Stop after 3-7 wins and re-check market conditions'
            });
        }
    })();

    // ════════════════════════════════════════════════════
    // STRATEGY 4: EVEN STRATEGY
    // ════════════════════════════════════════════════════
    (() => {
        const oddDigits  = [1,3,5,7,9];
        const evenDigits = [0,2,4,6,8];

        // Green and blue must be on EVEN digits with 11%+
        const greenOnEven = evenDigits.includes(green.d) && green.p >= 11;
        const blueOnEven  = evenDigits.includes(blue.d)  && blue.p  >= 11;
        // Red below 8.6%, yellow below 9.5%
        const redLow    = red.p    <= 8.6;
        const yellowLow = yellow.p <= 9.5;
        // Red and yellow can be on odd or mixed
        const redYellowOddOrMixed = oddDigits.includes(red.d) || oddDigits.includes(yellow.d);

        if (greenOnEven && blueOnEven && redLow && yellowLow && redYellowOddOrMixed) {
            // Check trigger — odd digit among R&Y appeared, then even within 3 ticks
            const leastOdd = [red, yellow].find(b => oddDigits.includes(b.d));
            const last5    = recentDigits.slice(-5);
            let triggered  = false;

            // Look for odd (from least pair) then even within 3 ticks
            for (let i = 0; i < last5.length - 1; i++) {
                if (oddDigits.includes(last5[i])) {
                    const next3 = last5.slice(i+1, i+4);
                    if (next3.some(d => evenDigits.includes(d))) { triggered = true; break; }
                }
            }

            const conf = Math.min(88, 66 + (triggered ? 12 : 0) + Math.round((green.p + blue.p - 22) / 2));

            signals.push({
                strategy: 'EVEN STRATEGY',
                direction: 'Even Only',
                type: 'even_odd', botDirection: 'even', pred: null,
                confidence: conf,
                color: 'var(--green)',
                reason: `G:${green.d}(${green.p}%) B:${blue.d}(${blue.p}%) both EVEN 11%+ | R:${red.d}(${red.p}%) Y:${yellow.d}(${yellow.p}%) | ${triggered ? '✅ Entry trigger detected' : '⏳ Wait for odd digit then even within 3 ticks'}`,
                entryHint: triggered
                    ? '✅ ENTER NOW — Odd appeared, even followed within 3 ticks'
                    : `Wait for odd digit (${leastOdd?.d ?? 'R/Y'}) to appear, then even digit within next 3 ticks`,
                priority: triggered,
                warning: 'Stop after 3-7 wins and re-check market conditions'
            });
        }
    })();

    // Sort — priority (triggered) signals first, then by confidence
    signals.sort((a,b) => {
        if (a.priority && !b.priority) return -1;
        if (!a.priority && b.priority) return 1;
        return b.confidence - a.confidence;
    });

    return signals;
}

// Return top N signals for a symbol (used by scanner tab)
function getTopSignals(symbol, n = 5) {
    const data = digitData[symbol];
    const mm   = marketMemory[symbol];
    if (!data || data.ticks < 50) return [];

    const counts  = data.counts;
    const total   = Math.max(data.ticks, 1);
    const signals = [];

    // ── EVEN / ODD — show if above 50% ──
    const evenCount = counts.filter((_,i) => i%2===0).reduce((a,b)=>a+b,0);
    const evenPct   = (evenCount / total) * 100;
    const oddPct    = 100 - evenPct;
    if (evenPct > 50) signals.push({ direction:'Even Only', confidence:Math.min(93,Math.round(evenPct)), type:'even_odd', botDirection:'even', color:'var(--green)', pred:null, reason:`Even ${evenPct.toFixed(1)}% of ${total} ticks` });
    if (oddPct  > 50) signals.push({ direction:'Odd Only',  confidence:Math.min(93,Math.round(oddPct)),  type:'even_odd', botDirection:'odd',  color:'var(--teal)',  pred:null, reason:`Odd ${oddPct.toFixed(1)}% of ${total} ticks` });

    // ── OVER / UNDER — only barriers with good risk/reward ──
    // Payout is inversely proportional to win probability
    // Over 0 = ~90% win but tiny payout (bad) | Over 4 = ~50% win, good payout
    // Best range: Over 1-4, Under 5-8 for balanced risk/reward
    for (let b = 0; b <= 9; b++) {
        const overPct  = (counts.slice(b+1).reduce((a,c)=>a+c,0)/total)*100;
        const underPct = (counts.slice(0,b).reduce((a,c)=>a+c,0)/total)*100;

        // Skip barriers with win probability > 85% — payout too low to be profitable
        // Skip barriers with win probability < 52% — not enough edge
        if (overPct > 50 && overPct <= 85 && b < 9) {
            signals.push({
                direction:`Over ${b}`,
                confidence: Math.min(93,Math.round(overPct)),
                type:'over_under', botDirection:'over',
                color:'var(--blue)', pred:b,
                reason:`${overPct.toFixed(1)}% ticks above ${b} | Good risk/reward`
            });
        }
        if (underPct > 50 && underPct <= 85 && b > 0) {
            signals.push({
                direction:`Under ${b}`,
                confidence: Math.min(93,Math.round(underPct)),
                type:'over_under', botDirection:'under',
                color:'var(--purple)', pred:b,
                reason:`${underPct.toFixed(1)}% ticks below ${b} | Good risk/reward`
            });
        }
    }

    // ── RISE / FALL — show if above 50% ──
    if (mm && mm.prices.length >= 10) {
        const recent  = mm.prices.slice(-20);
        const rising  = recent.filter((p,i) => i>0 && p>recent[i-1]).length;
        const risePct = (rising / Math.max(recent.length-1,1)) * 100;
        const fallPct = 100 - risePct;
        const riseConf = Math.min(88, Math.round(50 + Math.abs(risePct - 50)));
        if (risePct > 50) signals.push({ direction:'Rise Only', confidence:riseConf, type:'rise_fall', botDirection:'rise', color:'var(--green)', pred:null, reason:`Bullish momentum — ${risePct.toFixed(0)}% of last ${recent.length} ticks` });
        if (fallPct > 50) signals.push({ direction:'Fall Only', confidence:riseConf, type:'rise_fall', botDirection:'fall', color:'var(--red)',   pred:null, reason:`Bearish momentum — ${fallPct.toFixed(0)}% of last ${recent.length} ticks` });
    }

    // ── ONLY UPS / ONLY DOWNS — BB + RSI powered ──
    const bbRsiSig = generateOnlyUpsDownsSignal(symbol);
    if (bbRsiSig) {
        signals.push({
            direction:    bbRsiSig.direction,
            confidence:   bbRsiSig.confidence,
            type:         bbRsiSig.type,
            botDirection: bbRsiSig.botDirection,
            color:        bbRsiSig.color,
            pred:         null,
            ticks:        bbRsiSig.ticks,
            reason:       bbRsiSig.reason,
            rsi:          bbRsiSig.rsi,
            bb:           bbRsiSig.bb
        });
    } else if (mm && mm.prices.length >= 10) {
        // Fallback to basic momentum if not enough data for BB/RSI
        const recent  = mm.prices.slice(-20);
        const rising  = recent.filter((p,i) => i>0 && p>recent[i-1]).length;
        const risePct = (rising / Math.max(recent.length-1,1)) * 100;
        const upsConf = Math.min(75, Math.round(50 + Math.abs(risePct - 50)));
        if (risePct > 55) signals.push({ direction:'Only Ups',   confidence:upsConf, type:'only_ups_downs', botDirection:'ups',   color:'var(--teal)',  pred:null, ticks:3, reason:`Momentum ${risePct.toFixed(0)}% upward (collecting BB/RSI data)` });
        if (risePct < 45) signals.push({ direction:'Only Downs', confidence:upsConf, type:'only_ups_downs', botDirection:'downs', color:'var(--amber)', pred:null, ticks:3, reason:`Momentum ${(100-risePct).toFixed(0)}% downward (collecting BB/RSI data)` });
    }

    // ── MATCHES [Green Bar] — digit appearing far above 10% ──
    const ranked = counts.map((c,d)=>({d,c})).sort((a,b)=>b.c-a.c);
    ranked.slice(0,3).forEach(({d,c}) => {
        const pct  = (c/total)*100;
        const conf = Math.round(pct * 6.5);
        if (conf >= 95) {
            signals.push({
                direction:`Matches ${d}`,
                confidence: Math.min(99, conf),
                type:'over_under', botDirection:'over',
                color:'var(--green)', pred:d,
                reason:`🟢 [Matches] Hot digit ${d} at ${pct.toFixed(1)}% — ride the green bar`
            });
        }
    });

    // ── DIFFERS [Red Bar] — least appearing digit, fade it ──
    // Differs wins when last digit ≠ prediction
    // Best when red bar digit is consistently cold (below 7%)
    ranked.slice(-2).forEach(({d,c}) => {
        const pct  = (c/total)*100;
        const conf = Math.round((10 - pct) * 9); // lower % = higher differs confidence
        if (conf >= 75 && pct < 8) {
            signals.push({
                direction:`Differs ${d}`,
                confidence: Math.min(92, conf),
                type:'over_under', botDirection:'over',
                color:'var(--red)', pred:d,
                reason:`🔴 [Differs] Cold digit ${d} at ${pct.toFixed(1)}% — fade the red bar`
            });
        }
    });

    signals.sort((a,b) => b.confidence - a.confidence);
    return signals.slice(0, n);
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

        // AI auto-update — ONLY for even_odd and rise_fall types
        // NEVER auto-change direction for over_under (user must set barrier+direction manually)
        if (aiAutoEnabled && isBotRunning && sig && sig.confidence >= 75) {
            const currentType = document.getElementById('bot-type')?.value || 'over_under';
            const validDirs   = Object.keys(CONTRACT_MAP[currentType] || {});

            // Skip auto-update for over_under — direction+barrier must be set by user
            if (currentType === 'over_under') {
                log(`🧠 AI signal: ${sig.direction} (${sig.confidence}%) — over/under direction locked by user`, 'd');
            }
            else if (sig.type === currentType && validDirs.includes(sig.botDirection)) {
                const oldDir = botDirection;
                botDirection = sig.botDirection;
                if (botDirection !== oldDir) {
                    log(`🧠 AI updated direction: ${oldDir.toUpperCase()} → ${botDirection.toUpperCase()} (${sig.confidence}% confidence)`, 'i');
                    renderDirButtons();
                    updateInfoBar();
                }
            }
        }

        // Notify on strong signals — show top 3
        const topSigsForNotif = getTopSignals(mkt, 3);
        topSigsForNotif.forEach(s => {
            if (s.confidence >= 78) {
                const key = `${mkt}-${s.direction}-${Math.floor(Date.now()/90000)}`;
                if (!seenSignals.has(key)) {
                    seenSignals.add(key);
                    notify(`🧠 ${MKT[mkt]||mkt}`, `${s.direction} | ${s.confidence}% confidence\n${s.reason}`, 'ok');
                    addSignalHistory(s);
                }
            }
        });
    }, 30000);

    // Initial scan after 2 seconds
    setTimeout(runAIScan, 2000);
}

function updateAIPanel(sig, symbol) {
    const data    = digitData[symbol] || { counts: new Array(10).fill(0), ticks: 0 };
    const topSigs = getTopSignals(symbol, 5);

    // Confidence meter — best signal
    const confVal = document.getElementById('ai-confidence-val');
    const confBar = document.getElementById('ai-conf-bar');
    const confLbl = document.getElementById('ai-conf-label');

    if (sig) {
        const col = sig.confidence >= 75 ? 'var(--teal)' : sig.confidence >= 60 ? 'var(--amber)' : 'var(--red)';
        if (confVal) { confVal.textContent = `${sig.confidence}%`; confVal.style.color = col; }
        if (confBar) { confBar.style.width = `${sig.confidence}%`; confBar.style.background = col; }
        if (confLbl) confLbl.textContent = sig.confidence >= 75 ? '🔥 High probability setup' : sig.confidence >= 60 ? '⚡ Moderate setup' : '📉 Weak signal';

        const st = document.getElementById('ai-signal-text');
        const sd = document.getElementById('ai-signal-detail');
        if (st) { st.textContent = sig.direction; st.style.color = sig.color || 'var(--teal)'; }
        if (sd) sd.textContent = `${sig.reason}${sig.hotDigit !== undefined ? ' | Hot: ' + sig.hotDigit + ' Cold: ' + sig.coldDigit : ''}`;
    } else {
        if (confVal) { confVal.textContent = '—%'; confVal.style.color = 'var(--muted)'; }
        if (confBar) confBar.style.width = '0%';
        if (confLbl) confLbl.textContent = data.ticks < 50 ? `Collecting... (${data.ticks}/50 ticks)` : 'No strong signal';
        const st = document.getElementById('ai-signal-text');
        if (st) { st.textContent = 'No clear signal'; st.style.color = 'var(--muted)'; }
    }

    // Market state
    const state = classifyMarket(symbol);
    const ms = document.getElementById('ai-market-state');
    const md = document.getElementById('ai-market-detail');
    if (ms) ms.textContent = state.label;
    if (md) md.textContent = `${data.ticks} ticks | Even: ${sig?.evenPct || '—'}%`;

    // Show ALL top signals in sidebar
    const sigBox = document.getElementById('ai-signal-box');
    if (sigBox && topSigs.length > 0) {
        const sigsHtml = topSigs.map((s, i) => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:5px 8px;
                        background:var(--bg3);border-radius:6px;margin-bottom:4px;cursor:pointer;
                        border-left:3px solid ${s.color};"
                 onclick="applySignalToBot(${JSON.stringify(s).replace(/"/g,'&quot;')})">
                <div>
                    <div style="font-size:11px;font-weight:900;color:${s.color};">${s.direction}</div>
                    <div style="font-size:9px;color:var(--muted);">${s.reason}</div>
                </div>
                <div style="text-align:right;flex-shrink:0;margin-left:8px;">
                    <div style="font-size:12px;font-weight:900;color:${s.color};">${s.confidence}%</div>
                    <div style="font-size:9px;color:var(--teal);">Apply ▶</div>
                </div>
            </div>`).join('');

        sigBox.innerHTML = `
            <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;margin-bottom:8px;">
                Top Signals — ${MKT[symbol]||symbol}
            </div>
            ${sigsHtml}
            ${data.ticks < 50 ? `<div style="font-size:10px;color:var(--dim);text-align:center;padding:8px;">Loading... ${data.ticks}/50 ticks</div>` : ''}`;
    }
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
    signalHistory.unshift({ ...sig, time: new Date().toLocaleTimeString() });
    if (signalHistory.length > 15) signalHistory.pop();

    const el = document.getElementById('ai-signal-history');
    if (!el) return;
    el.innerHTML = '';
    signalHistory.slice(0,6).forEach(s => {
        const row = document.createElement('div');
        row.style.cssText = 'background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:6px 8px;font-size:10px;';
        row.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;">
                <span style="color:${s.color||'var(--teal)'};font-weight:700;">${s.direction}</span>
                <span class="badge badge-teal">${s.confidence}%</span>
            </div>
            <div style="color:var(--muted);margin-top:2px;display:flex;justify-content:space-between;">
                <span>${s.reason || s.label || ''}</span>
                <span style="color:var(--dim);">${s.time || ''}</span>
            </div>`;
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

    // Subscribe to all markets
    ALL_MKTS.forEach(sym => subscribeDigitFeed(sym));

    // Build results with ALL signals per market
    const results = ALL_MKTS.map(sym => ({
        sym,
        signal:     generateSignal(sym),
        topSignals: getTopSignals(sym, 4),
        data:       digitData[sym] || { ticks: 0 },
        state:      classifyMarket(sym)
    })).sort((a,b) => (b.signal?.confidence||0) - (a.signal?.confidence||0));

    // ── Strategy signals box (priority) ──
    // Scan all markets for professional strategy conditions
    const allStrategySignals = [];
    ALL_MKTS.forEach(sym => {
        const strats = analyzeStrategies(sym);
        strats.forEach(s => { s.symbol = sym; s.label = MKT[sym]||sym; allStrategySignals.push(s); });
    });
    allStrategySignals.sort((a,b) => {
        if (a.priority && !b.priority) return -1;
        if (!a.priority && b.priority) return 1;
        return b.confidence - a.confidence;
    });

    // Show strategy signals panel if any found
    const stratBox = document.getElementById('best-signal-box');
    if (stratBox && allStrategySignals.length > 0) {
        const topStrat = allStrategySignals[0];
        const stratHtml = allStrategySignals.slice(0,4).map(s => `
            <div style="background:var(--bg3);border:1px solid ${s.priority?'var(--teal)':'var(--border)'};border-radius:8px;padding:10px;margin-bottom:6px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                    <div>
                        <span style="font-size:11px;font-weight:900;color:${s.color};">${s.strategy}</span>
                        ${s.priority ? '<span style="background:#00d2c822;color:var(--teal);font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;margin-left:6px;">✅ TRIGGERED</span>' : '<span style="background:#f59e0b22;color:#f59e0b;font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;margin-left:6px;">⏳ WATCHING</span>'}
                    </div>
                    <span style="font-size:11px;font-weight:900;color:var(--teal);">${s.confidence}%</span>
                </div>
                <div style="font-size:12px;font-weight:900;color:${s.color};margin-bottom:3px;">${s.direction} — ${s.label}</div>
                <div style="font-size:10px;color:var(--muted);margin-bottom:4px;">${s.reason}</div>
                <div style="font-size:10px;color:var(--teal);font-style:italic;margin-bottom:6px;">💡 ${s.entryHint}</div>
                ${s.warning ? `<div style="font-size:9px;color:#f59e0b;">⚠️ ${s.warning}</div>` : ''}
                <button onclick="applySignalToBot(${JSON.stringify(s).replace(/"/g,'&quot;')})"
                    style="background:var(--teal);color:#000;border:none;border-radius:6px;padding:5px 12px;font-size:10px;font-weight:700;cursor:pointer;margin-top:4px;width:100%;">
                    ✅ Apply to Bot
                </button>
            </div>`).join('');

        stratBox.innerHTML = `
            <div style="font-size:10px;font-weight:900;color:var(--teal);text-transform:uppercase;margin-bottom:10px;">🎯 Professional Strategy Signals</div>
            ${stratHtml}
            ${allStrategySignals.length === 0 ? '<div style="color:var(--muted);font-size:12px;">No strategy conditions met yet. Markets need more data.</div>' : ''}`;
    } else if (stratBox) {
        stratBox.innerHTML = `<div style="font-size:10px;font-weight:900;color:var(--teal);text-transform:uppercase;margin-bottom:8px;">🎯 Professional Strategy Signals</div>
            <div style="color:var(--muted);font-size:12px;padding:10px 0;">Analyzing market conditions... Strategies need 100+ ticks per market.</div>`;
    }

    // ── Best opportunity box ──
    const best = results[0];
    if (bestBox) {
        if (best.signal && best.signal.confidence > 0) {
            const topSigs = best.topSignals || [];
            const sigsHtml = topSigs.map(s => `
                <div style="display:flex;align-items:center;justify-content:space-between;padding:5px 8px;background:var(--bg3);border-radius:6px;cursor:pointer;"
                     onclick="applySignalToBot(${JSON.stringify(s).replace(/"/g,'&quot;')})">
                    <span style="font-size:12px;font-weight:700;color:${s.color};">${s.direction}</span>
                    <div style="display:flex;align-items:center;gap:6px;">
                        <span style="font-size:10px;color:var(--muted);">${s.confidence}%</span>
                        <span style="font-size:10px;background:${s.color}22;color:${s.color};padding:2px 6px;border-radius:4px;font-weight:700;">Apply</span>
                    </div>
                </div>`).join('');

            bestBox.innerHTML = `
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
                    <div>
                        <div style="font-size:13px;font-weight:900;color:var(--text);">🥇 ${best.signal.label}</div>
                        <div style="font-size:10px;color:var(--muted);margin-top:2px;">${best.state.label} | ${best.signal.totalTicks} real ticks</div>
                    </div>
                    <span class="badge badge-teal" style="font-size:12px;padding:4px 10px;">${best.signal.confidence}%</span>
                </div>
                <div style="font-size:15px;font-weight:900;color:${best.signal.color};margin-bottom:6px;">${best.signal.direction}</div>
                <div style="font-size:11px;color:var(--muted);margin-bottom:6px;">${best.signal.reason}${best.signal.hotDigit !== undefined ? ` | Hot: <b style="color:var(--green);">${best.signal.hotDigit}</b> Cold: <b style="color:var(--red);">${best.signal.coldDigit}</b>` : ''}</div>
                ${best.signal.rsi ? `
                <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
                    <div style="background:#4299e122;border:1px solid #4299e144;border-radius:8px;padding:8px 12px;text-align:center;">
                        <div style="font-size:9px;color:#60a5fa;font-weight:700;margin-bottom:2px;">RSI</div>
                        <div style="font-size:18px;font-weight:900;color:#60a5fa;">${best.signal.rsi}</div>
                        <div style="font-size:9px;color:var(--muted);">${best.signal.rsi > 70 ? 'Overbought' : best.signal.rsi < 30 ? 'Oversold' : best.signal.rsi > 50 ? 'Bullish' : 'Bearish'}</div>
                    </div>
                    ${best.signal.bb ? `
                    <div style="background:#9f7aea22;border:1px solid #9f7aea44;border-radius:8px;padding:8px 12px;text-align:center;">
                        <div style="font-size:9px;color:#c4b5fd;font-weight:700;margin-bottom:2px;">BB Width</div>
                        <div style="font-size:18px;font-weight:900;color:#c4b5fd;">${best.signal.bb.bandwidth}%</div>
                        <div style="font-size:9px;color:var(--muted);">${best.signal.bb.bandwidth > 0.2 ? 'Expanding' : 'Squeezing'}</div>
                    </div>
                    <div style="background:#00d2c822;border:1px solid #00d2c844;border-radius:8px;padding:8px 12px;text-align:center;">
                        <div style="font-size:9px;color:var(--teal);font-weight:700;margin-bottom:2px;">Duration</div>
                        <div style="font-size:18px;font-weight:900;color:var(--teal);">${best.signal.ticks || 3}</div>
                        <div style="font-size:9px;color:var(--muted);">Ticks</div>
                    </div>` : ''}
                </div>` : ''}
                ${topSigs.length > 1 ? `<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;margin-bottom:6px;">All Signals for this market:</div><div style="display:flex;flex-direction:column;gap:4px;">${sigsHtml}</div>` : ''}
                <button onclick="applyBestSignal()" class="btn btn-teal" style="margin-top:12px;padding:8px 20px;font-size:12px;width:100%;">✅ Apply Best Signal to Bot</button>`;
        } else {
            bestBox.innerHTML = '<div style="color:var(--muted);font-size:12px;">Loading tick data... Each market needs 50+ ticks. Please wait.</div>';
        }
    }

    // ── All markets grid ──
    container.innerHTML = '';
    results.forEach((r, idx) => {
        const sig      = r.signal;
        const topSigs  = r.topSignals || [];
        const color    = sig ? (sig.color || 'var(--teal)') : 'var(--border)';
        const medals   = ['🥇','🥈','🥉'];

        const card = document.createElement('div');
        card.className = 'scanner-signal' + (sig && sig.confidence >= 75 ? ' strong' : sig && sig.confidence >= 60 ? ' medium' : '');
        card.style.borderColor = color;

        // Build mini signal list
        const miniSigs = topSigs.slice(0,3).map(s =>
            `<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid var(--border);">
                <span style="font-size:10px;color:${s.color};font-weight:700;">${s.direction}</span>
                <span style="font-size:9px;color:var(--muted);">${s.confidence}%
                    <span onclick="event.stopPropagation();applySignalToBot(${JSON.stringify(s).replace(/"/g,'&quot;')})"
                          style="color:var(--teal);cursor:pointer;margin-left:4px;font-weight:700;">Apply</span>
                </span>
            </div>`
        ).join('');

        card.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
                <div style="display:flex;align-items:center;gap:5px;">
                    <span>${medals[idx] || '📊'}</span>
                    <span style="font-size:12px;font-weight:900;">${MKT[r.sym]||r.sym}</span>
                </div>
                <div style="display:flex;align-items:center;gap:5px;">
                    ${sig ? `<span class="badge badge-teal" style="font-size:10px;">${sig.confidence}%</span>` : ''}
                    <span style="font-size:9px;color:var(--dim);">${r.data.ticks}t</span>
                </div>
            </div>
            <div style="font-size:13px;font-weight:900;color:${color};margin-bottom:4px;">${sig ? sig.direction : 'Collecting data...'}</div>
            <div style="font-size:9px;color:var(--muted);margin-bottom:6px;">${r.state.label}${sig ? ' | ' + sig.reason : ''}</div>
            ${miniSigs ? `<div style="margin-top:4px;">${miniSigs}</div>` : ''}`;

        card.onclick = () => { if (sig) applySignalToBot(sig); };
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

    // Parse if passed as string from onclick
    if (typeof sig === 'string') {
        try { sig = JSON.parse(sig); } catch(e) { return; }
    }

    const mktSel  = document.getElementById('bot-market');
    const typeSel = document.getElementById('bot-type');
    const predEl  = document.getElementById('bot-pred');
    const durEl   = document.getElementById('bot-dur');

    // Apply market if signal has one
    if (sig.symbol && mktSel) mktSel.value = sig.symbol;

    // Apply trade type
    if (typeSel) { typeSel.value = sig.type; onTypeChange(); }

    // Apply direction
    selectDir(sig.botDirection);

    // Apply prediction/barrier value for over_under
    if (sig.pred !== null && sig.pred !== undefined && predEl) {
        predEl.value = sig.pred;
    }

    // Apply ticks from signal (BB/RSI sets 2 or 3 for Only Ups/Downs)
    if (sig.ticks && durEl) {
        durEl.value = sig.ticks;
        log(`⏱ Duration set to ${sig.ticks} ticks from signal`, 'i');
    }

    updateInfoBar();
    updateActiveBotName();
    log(`🧠 Applied: ${sig.label||sig.symbol||''} | ${sig.direction} | Pred: ${sig.pred!==null&&sig.pred!==undefined?sig.pred:'—'} | ${sig.confidence}%`, 'i');
    notify("AI Signal Applied ✅", `${sig.direction}
Confidence: ${sig.confidence}%${sig.pred!==null&&sig.pred!==undefined?' | Barrier: '+sig.pred:''}`, 'ok');
    switchTab('bot');
    // On mobile, open settings panel so user can review and adjust
    setTimeout(() => {
        const sidebar = document.querySelector('#bot-pane .sidebar');
        if (sidebar && window.innerWidth <= 768) {
            sidebar.classList.add('mobile-open');
            const btn = document.getElementById('mobile-bot-settings-btn');
            if (btn) btn.textContent = '✕ Close Settings';
            sidebar.scrollTop = 0;
        }
    }, 300);
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
    // Data comes from public WS — just update display
    const data = digitData[symbol];
    if (data && data.ticks > 0) {
        renderDigitCircles(symbol);
        updateDigitStats(symbol);
        const lastEl = document.getElementById('d-last');
        const tickEl = document.getElementById('d-ticks');
        if (tickEl) tickEl.textContent = data.ticks;
    } else {
        const c = document.getElementById('d-circles');
        if (c) c.innerHTML = '<div style="font-size:11px;color:var(--dim);padding:10px;">Loading tick data from Deriv... please wait.</div>';
    }
}

function renderDigitCircles(symbol) {
    const circlesEl = document.getElementById('d-circles');
    const barsEl    = document.getElementById('d-bars');
    if (!circlesEl) return;

    const data   = digitData[symbol] || { counts: new Array(10).fill(0), ticks: 0, window: [] };
    const counts = data.counts;
    const total  = Math.max(data.ticks, 1); // real rolling window size
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

    const even     = counts.filter((_,i) => i%2===0).reduce((a,b)=>a+b,0);
    const odd      = total - even;
    const over     = counts.slice(5).reduce((a,b)=>a+b,0);
    const under    = total - over;

    const evenPct  = parseFloat(((even/total)*100).toFixed(1));
    const oddPct   = parseFloat(((odd/total)*100).toFixed(1));
    const overPct  = parseFloat(((over/total)*100).toFixed(1));
    const underPct = parseFloat(((under/total)*100).toFixed(1));

    const set = (id,v) => { const el=document.getElementById(id); if(el) el.textContent=v; };

    // Update text values
    set('d-even',  `${evenPct}%`);
    set('d-odd',   `${oddPct}%`);
    set('d-over',  `${overPct}%`);
    set('d-under', `${underPct}%`);

    // Update Even/Odd bar widths
    const evenBar  = document.getElementById('d-even-bar');
    const oddBar   = document.getElementById('d-odd-bar');
    if (evenBar) evenBar.style.width = `${evenPct}%`;
    if (oddBar)  oddBar.style.width  = `${oddPct}%`;

    // Color the higher side green, lower side red
    if (evenBar && oddBar) {
        if (evenPct > oddPct) {
            evenBar.style.background = 'var(--green)';
            oddBar.style.background  = 'var(--red)';
        } else {
            evenBar.style.background = 'var(--red)';
            oddBar.style.background  = 'var(--green)';
        }
    }

    // Update Over/Under bar widths
    const overBar  = document.getElementById('d-over-bar');
    const underBar = document.getElementById('d-under-bar');
    if (overBar)  overBar.style.width  = `${overPct}%`;
    if (underBar) underBar.style.width = `${underPct}%`;

    if (overBar && underBar) {
        if (overPct > underPct) {
            overBar.style.background  = 'var(--green)';
            underBar.style.background = 'var(--red)';
        } else {
            overBar.style.background  = 'var(--red)';
            underBar.style.background = 'var(--green)';
        }
    }
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

function revokeAccess() {
    // Clear all saved tokens and disconnect
    localStorage.removeItem('bth_access_token');
    localStorage.removeItem('bth_account_id');
    localStorage.removeItem('bth_connected_at');
    sessionStorage.clear();

    // Close WebSocket
    if (derivWS) { derivWS.close(); derivWS = null; }
    if (publicWS) { publicWS.close(); publicWS = null; }

    accessToken = null;
    accountId   = null;
    allAccounts = [];

    // Reset UI
    const btnLogin  = document.getElementById('btn-login');
    const btnSignup = document.getElementById('btn-signup');
    if (btnLogin)  btnLogin.style.display  = 'block';
    if (btnSignup) btnSignup.style.display = 'block';

    const aw = document.getElementById('acct-wrap');
    if (aw) aw.style.display = 'none';

    const authCard = document.getElementById('auth-card');
    if (authCard) authCard.style.display = 'block';

    const ds = document.getElementById('dash-stats');
    if (ds) ds.style.display = 'none';

    updateConnStatus(false);
    switchTab('dashboard');

    notify('✅ Disconnected', 'Your Deriv account has been disconnected. You can reconnect anytime.', 'ok');
    log('🔓 Access revoked — token cleared', 'i');
}

function clearJournal() {
    const el = document.getElementById('journal-log');
    if (el) el.innerHTML = '<div class="jline d">[Cleared]</div>';
}

function resetBotStats() {
    totalPL       = 0;
    totalRuns     = 0;
    totalWins     = 0;
    totalLosses   = 0;
    totalStake    = 0;
    totalPayout   = 0;
    currentStreak = 0;
    consecutiveLosses = 0;
    sessionBasePL = 0;
    currentStake  = parseFloat(document.getElementById('bot-stake')?.value || 1);
    baseStake     = currentStake;

    // Clear transaction list
    const txList = document.getElementById('tx-list');
    if (txList) txList.innerHTML = '<div style="font-size:11px;color:var(--dim);text-align:center;padding:30px;">No transactions yet.</div>';

    updateAllStats();
    log('🔄 Stats reset by user', 'i');
    notify('🔄 Stats Reset', 'All trading stats have been cleared.', 'ok');
}

function showStrategyGuide() {
    const modal = document.getElementById('strategy-modal');
    if (modal) { modal.style.display = 'flex'; document.body.style.overflow = 'hidden'; }
}

function closeStrategyGuide() {
    const modal = document.getElementById('strategy-modal');
    if (modal) { modal.style.display = 'none'; document.body.style.overflow = ''; }
}

// ================================================================
// LEGAL — Terms, Privacy, Risk Disclaimer
// ================================================================

const LEGAL_CONTENT = {

    terms: {
        title: "📄 Terms of Service",
        body: `
<h3 style="color:#e2e8f0;font-size:15px;margin-bottom:12px;">Terms of Service</h3>
<p style="margin-bottom:10px;"><b style="color:#e2e8f0;">Effective Date:</b> 1 January 2026</p>

<h4 style="color:#00d2c8;margin:14px 0 6px;">1. Acceptance of Terms</h4>
<p>By accessing or using Btraderhub ("the Platform"), you agree to be bound by these Terms of Service. If you do not agree, do not use the Platform.</p>

<h4 style="color:#00d2c8;margin:14px 0 6px;">2. Description of Service</h4>
<p>Btraderhub is a third-party trading interface that connects to the Deriv API. We provide automated trading tools, market analysis, and AI-powered signals. We are not affiliated with, endorsed by, or part of Deriv Ltd.</p>

<h4 style="color:#00d2c8;margin:14px 0 6px;">3. Eligibility</h4>
<p>You must be at least 18 years old and legally permitted to trade financial instruments in your jurisdiction to use this Platform. It is your responsibility to verify local laws before trading.</p>

<h4 style="color:#00d2c8;margin:14px 0 6px;">4. No Financial Advice</h4>
<p>Nothing on Btraderhub constitutes financial, investment, or trading advice. All AI signals, market analysis, and bot strategies are for informational purposes only. You trade at your own risk.</p>

<h4 style="color:#00d2c8;margin:14px 0 6px;">5. User Responsibilities</h4>
<p>You are solely responsible for:</p>
<ul style="margin:6px 0 6px 20px;">
    <li>All trades executed through your Deriv account</li>
    <li>Setting appropriate risk parameters (stake, stop loss, take profit)</li>
    <li>Ensuring your Deriv account has sufficient funds</li>
    <li>Compliance with applicable laws and regulations</li>
</ul>

<h4 style="color:#00d2c8;margin:14px 0 6px;">6. Limitation of Liability</h4>
<p>Btraderhub, its owners, developers, and affiliates shall not be liable for any trading losses, lost profits, or damages arising from the use of this Platform, including but not limited to losses caused by bot malfunction, API errors, connectivity issues, or market conditions.</p>

<h4 style="color:#00d2c8;margin:14px 0 6px;">7. Modifications</h4>
<p>We reserve the right to modify these Terms at any time. Continued use of the Platform constitutes acceptance of updated Terms.</p>

<h4 style="color:#00d2c8;margin:14px 0 6px;">8. Termination</h4>
<p>We reserve the right to suspend or terminate access to the Platform at our discretion, without notice, for any reason including violation of these Terms.</p>

<h4 style="color:#00d2c8;margin:14px 0 6px;">9. Governing Law</h4>
<p>These Terms are governed by applicable international law. Any disputes shall be resolved through binding arbitration.</p>

<p style="margin-top:16px;color:#4a5568;font-size:11px;">For questions: support@btraderhub.com</p>`
    },

    privacy: {
        title: "🔒 Privacy Policy",
        body: `
<h3 style="color:#e2e8f0;font-size:15px;margin-bottom:12px;">Privacy Policy</h3>
<p style="margin-bottom:10px;"><b style="color:#e2e8f0;">Effective Date:</b> 1 January 2026</p>

<h4 style="color:#00d2c8;margin:14px 0 6px;">1. Information We Collect</h4>
<p>Btraderhub does <b style="color:#e2e8f0;">not</b> collect, store, or process your personal data on our servers. All authentication is handled directly between your browser and Deriv's servers via OAuth 2.0 PKCE.</p>
<p style="margin-top:8px;">We do not store:</p>
<ul style="margin:6px 0 6px 20px;">
    <li>Your Deriv account credentials</li>
    <li>Your trading history or account balance</li>
    <li>Personal identification information</li>
    <li>Payment or financial data</li>
</ul>

<h4 style="color:#00d2c8;margin:14px 0 6px;">2. Session Data</h4>
<p>We temporarily store the following in your browser's <b style="color:#e2e8f0;">sessionStorage</b> only during the login process:</p>
<ul style="margin:6px 0 6px 20px;">
    <li>PKCE code verifier (deleted immediately after login)</li>
    <li>OAuth state parameter (deleted immediately after login)</li>
</ul>
<p>This data never leaves your browser and is automatically cleared when you close the tab.</p>

<h4 style="color:#00d2c8;margin:14px 0 6px;">3. Deriv API</h4>
<p>Your trading data is processed directly by Deriv Ltd. through their API. Please review <a href="https://deriv.com/privacy/" target="_blank" style="color:var(--teal);">Deriv's Privacy Policy</a> for information on how they handle your data.</p>

<h4 style="color:#00d2c8;margin:14px 0 6px;">4. Cookies</h4>
<p>Btraderhub does not use cookies or tracking technologies.</p>

<h4 style="color:#00d2c8;margin:14px 0 6px;">5. Third-Party Services</h4>
<p>We use the following third-party services:</p>
<ul style="margin:6px 0 6px 20px;">
    <li><b style="color:#e2e8f0;">Deriv API</b> — for trade execution and market data</li>
    <li><b style="color:#e2e8f0;">Vercel</b> — for hosting (subject to Vercel's privacy policy)</li>
    <li><b style="color:#e2e8f0;">TradingView</b> — for charting widgets</li>
</ul>

<h4 style="color:#00d2c8;margin:14px 0 6px;">6. Affiliate Disclosure</h4>
<p>Btraderhub participates in the Deriv affiliate program. When you create a new Deriv account through our platform, we may receive a commission. This does not affect your trading costs or experience.</p>

<h4 style="color:#00d2c8;margin:14px 0 6px;">7. Contact</h4>
<p>For privacy concerns: <a href="mailto:support@btraderhub.com" style="color:var(--teal);">support@btraderhub.com</a></p>`
    },

    risk: {
        title: "⚠️ Risk Disclaimer",
        body: `
<div style="background:#ff444f14;border:1px solid #ff444f44;border-radius:8px;padding:14px;margin-bottom:16px;">
    <p style="color:#ff444f;font-weight:700;font-size:14px;">⚠️ HIGH RISK WARNING</p>
    <p style="margin-top:6px;">Trading binary options and synthetic indices carries a high level of risk and may not be suitable for all investors. You may lose some or all of your invested capital.</p>
</div>

<h4 style="color:#00d2c8;margin:14px 0 6px;">1. Nature of Risk</h4>
<p>Binary options and CFDs are complex instruments. The majority of retail traders lose money when trading these products. You should consider whether you understand how these instruments work and whether you can afford to take the high risk of losing your money.</p>

<h4 style="color:#00d2c8;margin:14px 0 6px;">2. Automated Trading Risk</h4>
<p>Automated trading bots, including those provided or configured on Btraderhub, carry additional risks:</p>
<ul style="margin:6px 0 6px 20px;">
    <li>Past performance of a bot does NOT guarantee future results</li>
    <li>Bots can malfunction due to connectivity issues, API changes, or software bugs</li>
    <li>Market conditions can change rapidly in ways a bot cannot anticipate</li>
    <li>The Martingale strategy can result in rapid and total loss of capital</li>
    <li>AI signals are based on statistical patterns and are NOT guaranteed</li>
</ul>

<h4 style="color:#00d2c8;margin:14px 0 6px;">3. AI Signal Disclaimer</h4>
<p>AI-generated signals and win probability estimates are based on historical tick data analysis. They are <b style="color:#e2e8f0;">not</b> financial advice and do not guarantee any particular outcome. Confidence percentages represent statistical patterns only and should not be relied upon as predictions.</p>

<h4 style="color:#00d2c8;margin:14px 0 6px;">4. Capital at Risk</h4>
<p>Never trade with money you cannot afford to lose. We strongly recommend:</p>
<ul style="margin:6px 0 6px 20px;">
    <li>Starting with a <b style="color:#e2e8f0;">demo account</b> before trading real money</li>
    <li>Setting strict stop loss limits before running any bot</li>
    <li>Never using borrowed money or funds needed for essential expenses</li>
    <li>Limiting bot stake to a small percentage of your total capital</li>
</ul>

<h4 style="color:#00d2c8;margin:14px 0 6px;">5. Regulatory Notice</h4>
<p>Btraderhub is a third-party tool and is not regulated by any financial authority. Trading through Deriv is subject to Deriv's own regulatory framework. Please ensure trading is legal in your jurisdiction.</p>

<h4 style="color:#00d2c8;margin:14px 0 6px;">6. No Guarantee of Profit</h4>
<p>Btraderhub makes no representation or warranty that use of the platform will result in profits. All trading results depend on market conditions, your settings, and factors beyond our control.</p>

<div style="background:#00d2c814;border:1px solid #00d2c844;border-radius:8px;padding:14px;margin-top:16px;">
    <p style="color:#00d2c8;font-weight:700;">✅ By using Btraderhub, you confirm that:</p>
    <ul style="margin:8px 0 0 20px;color:#a0aec0;">
        <li>You are 18 years or older</li>
        <li>You understand the risks of binary options trading</li>
        <li>You are trading with money you can afford to lose</li>
        <li>You have read and accepted the Terms of Service</li>
    </ul>
</div>`
    }
};

function showLegal(type) {
    const modal   = document.getElementById('legal-modal');
    const title   = document.getElementById('legal-title');
    const content = document.getElementById('legal-content');
    const data    = LEGAL_CONTENT[type];
    if (!modal || !data) return;
    title.textContent  = data.title;
    content.innerHTML  = data.body;
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}

function closeLegal() {
    const modal = document.getElementById('legal-modal');
    if (modal) modal.style.display = 'none';
    document.body.style.overflow = '';
}

// Close modal on backdrop click
document.addEventListener('click', (e) => {
    const modal = document.getElementById('legal-modal');
    if (e.target === modal) closeLegal();
});

// Risk disclaimer shown from main load event (no duplicate listener needed)

// ================================================================
// MT5 CFD SIGNALS ENGINE
// Real-time signals for Deriv MT5 — click to trade
// ================================================================

// MT5 instruments — Deriv Synthetic Indices focus
const MT5_INSTRUMENTS = [
    // Boom & Crash
    { symbol:'BOOM1000', name:'Boom 1000 Index',  cat:'boom_crash', pip:0.01, icon:'🚀', derivSym:'BOOM1000' },
    { symbol:'BOOM500',  name:'Boom 500 Index',   cat:'boom_crash', pip:0.01, icon:'🚀', derivSym:'BOOM500' },
    { symbol:'BOOM300',  name:'Boom 300 Index',   cat:'boom_crash', pip:0.01, icon:'🚀', derivSym:'BOOM300' },
    { symbol:'CRASH1000',name:'Crash 1000 Index', cat:'boom_crash', pip:0.01, icon:'💥', derivSym:'CRASH1000' },
    { symbol:'CRASH500', name:'Crash 500 Index',  cat:'boom_crash', pip:0.01, icon:'💥', derivSym:'CRASH500' },
    { symbol:'CRASH300', name:'Crash 300 Index',  cat:'boom_crash', pip:0.01, icon:'💥', derivSym:'CRASH300' },
    // Step Indices
    { symbol:'STEP100',  name:'Step Index',       cat:'step',       pip:0.00001, icon:'👣', derivSym:'stpRNG' },
    // Volatility Indices (continuous)
    { symbol:'VOL10',    name:'Volatility 10',    cat:'volatility', pip:0.001, icon:'📊', derivSym:'R_10' },
    { symbol:'VOL25',    name:'Volatility 25',    cat:'volatility', pip:0.001, icon:'📊', derivSym:'R_25' },
    { symbol:'VOL50',    name:'Volatility 50',    cat:'volatility', pip:0.001, icon:'📊', derivSym:'R_50' },
    { symbol:'VOL75',    name:'Volatility 75',    cat:'volatility', pip:0.001, icon:'📊', derivSym:'R_75' },
    { symbol:'VOL100',   name:'Volatility 100',   cat:'volatility', pip:0.001, icon:'📊', derivSym:'R_100' },
    // Volatility 1s Indices
    { symbol:'VOL10S',   name:'Volatility 10 (1s)',  cat:'volatility', pip:0.001, icon:'⚡', derivSym:'1HZ10V' },
    { symbol:'VOL25S',   name:'Volatility 25 (1s)',  cat:'volatility', pip:0.001, icon:'⚡', derivSym:'1HZ25V' },
    { symbol:'VOL50S',   name:'Volatility 50 (1s)',  cat:'volatility', pip:0.001, icon:'⚡', derivSym:'1HZ50V' },
    { symbol:'VOL75S',   name:'Volatility 75 (1s)',  cat:'volatility', pip:0.001, icon:'⚡', derivSym:'1HZ75V' },
    { symbol:'VOL100S',  name:'Volatility 100 (1s)', cat:'volatility', pip:0.001, icon:'⚡', derivSym:'1HZ100V' },
];

// Store MT5 price data
let mt5PriceData = {};  // symbol -> { prices: [], lastPrice: null, change: 0 }
let mt5PublicWS  = null;
let mt5WsReady   = false;
let mt5Filter    = 'all';

// Connect to public WS for MT5 price data
function connectMT5Feed() {
    if (mt5PublicWS && mt5PublicWS.readyState === WebSocket.OPEN) return;

    mt5PublicWS = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');
    mt5PublicWS.onopen = () => {
        mt5WsReady = true;
        // Subscribe to all MT5 instruments
        MT5_INSTRUMENTS.forEach((inst, i) => {
            setTimeout(() => {
                if (mt5PublicWS.readyState === WebSocket.OPEN) {
                    mt5PublicWS.send(JSON.stringify({
                        ticks: inst.derivSym,
                        subscribe: 1,
                        req_id: 9000 + i
                    }));
                }
            }, i * 100);
        });
    };

    mt5PublicWS.onmessage = (ev) => {
        try {
            const data = JSON.parse(ev.data);
            if (data.msg_type === 'tick' && data.tick) {
                const sym   = data.tick.symbol;
                const price = data.tick.quote;
                const inst  = MT5_INSTRUMENTS.find(i => i.derivSym === sym);
                if (!inst) return;

                if (!mt5PriceData[inst.symbol]) {
                    mt5PriceData[inst.symbol] = { prices: [], lastPrice: null, change: 0 };
                }
                const d = mt5PriceData[inst.symbol];
                d.prices.push(price);
                if (d.prices.length > 100) d.prices.shift();

                if (d.lastPrice !== null) {
                    d.change = ((price - d.prices[0]) / d.prices[0]) * 100;
                }
                d.lastPrice = price;

                // Update signal card if visible
                updateMT5Card(inst.symbol);
            }
        } catch(e) {}
    };

    mt5PublicWS.onclose = () => {
        mt5WsReady = false;
        setTimeout(connectMT5Feed, 3000);
    };

    mt5PublicWS.onerror = () => { mt5WsReady = false; };
}

// Generate MT5 signal from price data
function generateMT5Signal(symbol) {
    const d = mt5PriceData[symbol];
    if (!d || d.prices.length < 10) return null;

    const prices  = d.prices;
    const last    = prices[prices.length - 1];
    const prev    = prices[0];
    const change  = ((last - prev) / prev) * 100;

    // Simple momentum signal
    const rising  = prices.filter((p,i) => i > 0 && p > prices[i-1]).length;
    const total   = prices.length - 1;
    const bullPct = (rising / total) * 100;

    let direction, confidence, reason;

    if (bullPct > 60) {
        direction  = 'BUY';
        confidence = Math.min(92, Math.round(bullPct));
        reason     = `Bullish momentum ${bullPct.toFixed(0)}% of last ${prices.length} ticks`;
    } else if (bullPct < 40) {
        direction  = 'SELL';
        confidence = Math.min(92, Math.round(100 - bullPct));
        reason     = `Bearish momentum ${(100-bullPct).toFixed(0)}% of last ${prices.length} ticks`;
    } else {
        direction  = change >= 0 ? 'BUY' : 'SELL';
        confidence = Math.round(50 + Math.abs(bullPct - 50));
        reason     = `Neutral — slight ${change >= 0 ? 'upward' : 'downward'} bias`;
    }

    return { direction, confidence, reason, change, lastPrice: last };
}

// Render all MT5 signal cards
function renderMT5Signals() {
    const grid = document.getElementById('mt5-signals-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const filtered = MT5_INSTRUMENTS.filter(i => mt5Filter === 'all' || i.cat === mt5Filter);

    filtered.forEach(inst => {
        const sig  = generateMT5Signal(inst.symbol);
        const d    = mt5PriceData[inst.symbol];
        const card = document.createElement('div');
        card.id    = `mt5-card-${inst.symbol}`;

        const isBuy    = sig?.direction === 'BUY';
        const sigColor = sig ? (isBuy ? 'var(--green)' : 'var(--red)') : 'var(--muted)';
        const change   = d?.change || 0;
        const chgColor = change >= 0 ? 'var(--green)' : 'var(--red)';
        const price    = d?.lastPrice ? d.lastPrice.toFixed(inst.pip < 0.001 ? 5 : inst.pip < 0.1 ? 2 : 1) : '—';

        // Build MT5 deep link
        const mt5Url = `https://app.deriv.com/mt5?symbol=${inst.derivSym}`;

        card.className = 'card';
        card.style.cssText = 'padding:14px;transition:all .2s;cursor:pointer;';
        card.onmouseenter = () => card.style.borderColor = sigColor;
        card.onmouseleave = () => card.style.borderColor = 'var(--border)';

        card.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
                <div style="display:flex;align-items:center;gap:8px;">
                    <span style="font-size:20px;">${inst.icon}</span>
                    <div>
                        <div style="font-size:13px;font-weight:900;">${inst.name}</div>
                        <div style="font-size:10px;color:var(--muted);">${inst.symbol} · ${inst.cat}</div>
                    </div>
                </div>
                <div style="text-align:right;">
                    <div style="font-size:14px;font-weight:900;font-family:monospace;">${price}</div>
                    <div style="font-size:10px;color:${chgColor};font-weight:700;">${change >= 0 ? '+' : ''}${change.toFixed(3)}%</div>
                </div>
            </div>

            ${sig ? `
            <div style="background:${sigColor}18;border:1px solid ${sigColor}44;border-radius:8px;padding:10px;margin-bottom:10px;">
                <div style="display:flex;align-items:center;justify-content:space-between;">
                    <span style="font-size:16px;font-weight:900;color:${sigColor};">${sig.direction === 'BUY' ? '📈' : '📉'} ${sig.direction}</span>
                    <span style="font-size:13px;font-weight:900;color:${sigColor};">${sig.confidence}%</span>
                </div>
                <div style="font-size:10px;color:var(--muted);margin-top:4px;">${sig.reason}</div>
            </div>` : `
            <div style="background:var(--bg3);border-radius:8px;padding:10px;margin-bottom:10px;text-align:center;">
                <div style="font-size:11px;color:var(--muted);">Loading price data...</div>
            </div>`}

            <a href="${mt5Url}" target="_blank"
               style="display:block;width:100%;padding:10px;border-radius:8px;text-align:center;
                      font-size:13px;font-weight:900;text-decoration:none;
                      background:${sig ? sigColor : 'var(--bg3)'};
                      color:${sig ? (isBuy ? '#000' : '#fff') : 'var(--muted)'};"
               onclick="log('📊 Opening MT5 for ${inst.name} — ${sig?.direction || 'signal pending'}', 'i')">
                ${sig ? `${sig.direction === 'BUY' ? '🟢' : '🔴'} Trade ${sig.direction} on MT5` : '📊 Open MT5'}
            </a>`;

        grid.appendChild(card);
    });

    // Show message if no data yet
    if (filtered.every(i => !mt5PriceData[i.symbol]?.lastPrice)) {
        grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--muted);">
            <div style="font-size:24px;margin-bottom:10px;">📡</div>
            <div style="font-size:14px;font-weight:700;margin-bottom:6px;">Loading MT5 price feeds...</div>
            <div style="font-size:12px;">Connecting to Deriv market data. This takes a few seconds.</div>
        </div>`;
    }
}

// Update single MT5 card
function updateMT5Card(symbol) {
    const card = document.getElementById(`mt5-card-${symbol}`);
    if (!card) return;
    // Only re-render if MT5 tab is active
    if (document.getElementById('mt5-pane')?.classList.contains('active')) {
        renderMT5Signals();
    }
}

// Filter MT5 signals by category
function filterMT5(cat, btn) {
    mt5Filter = cat;
    document.querySelectorAll('#mt5-pane .btn').forEach(b => {
        b.classList.remove('btn-teal');
        b.classList.add('btn-ghost');
    });
    if (btn) { btn.classList.remove('btn-ghost'); btn.classList.add('btn-teal'); }
    renderMT5Signals();
}

// Refresh signals
function refreshMT5Signals() {
    renderMT5Signals();
    notify('📊 MT5 Signals', 'Signals refreshed with latest price data.', 'info');
}

// Auto-refresh every 30 seconds when tab is active
setInterval(() => {
    if (document.getElementById('mt5-pane')?.classList.contains('active')) {
        renderMT5Signals();
    }
}, 30000);

// ================================================================
// CHART TAB — BB + RSI Live Indicator Bar
// ================================================================

function updateChartIndicators(symbol) {
    const sym = symbol || document.getElementById('chart-market-sel')?.value || 'R_10';
    const mm  = marketMemory[sym];
    if (!mm || mm.prices.length < 20) {
        document.getElementById('chart-signal')?.setAttribute('style','font-size:12px;font-weight:900;color:var(--muted)');
        const s = document.getElementById('chart-signal');
        if (s) s.textContent = 'Collecting data...';
        return;
    }

    const rsi = calcRSI(mm.prices, 14);
    const bb  = calcBollingerBands(mm.prices, 20, 2);

    if (rsi !== null) {
        const rsiEl    = document.getElementById('chart-rsi');
        const rsiLabel = document.getElementById('chart-rsi-label');
        if (rsiEl) {
            rsiEl.textContent = rsi;
            rsiEl.style.color = rsi > 70 ? '#f87171' : rsi < 30 ? '#34d399' : rsi > 50 ? '#60a5fa' : '#fbbf24';
        }
        if (rsiLabel) {
            const label = rsi > 70 ? 'Overbought' : rsi < 30 ? 'Oversold' : rsi > 60 ? 'Bullish' : rsi < 40 ? 'Bearish' : 'Neutral';
            rsiLabel.textContent = label;
        }
    }

    if (bb !== null) {
        const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        set('chart-bb-upper', bb.upper.toFixed(4));
        set('chart-bb-mid',   bb.middle.toFixed(4));
        set('chart-bb-lower', bb.lower.toFixed(4));
        set('chart-bb-width', bb.bandwidth.toFixed(2) + '%');
        const bbLabel = document.getElementById('chart-bb-label');
        if (bbLabel) bbLabel.textContent = bb.bandwidth > 0.2 ? 'Expanding 📈' : bb.bandwidth < 0.05 ? 'Squeezing ⚠️' : 'Normal';
    }

    // Show BB+RSI signal for Only Ups/Downs
    const sig     = generateOnlyUpsDownsSignal(sym);
    const sigEl   = document.getElementById('chart-signal');
    if (sigEl) {
        if (sig) {
            sigEl.textContent  = `${sig.direction} ${sig.confidence}% — ${sig.ticks} ticks`;
            sigEl.style.color  = sig.color;
        } else {
            sigEl.textContent  = 'No clear signal';
            sigEl.style.color  = 'var(--muted)';
        }
    }
}

// Auto-update chart indicators every 5 seconds when chart tab is active
setInterval(() => {
    if (document.getElementById('chart-pane')?.classList.contains('active')) {
        const sym = document.getElementById('chart-market-sel')?.value || 'R_10';
        updateChartIndicators(sym);
    }
}, 5000);

// ================================================================
// ACCUMULATOR ENGINE
// Full accumulator trading directly on btraderhub.com
// ================================================================

let accuRunning      = false;
let accuContractId   = null;
let accuGrowthRate   = 0.02; // default 2%
let accuTickCount    = 0;
let accuCurrentProfit = 0;
let accuMarket       = 'R_10';
let accuAnalysisTimer = null;

// Idempotency guard — Deriv can (and does) send more than one
// proposal_open_contract update for the same settled contract. Without this
// guard the settlement branch below would run twice for one trade, which is
// what caused duplicate TP/Loss notifications and double-counted stats, and
// could also knock Auto Mode into an inconsistent state (looking like it
// "stopped unexpectedly"). We only ever process a given contract_id's
// settlement once.
let accuSettledContractIds = new Set();

// Rolling bandwidth history per market — used to detect a BB squeeze
// followed by a healthy expansion (the "compression → breakout" filter).
let accuBandwidthHistory = {};

// Cache of the latest confidence breakdown per market so the history table
// and any future "trade analytics" view can reference exactly what the
// engine saw when a trade was opened.
let accuLastConfidence = {};
let accuTradeAnalytics = []; // log of factors for every completed trade

function onAccuMarketChange(sym) {
    accuMarket = sym;
    updateAccuAnalysis(sym);
    updateAccuProfitCalc();
    // Subscribe to ticks for analysis
    subscribeDigitFeed(sym);
}

function selectAccuGrowth(rate, btn) {
    accuGrowthRate = rate;
    document.querySelectorAll('#accu-pane .btn').forEach(b => {
        if (['1%','2%','3%','4%','5%'].includes(b.textContent)) {
            b.classList.remove('btn-teal');
            b.classList.add('btn-ghost');
        }
    });
    if (btn) { btn.classList.remove('btn-ghost'); btn.classList.add('btn-teal'); }
    updateAccuProfitCalc();
}

// ================================================================
// MULTI-FACTOR ACCUMULATOR CONFIDENCE ENGINE
// Combines Trend (EMA/ADX), Volatility, Bollinger Bands, RSI, ATR and
// Tick Stability into a single weighted confidence score (0-100%).
// Weighting: Trend 25% | Volatility 20% | RSI 15% | BB 15% | ATR 15% | Tick Stability 10%
// ================================================================
function calcAccuConfidence(sym) {
    const mm = marketMemory[sym] || { prices: [] };
    const prices = mm.prices || [];

    if (prices.length < 30) {
        return { ready: false, ticksNeeded: 30 - prices.length };
    }

    const last  = prices[prices.length - 1];
    const ema20 = calcEMA(prices, 20);
    const ema50 = calcEMA(prices, Math.min(50, prices.length - 1));
    const adx   = calcADX(prices, 14);
    const rsi   = calcRSI(prices, 14);
    const bb    = calcBollingerBands(prices, 20, 2);
    const atr   = calcATR(prices, 14);
    const stab  = calcTickStability(prices);

    // ── 1) TREND FILTER (25%) — EMA20 > EMA50, price above both, ADX 20-25+ ──
    let trendScore = 0;
    let emaTrendLabel = '—';
    if (ema20 !== null && ema50 !== null) {
        const emaAligned   = ema20 > ema50;
        const priceAboveBoth = last > ema20 && last > ema50;
        emaTrendLabel = emaAligned ? '📈 Bullish (EMA20>50)' : '📉 Bearish (EMA20<50)';
        if (emaAligned && priceAboveBoth) trendScore += 60;
        else if (emaAligned || priceAboveBoth) trendScore += 25;
        if (adx !== null) {
            if (adx >= 25) trendScore += 40;
            else if (adx >= 20) trendScore += 28;
            else if (adx >= 15) trendScore += 12;
        }
    }
    trendScore = Math.min(100, trendScore);

    // ── 2) VOLATILITY FILTER (20%) — stable, smooth ticks, no spikes ──
    let volScore = 0;
    if (stab) {
        // Reuse tick-stability score as the volatility-smoothness proxy —
        // "stable, smooth, no sudden spikes" is exactly what that measures.
        volScore = stab.score;
    }

    // ── 3) RSI FILTER (15%) — high-probability zone 52-65, avoid >70 or <45 ──
    let rsiScore = 0;
    if (rsi !== null) {
        if (rsi > 70 || rsi < 45) rsiScore = 0;
        else if (rsi >= 52 && rsi <= 65) rsiScore = 100;
        else if (rsi > 45 && rsi < 52) rsiScore = 55; // approaching the zone
        else if (rsi > 65 && rsi <= 70) rsiScore = 40; // leaving the zone
    }

    // ── 4) BOLLINGER BAND FILTER (15%) — squeeze then healthy expansion, aligned with trend ──
    let bbScore = 0;
    if (bb) {
        if (!accuBandwidthHistory[sym]) accuBandwidthHistory[sym] = [];
        const hist = accuBandwidthHistory[sym];
        hist.push(bb.bandwidth);
        if (hist.length > 30) hist.shift();

        const recentMin = Math.min(...hist);
        const wasSqueezed = recentMin < 0.15; // saw a compression recently
        const nowExpanding = bb.bandwidth > recentMin * 1.3 && bb.bandwidth > 0.15;
        const trendUp = ema20 !== null && ema50 !== null && ema20 > ema50;
        const alignedWithTrend = (trendUp && last > bb.middle) || (!trendUp && last < bb.middle);

        if (wasSqueezed && nowExpanding && alignedWithTrend) bbScore = 100;
        else if (wasSqueezed && nowExpanding) bbScore = 70;
        else if (bb.bandwidth > 0.1 && bb.bandwidth < 0.4) bbScore = 45; // healthy, not extreme
        else bbScore = 15;
    }

    // ── 5) ATR FILTER (15%) — avoid sudden spikes / abnormal highs / extreme lows ──
    let atrScore = 0;
    let atrLabel = '—';
    if (atr !== null) {
        if (!accuBandwidthHistory[sym + '_atr']) accuBandwidthHistory[sym + '_atr'] = [];
        const atrHist = accuBandwidthHistory[sym + '_atr'];
        atrHist.push(atr);
        if (atrHist.length > 30) atrHist.shift();
        const atrAvg = atrHist.reduce((a,b)=>a+b,0) / atrHist.length;
        const ratio  = atrAvg > 0 ? atr / atrAvg : 1;
        if (ratio >= 0.5 && ratio <= 2) { atrScore = 100; atrLabel = 'Normal range'; }
        else if (ratio > 2 && ratio <= 3) { atrScore = 45; atrLabel = 'Elevated — caution'; }
        else if (ratio > 3) { atrScore = 0; atrLabel = '⚠️ Spike — avoid'; }
        else { atrScore = 30; atrLabel = 'Abnormally low'; }
    }

    // ── 6) TICK STABILITY FILTER (10%) — last 100 ticks smoothness ──
    let stabilityScore = stab ? stab.score : 0;

    // ── WEIGHTED CONFIDENCE SCORE ──
    const weights = { trend: 0.25, vol: 0.20, rsi: 0.15, bb: 0.15, atr: 0.15, stability: 0.10 };
    const score = Math.round(
        trendScore      * weights.trend +
        volScore        * weights.vol   +
        rsiScore        * weights.rsi   +
        bbScore         * weights.bb    +
        atrScore        * weights.atr   +
        stabilityScore  * weights.stability
    );

    let label, color, tradeOk;
    if (score >= 90)      { label = '🟢 Excellent Entry'; color = 'var(--green)'; tradeOk = true;  }
    else if (score >= 80) { label = '🟢 Great Entry';     color = 'var(--green)'; tradeOk = true;  }
    else if (score >= 70) { label = '🟡 Good Entry';      color = 'var(--amber)'; tradeOk = true;  }
    else                  { label = '🔴 No Trade';        color = 'var(--red)';   tradeOk = false; }

    return {
        ready: true, score, label, color, tradeOk,
        ema20, ema50, emaTrendLabel, adx, rsi, bb, atr, atrLabel, stab,
        breakdown: { trendScore, volScore, rsiScore, bbScore, atrScore, stabilityScore }
    };
}

function updateAccuAnalysis(sym) {
    const conf = calcAccuConfidence(sym);
    accuLastConfidence[sym] = conf;

    const set = (id,v,col) => { const el=document.getElementById(id); if(el){ el.textContent=v; if(col) el.style.color=col; } };

    if (!conf.ready) {
        set('accu-rsi', '—'); set('accu-rsi-label', 'Collecting...');
        set('accu-bb-width', '—'); set('accu-bb-label', 'Collecting...');
        set('accu-adx', '—'); set('accu-adx-label', 'Collecting...');
        set('accu-ema-trend', '—');
        set('accu-atr', '—');
        set('accu-tick-stability', '—');
        const sigBox = document.getElementById('accu-signal-box');
        if (sigBox) sigBox.innerHTML = `<div style="font-size:11px;color:var(--muted);">Collecting data... need ${conf.ticksNeeded} more ticks</div>`;
        // Volatility bar placeholder while collecting
        const volMap = { R_10:15, R_25:30, R_50:50, R_75:75, R_100:90, '1HZ10V':35, '1HZ25V':50, '1HZ50V':65, '1HZ75V':80, '1HZ100V':95 };
        const volScore = volMap[sym] || 50;
        const volBar   = document.getElementById('accu-vol-bar');
        const volLabel = document.getElementById('accu-vol-label');
        if (volBar)   { volBar.style.width = volScore + '%'; volBar.style.background = volScore < 30 ? 'var(--green)' : volScore < 60 ? 'var(--amber)' : 'var(--red)'; }
        if (volLabel) { volLabel.textContent = volScore < 30 ? 'Low ✅' : volScore < 60 ? 'Medium ⚠️' : 'High ❌'; volLabel.style.color = volBar ? volBar.style.background : ''; }
        return;
    }

    // RSI
    set('accu-rsi', conf.rsi ?? '—', conf.rsi > 70 ? 'var(--red)' : conf.rsi < 30 ? 'var(--green)' : '#60a5fa');
    set('accu-rsi-label', conf.rsi > 70 ? 'Overbought' : conf.rsi < 30 ? 'Oversold' : (conf.rsi >= 52 && conf.rsi <= 65) ? 'Sweet spot' : 'Neutral');

    // BB
    if (conf.bb) {
        set('accu-bb-width', conf.bb.bandwidth.toFixed(2) + '%', conf.bb.bandwidth < 0.1 ? 'var(--green)' : conf.bb.bandwidth < 0.3 ? 'var(--amber)' : 'var(--red)');
        set('accu-bb-label', conf.bb.bandwidth < 0.1 ? 'Squeezing ✅' : conf.bb.bandwidth < 0.3 ? 'Normal ⚠️' : 'Wide ❌');
    }

    // ADX
    set('accu-adx', conf.adx ?? '—', conf.adx >= 25 ? 'var(--green)' : conf.adx >= 20 ? 'var(--amber)' : 'var(--muted)');
    set('accu-adx-label', conf.adx >= 25 ? 'Strong trend' : conf.adx >= 20 ? 'Building' : 'Weak/sideways');

    // EMA trend
    set('accu-ema-trend', conf.emaTrendLabel, conf.ema20 > conf.ema50 ? 'var(--green)' : 'var(--red)');

    // ATR
    set('accu-atr', conf.atr !== null ? conf.atr.toFixed(5) : '—', conf.breakdown.atrScore >= 70 ? 'var(--green)' : conf.breakdown.atrScore >= 40 ? 'var(--amber)' : 'var(--red)');

    // Tick stability
    if (conf.stab) {
        set('accu-tick-stability', `${conf.stab.score}/100`, conf.stab.score >= 70 ? 'var(--green)' : conf.stab.score >= 40 ? 'var(--amber)' : 'var(--red)');
    }

    // Volatility meter — driven by the same volatility sub-score now
    const volBar   = document.getElementById('accu-vol-bar');
    const volLabel = document.getElementById('accu-vol-label');
    const volPct   = 100 - conf.breakdown.volScore; // invert: higher instability = higher bar
    if (volBar)   { volBar.style.width = Math.max(5, volPct) + '%'; volBar.style.background = conf.breakdown.volScore >= 70 ? 'var(--green)' : conf.breakdown.volScore >= 40 ? 'var(--amber)' : 'var(--red)'; }
    if (volLabel) { volLabel.textContent = conf.breakdown.volScore >= 70 ? 'Low ✅' : conf.breakdown.volScore >= 40 ? 'Medium ⚠️' : 'High ❌'; volLabel.style.color = volBar ? volBar.style.background : ''; }

    // Safe ticks in a row (kept for the "Live Price" card context)
    const safeTicks = document.getElementById('accu-safe-ticks');
    const mm = marketMemory[sym];
    if (safeTicks && mm && mm.prices.length >= 5) {
        const recent = mm.prices.slice(-20);
        let consecutive = 0;
        for (let i = recent.length-1; i > 0; i--) {
            const change = Math.abs((recent[i] - recent[i-1]) / recent[i-1]) * 100;
            if (change < 0.5) consecutive++;
            else break;
        }
        safeTicks.textContent = consecutive;
        safeTicks.style.color = consecutive > 10 ? 'var(--green)' : consecutive > 5 ? 'var(--amber)' : 'var(--red)';
    }

    // Entry signal / confidence score box
    const sigBox    = document.getElementById('accu-signal-box');
    const growthRec = document.getElementById('accu-growth-rec');
    if (sigBox) {
        const b = conf.breakdown;
        sigBox.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
                <div style="font-size:16px;font-weight:900;color:${conf.color};">${conf.label}</div>
                <div style="font-size:20px;font-weight:900;color:${conf.color};">${conf.score}%</div>
            </div>
            <div class="pbar" style="margin-bottom:8px;"><div class="pbar-fill" style="width:${conf.score}%;background:${conf.color};"></div></div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:9px;color:var(--muted);text-align:left;">
                <div>Trend (25%): <b style="color:var(--text);">${Math.round(b.trendScore)}</b></div>
                <div>Volatility (20%): <b style="color:var(--text);">${Math.round(b.volScore)}</b></div>
                <div>RSI (15%): <b style="color:var(--text);">${Math.round(b.rsiScore)}</b></div>
                <div>Bollinger (15%): <b style="color:var(--text);">${Math.round(b.bbScore)}</b></div>
                <div>ATR (15%): <b style="color:var(--text);">${Math.round(b.atrScore)}</b></div>
                <div>Tick Stability (10%): <b style="color:var(--text);">${Math.round(b.stabilityScore)}</b></div>
            </div>`;

        // Recommend growth rate based on the volatility sub-score
        const recRate = b.volScore >= 75 ? '3%' : b.volScore >= 50 ? '2%' : '1%';
        if (growthRec) growthRec.textContent = `AI recommends: ${recRate} for this market`;
    }
}

function updateAccuProfitCalc() {
    const stake  = parseFloat(document.getElementById('accu-stake')?.value || 1);
    const table  = document.getElementById('accu-profit-table');
    if (!table) return;

    const milestones = [5, 10, 15, 20, 25, 30, 50];
    table.innerHTML = milestones.map(ticks => {
        const profit = stake * (Math.pow(1 + accuGrowthRate, ticks) - 1);
        const total  = stake + profit;
        return `<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--border);">
            <span style="color:var(--muted);">${ticks} ticks</span>
            <span style="color:var(--green);font-weight:700;font-family:monospace;">+$${profit.toFixed(2)}</span>
            <span style="color:var(--text);font-family:monospace;">= $${total.toFixed(2)}</span>
        </div>`;
    }).join('');
}

function toggleAccumulator() {
    if (!derivWS || derivWS.readyState !== WebSocket.OPEN) {
        notify("Not Connected", "Please log in to your Deriv account first.", 'err');
        return;
    }

    // If waiting for great entry, cancel
    if (accuWaiting) { cancelWaiting(); return; }

    const btn = document.getElementById('accu-run-btn');
    const sellBtn = document.getElementById('accu-sell-btn');

    if (!accuRunning) {
        const stake = parseFloat(document.getElementById('accu-stake')?.value || 1);
        const tp    = parseFloat(document.getElementById('accu-tp')?.value || 0.10);
        if (stake < 1) { notify("Invalid Stake", "Minimum accumulator stake is $1.", 'err'); return; }

        // Check confidence score before starting
        const conf = calcAccuConfidence(accuMarket);
        if (conf.ready && !conf.tradeOk) {
            notify('⚠️ Poor Entry Conditions', `Confidence ${conf.score}% (${conf.label}). Waiting for a better entry...`, 'warn');
            log(`⏳ Waiting for a qualifying entry (current: ${conf.score}%)...`, 'x');
            startWatchingForGreatEntry(stake, tp);
            return;
        }

        accuRunning       = true;
        accuTickCount     = 0;
        accuCurrentProfit = 0;

        if (btn)     { btn.textContent = '⬛ Stop Accumulator'; btn.classList.remove('btn-teal'); btn.classList.add('btn-red'); }
        if (sellBtn)  sellBtn.style.display = 'block';

        // Send accumulator proposal
        const proposal = {
            proposal:          1,
            amount:            stake,
            basis:             "stake",
            contract_type:     "ACCU",
            currency:          "USD",
            underlying_symbol: accuMarket,
            growth_rate:       accuGrowthRate,
            limit_order:       { take_profit: tp },
            req_id:            nextReqId()
        };

        log(`📈 Accumulator proposal: ${MKT[accuMarket]||accuMarket} | Growth: ${(accuGrowthRate*100)}% | Stake: $${stake} | TP: $${tp} | Confidence: ${conf.ready ? conf.score+'%' : 'n/a'}`, 'i');
        derivWS.send(JSON.stringify(proposal));

    } else {
        // Stop — sell the contract
        sellAccumulator();
    }
}

function sellAccumulator() {
    if (!accuContractId) {
        accuRunning = false;
        resetAccuUI();
        return;
    }
    // Sell contract to take profit
    derivWS.send(JSON.stringify({ sell: accuContractId, price: 0, req_id: nextReqId() }));
    log(`💰 Selling accumulator contract #${accuContractId}`, 'i');
}

function resetAccuUI() {
    const btn     = document.getElementById('accu-run-btn');
    const sellBtn = document.getElementById('accu-sell-btn');
    accuRunning    = false;
    accuContractId = null;
    if (btn)     { btn.textContent = '▶ Start Accumulator'; btn.classList.remove('btn-red'); btn.classList.add('btn-teal'); }
    if (sellBtn)  sellBtn.style.display = 'none';
    const info = document.getElementById('accu-contract-info');
    if (info) info.textContent = 'No active contract';
}

// ── FULL RESET — clears everything for a fresh Accumulator session
// without reloading the page, similar to DBot's Reset button. ──
function resetAccumulator() {
    // Stop any running contract / watcher / auto mode first
    if (accuWatchInterval) { clearInterval(accuWatchInterval); accuWatchInterval = null; }
    accuWaiting = false;
    if (accuAutoEnabled) {
        // Silent stop — we're about to reset everything anyway
        accuAutoEnabled = false;
        const track = document.getElementById('accu-auto-track');
        const thumb = document.getElementById('accu-auto-thumb');
        const bar   = document.getElementById('accu-auto-bar');
        if (track) track.style.background = 'var(--border)';
        if (thumb) thumb.style.left       = '3px';
        if (bar)   bar.style.display      = 'none';
    }
    accuAutoRunning = false;
    if (accuRunning && accuContractId && derivWS && derivWS.readyState === WebSocket.OPEN) {
        derivWS.send(JSON.stringify({ sell: accuContractId, price: 0, req_id: nextReqId() }));
    }

    // Reset session state
    accuRunning        = false;
    accuContractId     = null;
    accuTickCount       = 0;
    accuCurrentProfit   = 0;
    accuSessions        = 0;
    accuTpHits          = 0;
    accuTotalPL         = 0;
    accuNotifFired      = false;
    accuSettledContractIds = new Set();
    accuTradeAnalytics  = [];

    // Reset UI
    resetAccuUI();
    updateAccuAutoStats();
    const priceEl  = document.getElementById('accu-price');
    const digitEl  = document.getElementById('accu-last-digit');
    const tickEl   = document.getElementById('accu-tick-count');
    const profitEl = document.getElementById('accu-current-profit');
    if (priceEl)  priceEl.textContent  = '—';
    if (digitEl)  digitEl.textContent  = 'Last digit: —';
    if (tickEl)   tickEl.textContent   = '0';
    if (profitEl) { profitEl.textContent = '$0.00'; profitEl.style.color = 'var(--green)'; }

    const h = document.getElementById('accu-history');
    if (h) h.innerHTML = '<div style="font-size:11px;color:var(--dim);text-align:center;padding:16px;">No accumulator trades yet</div>';

    // Clear any leftover notification suppression keys for a clean slate
    const btn = document.getElementById('accu-run-btn');
    if (btn) { btn.style.opacity = '1'; }

    log('🔄 Accumulator session reset — ready for a fresh start', 'i');
    notify('🔄 Accumulator Reset', 'Session cleared. Profit/loss, history and counters are back to zero.', 'ok');
}

function handleAccuContractUpdate(c) {
    if (!c) return;

    // Update tick count and current profit
    const tickEl   = document.getElementById('accu-tick-count');
    const profitEl = document.getElementById('accu-current-profit');
    const infoEl   = document.getElementById('accu-contract-info');

    if (c.tick_count !== undefined && tickEl) {
        accuTickCount = c.tick_count;
        tickEl.textContent = accuTickCount;
        tickEl.style.color = accuTickCount > 15 ? 'var(--green)' : accuTickCount > 5 ? 'var(--amber)' : 'var(--teal)';
    }

    if (c.profit !== undefined) {
        accuCurrentProfit = parseFloat(c.profit);
        if (profitEl) {
            profitEl.textContent = `$${accuCurrentProfit.toFixed(2)}`;
            profitEl.style.color = accuCurrentProfit >= 0 ? 'var(--green)' : 'var(--red)';
        }
    }

    if (infoEl) {
        infoEl.innerHTML = `
            <div style="font-size:11px;">Contract: <b style="color:var(--teal);">#${c.contract_id||'—'}</b></div>
            <div style="font-size:11px;">Growth Rate: <b style="color:var(--teal);">${((accuGrowthRate||0.02)*100)}%</b></div>
            <div style="font-size:11px;">Ticks: <b style="color:var(--green);">${accuTickCount}</b></div>`;
    }

    // Contract settled — this path is superseded by the idempotent override
    // installed below, which is the one actually wired up at runtime.
    if (c.is_sold || c.is_expired) {
        if (accuSettledContractIds.has(c.contract_id)) return; // already processed
        accuSettledContractIds.add(c.contract_id);

        const profit   = parseFloat(c.profit || 0);
        const stake    = parseFloat(document.getElementById('accu-stake')?.value || 1);
        const isWin    = profit > 0;

        // Add to history
        addAccuHistory(accuMarket, accuGrowthRate, stake, accuTickCount, profit, isWin);

        log(`${isWin ? '✅' : '❌'} Accumulator ${isWin ? 'sold' : 'knocked out'} | ${accuTickCount} ticks | P/L: $${profit.toFixed(2)}`, isWin ? 'w' : 'l');

        if (isWin) { try { playWin(); } catch(e) {} }
        else       { try { playLoss(); } catch(e) {} }

        resetAccuUI();
        if (profitEl) { profitEl.textContent = `$${profit.toFixed(2)}`; profitEl.style.color = isWin ? 'var(--green)' : 'var(--red)'; }
    }
}

function addAccuHistory(market, growth, stake, ticks, profit, isWin, confidence) {
    const container = document.getElementById('accu-history');
    if (!container) return;
    const empty = container.querySelector('[style*="text-align:center"]');
    if (empty) empty.remove();

    const confStr = (confidence !== undefined && confidence !== null) ? `${confidence}%` : '—';

    const row = document.createElement('div');
    row.style.cssText = `display:flex;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-size:11px;`;
    row.innerHTML = `
        <div style="width:70px;color:var(--muted);">${MKT[market]?.replace('Volatility','V')||market}</div>
        <div style="flex:1;color:var(--muted);">${(growth*100)}%</div>
        <div style="width:60px;font-family:monospace;">$${stake.toFixed(2)}</div>
        <div style="width:60px;color:var(--teal);">${ticks}</div>
        <div style="width:60px;color:var(--amber);">${confStr}</div>
        <div style="width:90px;text-align:right;font-weight:700;font-family:monospace;color:${isWin?'var(--green)':'var(--red)'};">${isWin?'+':''}$${profit.toFixed(2)}</div>`;
    container.insertBefore(row, container.firstChild);
}

// Wire into routeMsg for accumulator proposal + contract updates
// handled in existing proposal and proposal_open_contract handlers

// ================================================================
// ACCUMULATOR ENTRY QUALITY CHECK — now backed by the multi-factor
// confidence engine above. Kept as a thin wrapper for readability at
// call sites and for backwards compatibility with existing code paths.
// ================================================================

function getAccuEntryQuality(sym) {
    const conf = calcAccuConfidence(sym);
    if (!conf.ready) return 'loading';
    if (conf.score >= 80) return 'great';
    if (conf.score >= 70) return 'ok';
    return 'bad';
}

let accuWatchInterval = null;
let accuWaiting       = false;

function startWatchingForGreatEntry(stake, tp) {
    if (accuWatchInterval) clearInterval(accuWatchInterval);
    accuWaiting = true;

    // Update run button to show waiting state
    const btn = document.getElementById('accu-run-btn');
    if (btn) { btn.textContent = '⏳ Waiting for Great Entry...'; btn.style.opacity = '0.7'; }

    log('⏳ Watching for a qualifying confidence score...', 'i');

    accuWatchInterval = setInterval(() => {
        if (!accuWaiting) { clearInterval(accuWatchInterval); return; }

        const conf = calcAccuConfidence(accuMarket);
        if (!conf.ready) { log('📊 Still collecting data for confidence score...', 'd'); return; }

        const threshold = parseFloat(document.getElementById('accu-conf-threshold')?.value || 85);
        log(`📊 Confidence: ${conf.score}% (${conf.label}) — need ${threshold}%+ for Auto Mode, 70%+ for manual`, 'd');

        // Manual (non-auto) start only needs "Good Entry" or better (tradeOk).
        // Auto Mode is stricter and defers to the user's confidence threshold —
        // that check happens where startWatchingForGreatEntry is called from
        // the auto-restart path, via the threshold comparison here.
        const isAutoRestart = accuAutoRunning;
        const qualifies = isAutoRestart ? conf.score >= threshold : conf.tradeOk;

        if (qualifies) {
            clearInterval(accuWatchInterval);
            accuWaiting = false;
            const btn = document.getElementById('accu-run-btn');
            if (btn) { btn.textContent = '▶ Start Accumulator'; btn.style.opacity = '1'; }
            notify('✅ Qualifying Entry Found!', `Confidence ${conf.score}% (${conf.label}). Starting accumulator now!`, 'ok');
            log(`✅ Qualifying entry detected (${conf.score}%) — starting accumulator!`, 'w');
            // Auto start
            toggleAccumulator();
        }
    }, 3000); // check every 3 seconds
}

// Stop watching if user clicks run button again
function cancelWaiting() {
    if (accuWatchInterval) clearInterval(accuWatchInterval);
    accuWaiting = false;
    const btn = document.getElementById('accu-run-btn');
    if (btn) { btn.textContent = '▶ Start Accumulator'; btn.style.opacity = '1'; }
    log('❌ Entry watch cancelled', 'x');
}

// ================================================================
// ACCUMULATOR AUTO MODE
// Runs continuously — entering a new trade whenever a qualifying signal
// appears — until Take Profit, Stop Loss, manual stop, connection loss,
// or an unrecoverable API error. See toggleAccuAuto / stopAccuAuto and the
// idempotent settlement handler below for the restart / stop logic.
// ================================================================

let accuAutoEnabled    = false;
let accuSessions       = 0;
let accuTpHits         = 0;
let accuTotalPL        = 0;
let accuAutoRunning    = false;
let accuNotifFired     = false; // prevents duplicate notifications

function toggleAccuAuto() {
    accuAutoEnabled = !accuAutoEnabled;
    const track = document.getElementById('accu-auto-track');
    const thumb = document.getElementById('accu-auto-thumb');
    const stats = document.getElementById('accu-auto-stats');
    const bar   = document.getElementById('accu-auto-bar');

    if (track) track.style.background = accuAutoEnabled ? 'var(--teal)' : 'var(--border)';
    if (thumb) thumb.style.left       = accuAutoEnabled ? '23px' : '3px';
    if (stats) stats.style.display    = accuAutoEnabled ? 'block' : 'none';
    if (bar)   bar.style.display      = accuAutoEnabled && accuAutoRunning ? 'flex' : 'none';

    log(`🤖 Accumulator Auto Mode: ${accuAutoEnabled ? 'ON' : 'OFF'}`, 'i');
    if (accuAutoEnabled) {
        const sl = parseFloat(document.getElementById('accu-sl')?.value || 0);
        notify('🤖 Auto Mode ON', `Bot will trade continuously.\nTP: $${document.getElementById('accu-tp')?.value || 0.10} per session${sl > 0 ? ` | SL: -$${sl.toFixed(2)} total` : ''}`, 'ok');
    }
}

// reason is optional — 'connection_lost' | 'api_error' | 'stop_loss' | undefined (manual)
function stopAccuAuto(reason) {
    accuAutoEnabled  = false;
    accuAutoRunning  = false;
    if (accuWatchInterval) { clearInterval(accuWatchInterval); accuWatchInterval = null; }
    accuWaiting = false;

    const track = document.getElementById('accu-auto-track');
    const thumb = document.getElementById('accu-auto-thumb');
    const bar   = document.getElementById('accu-auto-bar');
    if (track) track.style.background = 'var(--border)';
    if (thumb) thumb.style.left       = '3px';
    if (bar)   bar.style.display      = 'none';

    // Stop current contract if running (skip for connection loss — socket is already gone)
    if (accuRunning && reason !== 'connection_lost') sellAccumulator();

    const summary = `Sessions: ${accuSessions} | TP Hits: ${accuTpHits} | Total P/L: $${accuTotalPL.toFixed(2)}`;
    log(`🤖 Auto Mode stopped${reason ? ' (' + reason + ')' : ''}. ${summary}`, 'i');

    if (reason === 'stop_loss') {
        notify('⛔ Stop Loss Reached', `Auto Mode stopped — Stop Loss hit.\n${summary}`, 'err');
    } else if (reason === 'connection_lost') {
        notify('📡 Connection Lost', `Auto Mode stopped — API connection dropped.\n${summary}`, 'err');
    } else if (reason === 'api_error') {
        notify('⚠️ API Error', `Auto Mode stopped — unrecoverable API error.\n${summary}`, 'err');
    } else {
        notify('🤖 Auto Mode Stopped', summary, 'ok');
    }
}

function updateAccuAutoStats() {
    const set = (id, val, col) => {
        const el = document.getElementById(id);
        if (el) { el.textContent = val; if (col) el.style.color = col; }
    };
    set('accu-sessions',      accuSessions);
    set('accu-auto-sessions', accuSessions);
    set('accu-tp-hits',       accuTpHits);
    set('accu-total-pl',      `$${accuTotalPL.toFixed(2)}`, accuTotalPL >= 0 ? 'var(--green)' : 'var(--red)');
    set('accu-auto-pl',       `$${accuTotalPL.toFixed(2)}`, accuTotalPL >= 0 ? 'var(--green)' : 'var(--red)');
}

// Idempotent, single source of truth for accumulator settlement.
// Every proposal_open_contract update for a settled contract is routed
// here; accuSettledContractIds ensures we only act on it ONCE no matter
// how many duplicate update messages Deriv sends for the same contract_id.
// This is also what fixes "Auto Mode stops unexpectedly" — before this
// guard, a duplicate settlement message could re-enter the settlement
// branch, sell/reset state a second time, and desync accuRunning from
// what the UI showed, silently breaking the restart chain.
handleAccuContractUpdate = function(c) {
    if (!c) return;

    // Update tick count and profit display
    const tickEl   = document.getElementById('accu-tick-count');
    const profitEl = document.getElementById('accu-current-profit');
    const infoEl   = document.getElementById('accu-contract-info');

    // Count ticks ourselves — increment on every contract update message
    // Deriv sends proposal_open_contract on every tick while contract is active
    if (!c.is_sold && !c.is_expired && accuContractId && c.contract_id === accuContractId) {
        accuTickCount++;
    }

    // On settlement, use the most reliable source available
    if (c.is_sold || c.is_expired) {
        const derivedFromRemaining = c.tick_count_remaining !== undefined
            ? (c.tick_count - (c.tick_count_remaining || 0))
            : null;
        accuTickCount = parseInt(c.current_spot_count || c.number_of_ticks || derivedFromRemaining || accuTickCount) || accuTickCount;
    }

    if (tickEl) {
        tickEl.textContent = accuTickCount;
        tickEl.style.color = accuTickCount > 15 ? 'var(--green)' : accuTickCount > 5 ? 'var(--amber)' : 'var(--teal)';
    }
    if (c.profit !== undefined) {
        accuCurrentProfit = parseFloat(c.profit);
        if (profitEl) {
            profitEl.textContent = `$${accuCurrentProfit.toFixed(2)}`;
            profitEl.style.color = accuCurrentProfit >= 0 ? 'var(--green)' : 'var(--red)';
        }
    }
    if (infoEl && c.contract_id) {
        infoEl.innerHTML = `
            <div style="font-size:11px;">Contract: <b style="color:var(--teal);">#${c.contract_id}</b></div>
            <div style="font-size:11px;">Growth Rate: <b style="color:var(--teal);">${((accuGrowthRate||0.02)*100)}%</b></div>
            <div style="font-size:11px;">Ticks: <b style="color:var(--green);">${accuTickCount}</b></div>`;
    }

    // Contract settled (sold or knocked out) — IDEMPOTENT GUARD
    if (c.is_sold || c.is_expired) {
        if (!c.contract_id || accuSettledContractIds.has(c.contract_id)) {
            // Either no contract id to key on, or we've already fully
            // processed this settlement — ignore the duplicate update.
            return;
        }
        accuSettledContractIds.add(c.contract_id);

        const profit = parseFloat(c.profit || 0);
        const stake  = parseFloat(document.getElementById('accu-stake')?.value || 1);
        const isWin  = profit > 0;
        const tp     = parseFloat(document.getElementById('accu-tp')?.value || 0.10);
        const sl     = parseFloat(document.getElementById('accu-sl')?.value || 0);

        // Final tick count from contract — check all possible fields
        const finalTicks = c.current_spot_count || c.number_of_ticks || accuTickCount || 0;
        accuTickCount = parseInt(finalTicks) || accuTickCount;

        // Snapshot the confidence score that was live when this trade was opened
        const confSnapshot = accuLastConfidence[accuMarket];
        const confScore    = confSnapshot && confSnapshot.ready ? confSnapshot.score : undefined;

        // Update auto stats
        accuSessions++;
        accuTotalPL += profit;
        if (isWin && profit >= tp) accuTpHits++;
        updateAccuAutoStats();

        // Trade analytics log — confidence + underlying factors for this trade
        accuTradeAnalytics.push({
            time: new Date().toISOString(),
            market: accuMarket,
            confidence: confScore,
            rsi: confSnapshot?.rsi, atr: confSnapshot?.atr,
            bbWidth: confSnapshot?.bb?.bandwidth, emaTrend: confSnapshot?.emaTrendLabel,
            adx: confSnapshot?.adx, tickStability: confSnapshot?.stab?.score,
            ticks: accuTickCount, result: isWin ? 'TP' : 'Loss', profit
        });
        if (accuTradeAnalytics.length > 200) accuTradeAnalytics.shift();

        // Add to history (with confidence column)
        addAccuHistory(accuMarket, accuGrowthRate, stake, accuTickCount, profit, isWin, confScore);

        log(`${isWin ? '✅' : '❌'} Accumulator ${isWin?'sold':'knocked out'} | ${accuTickCount} ticks | P/L: $${profit.toFixed(2)} | Total: $${accuTotalPL.toFixed(2)}`, isWin ? 'w' : 'l');

        if (isWin) { try { playWin(); } catch(e) {} }
        else       { try { playLoss(); } catch(e) {} }

        // Reset UI — exactly once per settled contract, thanks to the guard above
        resetAccuUI();
        if (profitEl) { profitEl.textContent = `$${profit.toFixed(2)}`; profitEl.style.color = isWin ? 'var(--green)' : 'var(--red)'; }

        // ── STOP LOSS CHECK — takes priority over auto-restart ──
        if (accuAutoEnabled && sl > 0 && accuTotalPL <= -sl) {
            stopAccuAuto('stop_loss');
            return; // do not restart — Stop Loss reached
        }

        // AUTO MODE — restart after TP hit or after any settled contract
        if (accuAutoEnabled) {
            if (isWin) {
                if (!accuNotifFired) { accuNotifFired = true; notify('✅ TP Hit — Auto Restarting!', `+$${profit.toFixed(2)} | Session ${accuSessions} | Total: $${accuTotalPL.toFixed(2)}`, 'ok'); setTimeout(()=>{accuNotifFired=false;},3000); }
                log(`🤖 Auto restart in 1 second... (Session ${accuSessions + 1})`, 'i');
                setTimeout(() => {
                    if (accuAutoEnabled && derivWS && derivWS.readyState === WebSocket.OPEN) {
                        accuAutoRunning = true;
                        const bar = document.getElementById('accu-auto-bar');
                        if (bar) bar.style.display = 'flex';
                        const threshold = parseFloat(document.getElementById('accu-conf-threshold')?.value || 85);
                        const conf = calcAccuConfidence(accuMarket);
                        if (conf.ready && conf.score >= threshold) {
                            toggleAccumulator();
                        } else {
                            log(`⏳ Auto mode: waiting for confidence ≥ ${threshold}% before next session...`, 'i');
                            const stakeVal = parseFloat(document.getElementById('accu-stake')?.value || 1);
                            startWatchingForGreatEntry(stakeVal, tp);
                        }
                    }
                }, 1500);
            } else {
                // Knocked out — notify but also auto restart if still enabled and SL not hit
                if (!accuNotifFired) {
                    accuNotifFired = true;
                    notify('💥 Knocked Out — Auto Restarting!', `Lost $${Math.abs(profit).toFixed(2)} | Total: $${accuTotalPL.toFixed(2)}`, 'warn');
                    setTimeout(() => { accuNotifFired = false; }, 3000);
                }
                log(`🤖 Knocked out! Auto restarting in 2 seconds...`, 'x');
                setTimeout(() => {
                    if (accuAutoEnabled && derivWS && derivWS.readyState === WebSocket.OPEN) {
                        accuAutoRunning = true;
                        const threshold = parseFloat(document.getElementById('accu-conf-threshold')?.value || 85);
                        const conf = calcAccuConfidence(accuMarket);
                        if (conf.ready && conf.score >= threshold) {
                            toggleAccumulator();
                        } else {
                            const stakeVal = parseFloat(document.getElementById('accu-stake')?.value || 1);
                            startWatchingForGreatEntry(stakeVal, tp);
                        }
                    }
                }, 2000);
            }
        } else {
            // Manual mode notification
            notify(
                isWin ? '💰 Accumulator Profit!' : '💥 Accumulator Knocked Out!',
                `${accuTickCount} ticks | P/L: ${isWin?'+':''}$${profit.toFixed(2)}`,
                isWin ? 'ok' : 'err'
            );
        }
    }
};
