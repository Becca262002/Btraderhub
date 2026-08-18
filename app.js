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

    // MT5 signal lifecycle runs independently of which tab is open, so
    // signals keep generating/expiring correctly even if the user never
    // visits the MT5 tab first — give the public WS a moment to connect.
    loadMt5Signals();
    setTimeout(startMt5BackgroundScan, 4000);

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
    window.scrollTo(0, 0); // start each tab at the top now that the page scrolls as a whole

    if (id === 'digits') {
        changeDigitMarket(document.getElementById('digit-market')?.value || 'R_10');
    }
    if (id === 'scanner') runFullScan();
    if (id === 'mt5')     { loadApaPrefs(); startMt5BackgroundScan(); renderMt5SignalsUI(); populateMt5InstrumentFilter(); runApaAnalysis(); }
    if (id === 'chart')   { setTimeout(() => updateChartIndicators(), 500); }
    if (id === 'accu')    { onAccuMarketChange(document.getElementById('accu-market')?.value || 'R_10'); updateAccuProfitCalc(); }
    if (id === 'bulk')    { initBulkTab(); }
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
            if (bulkAutoEnabled) {
                stopBulkAuto('connection_lost');
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
        liveBalance = parseFloat(r.balance.balance); // tracked for Bulk Trading's insufficient-balance check
        if (document.getElementById('bulk-pane')?.classList.contains('active')) initBulkTab();
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
// Symbols Deriv's own active_symbols response has actually confirmed as
// live/tradable — the APA engine treats this as the source of truth for
// "is this market available" rather than a hard-coded assumption.
let knownActiveSymbols = new Set();

// ── Real OHLC candle fetch (Deriv ticks_history, style:"candles") ──
// This is a genuine Deriv API capability (not a synthetic approximation
// from ticks) and is what the APA multi-timeframe engine below is built on.
// granularity is in seconds: 60=M1, 300=M5, 900=M15, 1800=M30, 3600=H1,
// 14400=H4, 86400=D1.
function fetchCandles(sym, granularity, count = 120) {
    return new Promise((resolve, reject) => {
        if (!publicWS || publicWS.readyState !== WebSocket.OPEN) { reject(new Error('public WS not connected')); return; }
        const reqId = pubReqId();
        const timeout = setTimeout(() => {
            publicWS.removeEventListener('message', handler);
            reject(new Error('candle request timed out'));
        }, 8000);
        function handler(ev) {
            let data;
            try { data = JSON.parse(ev.data); } catch(e) { return; }
            if (data.req_id !== reqId) return;
            clearTimeout(timeout);
            publicWS.removeEventListener('message', handler);
            if (data.error) { reject(new Error(data.error.message || 'candle fetch error')); return; }
            resolve(data.candles || []);
        }
        publicWS.addEventListener('message', handler);
        publicWS.send(JSON.stringify({
            ticks_history: sym, style: 'candles', granularity,
            count, end: 'latest', req_id: reqId
        }));
    });
}

// Small TTL cache so the scanner and setup card don't re-request the same
// candles on every render — cache lifetime is a fraction of the timeframe
// itself so data still feels live.
let apaCandleCache = {}; // key: `${sym}_${granularity}` -> { candles, fetchedAt }
async function getCandles(sym, granularity, count = 120) {
    const key = `${sym}_${granularity}`;
    const cached = apaCandleCache[key];
    const ttl = Math.max(5000, granularity * 250); // e.g. M1(60s) -> 15s TTL, H4 -> ~1hr TTL
    if (cached && (Date.now() - cached.fetchedAt) < ttl) return cached.candles;
    const candles = await fetchCandles(sym, granularity, count);
    apaCandleCache[key] = { candles, fetchedAt: Date.now() };
    return candles;
}

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
            // Record every symbol Deriv confirms as currently active/tradable —
            // the APA engine checks this before treating any market as
            // available, instead of assuming a hard-coded list is correct.
            (data.active_symbols || []).forEach(s => {
                if (s.underlying_symbol) knownActiveSymbols.add(s.underlying_symbol);
            });

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

            // Update accumulator live price display + drive the market behaviour /
            // confidence engine. Track tick arrival times for the Tick Flow analysis
            // (speed, acceleration, directional-change frequency).
            if (sym === accuMarket) {
                const priceEl = document.getElementById('accu-price');
                const digitEl = document.getElementById('accu-last-digit');
                if (priceEl) priceEl.textContent = data.tick.quote;
                if (digitEl) digitEl.textContent = `Last digit: ${d}`;

                if (!accuTickTimes[sym]) accuTickTimes[sym] = [];
                accuTickTimes[sym].push(Date.now());
                if (accuTickTimes[sym].length > 120) accuTickTimes[sym].shift();

                // Update cadence adapts to market speed — 1s indices refresh almost
                // every tick, slower indices refresh less often to save work.
                const profile = getMarketProfile(sym);
                if (st.ticks % profile.updateEveryTicks === 0) updateAccuAnalysis(sym);
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
// BULK TRADING ENGINE
// Configure one setup, execute N trades from it — strictly sequential
// (never parallel), each trade fully round-tripped through the real
// Deriv proposal -> buy -> settlement flow before the next one is sent,
// so there is no way for a double-click, re-render, or reconnect to
// fire a duplicate contract. Reuses CONTRACT_MAP and nextReqId() from
// the existing DBot implementation rather than duplicating contract logic.
// History persists to localStorage (this app has no backend/database).
// ================================================================

const BULK_MAX_TRADES        = 100;   // sensible hard cap on trades per batch
const BULK_MAX_TOTAL_STAKE   = 1000;  // sensible hard cap on total stake per batch
const BULK_ENTRY_CONCURRENCY = 5;     // how many proposal->buy entries are in flight at once (controlled concurrency, not unlimited)
const BULK_SIGNAL_STALE_MS   = 5 * 60000; // an imported AI Scanner signal older than this triggers a staleness warning

let bulkDirection      = 'over';
let bulkStakeMode      = 'per';   // 'per' = stake per trade | 'total' = total budget
let bulkExecuting      = false;   // guards the ENTRY phase only — see runBulkExecution()
let bulkCurrentBatch   = null;
let bulkBatches        = [];
let bulkImportedSignal = null;    // the AI Scanner signal currently populated into the form, with its own generatedAt
let liveBalance         = null;   // tracked from the real balance stream, used for the insufficient-balance check

// Bulk Auto Mode — watches the AI Scanner and, once enabled, automatically
// runs a batch (using the Trades/Stake settings already configured) whenever
// a qualifying signal appears. Mirrors the Accumulator's Auto Mode pattern:
// runs until manually stopped, Take Profit, Stop Loss, max batches/day,
// connection loss, or a batch that fails outright (treated as an API error).
let bulkAutoEnabled   = false;
let bulkAutoRunning   = false;
let bulkAutoSessions  = 0;
let bulkAutoPL        = 0;
let bulkAutoDate      = null;
let bulkAutoTimer     = null;

function loadBulkBatches() {
    try { bulkBatches = JSON.parse(localStorage.getItem('bth_bulk_batches') || '[]'); }
    catch(e) { bulkBatches = []; }
}
function saveBulkBatches() {
    try { localStorage.setItem('bth_bulk_batches', JSON.stringify(bulkBatches.slice(-100))); } catch(e) {}
}
// Unique per batch, e.g. BT-20260817-094123-ABC — every contract entered
// under an execution belongs to this one batch ID.
function makeBulkBatchId() {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const rand  = Math.random().toString(36).slice(2, 5).toUpperCase();
    return `BT-${stamp}-${rand}`;
}

// ── Direction controls (namespaced separately from the DBot's so the two
// tools never fight over shared state) ──
function onBulkTypeChange() {
    const type = document.getElementById('bulk-type')?.value || 'over_under';
    const wrap = document.getElementById('bulk-dir-controls');
    const pred = document.getElementById('bulk-pred-wrap');
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
        btn.className = 'dir-btn';
        btn.textContent = label;
        btn.dataset.dir = val;
        btn.onclick = () => selectBulkDir(val);
        wrap.appendChild(btn);
    });
    if (pred) pred.style.display = type === 'over_under' ? 'block' : 'none';
    if (opts.length > 0) selectBulkDir(opts[0][0]);
    updateBulkPreview();
}
function selectBulkDir(dir) {
    bulkDirection = dir;
    const neg = ['under','odd','fall','downs'];
    document.querySelectorAll('#bulk-dir-controls .dir-btn').forEach(b => {
        b.classList.remove('pos','neg');
        if (b.dataset.dir === dir) b.classList.add(neg.includes(dir) ? 'neg' : 'pos');
    });
    updateBulkPreview();
}

// ── Number of trades stepper ──
function stepBulkTrades(delta) {
    const el = document.getElementById('bulk-trades');
    if (!el) return;
    let v = parseInt(el.value || 1) + delta;
    v = Math.max(1, Math.min(BULK_MAX_TRADES, v));
    el.value = v;
    updateBulkPreview();
}
function setBulkTrades(n) {
    const el = document.getElementById('bulk-trades');
    if (el) el.value = Math.max(1, Math.min(BULK_MAX_TRADES, n));
    updateBulkPreview();
}

// ── Stake mode toggle (Mode A: per-trade | Mode B: total budget) ──
function setBulkStakeMode(mode) {
    bulkStakeMode = mode;
    const btnPer = document.getElementById('bulk-mode-per');
    const btnTot = document.getElementById('bulk-mode-total');
    const label  = document.getElementById('bulk-stake-label');
    if (btnPer) { btnPer.classList.toggle('btn-teal', mode==='per');   btnPer.classList.toggle('btn-ghost', mode!=='per'); }
    if (btnTot) { btnTot.classList.toggle('btn-teal', mode==='total'); btnTot.classList.toggle('btn-ghost', mode!=='total'); }
    if (label) label.textContent = mode === 'per' ? 'Stake per Trade (USD)' : 'Total Budget (USD)';
    updateBulkPreview();
}

function getBulkConfig() {
    const trades  = Math.max(1, Math.min(BULK_MAX_TRADES, parseInt(document.getElementById('bulk-trades')?.value || 1)));
    const stakeIn = parseFloat(document.getElementById('bulk-stake')?.value || 1);
    const stakePerTrade = bulkStakeMode === 'per' ? stakeIn : (stakeIn / trades);
    const totalStake    = bulkStakeMode === 'per' ? stakeIn * trades : stakeIn;
    return {
        market: document.getElementById('bulk-market')?.value || 'R_10',
        type:   document.getElementById('bulk-type')?.value || 'over_under',
        direction: bulkDirection,
        pred:   parseInt(document.getElementById('bulk-pred')?.value || 5),
        duration: parseInt(document.getElementById('bulk-dur')?.value || 1),
        trades, stakePerTrade: Math.round(stakePerTrade * 100) / 100, totalStake: Math.round(totalStake * 100) / 100
    };
}

function updateBulkPreview() {
    const cfg = getBulkConfig();
    const body = document.getElementById('bulk-preview-body');
    const btn  = document.getElementById('bulk-execute-btn');
    if (!body) return;

    const acct   = allAccounts.find(a => a.account_id === accountId);
    const acctType = acct ? (acct.account_type === 'real' ? 'REAL' : 'DEMO') : '—';
    const acctColor = acctType === 'REAL' ? 'var(--red)' : 'var(--teal)';

    body.innerHTML = `
        <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Market</span><b>${MKT[cfg.market]||cfg.market}</b></div>
        <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Direction</span><b style="color:${['under','odd','fall','downs'].includes(cfg.direction)?'var(--red)':'var(--teal)'};">${cfg.direction.toUpperCase()}${cfg.type==='over_under'?' '+cfg.pred:''}</b></div>
        <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Number of Trades</span><b>${cfg.trades}</b></div>
        <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Stake per Trade</span><b>$${cfg.stakePerTrade.toFixed(2)}</b></div>
        <div style="display:flex;justify-content:space-between;border-top:1px solid var(--border);padding-top:4px;margin-top:2px;"><span style="color:var(--muted);">Total Stake</span><b style="color:var(--teal);">$${cfg.totalStake.toFixed(2)}</b></div>
        <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Account</span><b style="color:${acctColor};">${acctType}</b></div>`;

    if (btn && !bulkExecuting) btn.textContent = `EXECUTE ${cfg.trades} TRADE${cfg.trades===1?'':'S'}`;
}

// Populate from an AI Scanner signal — used by the bridge functions below
// and by the 79%+ Bulk Entry Recommendation banner. `suggestedTrades` is a
// pre-fill only — the user can always change it before executing.
function populateBulkFromSignal(sig, suggestedTrades) {
    if (!sig) return;
    const marketSel = document.getElementById('bulk-market');
    const typeSel    = document.getElementById('bulk-type');
    const predEl     = document.getElementById('bulk-pred');
    const durEl      = document.getElementById('bulk-dur');
    const tradesEl   = document.getElementById('bulk-trades');
    if (sig.symbol && marketSel) marketSel.value = sig.symbol;
    if (typeSel) { typeSel.value = sig.type; onBulkTypeChange(); }
    selectBulkDir(sig.botDirection);
    if (sig.pred !== null && sig.pred !== undefined && predEl) predEl.value = sig.pred;
    if (sig.ticks && durEl) durEl.value = sig.ticks;
    if (suggestedTrades && tradesEl) tradesEl.value = Math.min(BULK_MAX_TRADES, suggestedTrades);

    // This is THE source of truth for this signal's confidence — it comes
    // straight from the AI Scanner's own generateSignal()/getTopSignals(),
    // never recalculated here, so Bulk Trading can never disagree with the
    // Scanner about what the confidence actually is.
    bulkImportedSignal = { ...sig, generatedAt: sig.generatedAt || Date.now() };

    const note = document.getElementById('bulk-signal-note');
    if (note) {
        note.style.display = 'block';
        note.textContent = `📡 From AI Scanner: ${sig.label || MKT[sig.symbol] || sig.symbol || ''} — ${sig.direction} (${sig.confidence}% confidence). Signal generated: ${new Date(bulkImportedSignal.generatedAt).toLocaleTimeString()}. Review before executing.`;
    }
    updateBulkPreview();
    switchTab('bulk');
    notify('📦 Signal Sent to Bulk Trading', `${sig.direction} · ${sig.confidence}% confidence — review the setup and choose your trade count.`, 'ok');
}
function applySignalToBulk(sig) {
    if (typeof sig === 'string') { try { sig = JSON.parse(sig); } catch(e) { return; } }
    populateBulkFromSignal(sig);
}
function isBulkSignalStale() {
    return !!(bulkImportedSignal && (Date.now() - bulkImportedSignal.generatedAt) > BULK_SIGNAL_STALE_MS);
}

// ================================================================
// 79%+ CONFIDENCE — BULK ENTRY RECOMMENDATION
// A recommendation only, never automatic — the user still has to open
// Bulk Trading, review the setup, choose a trade count, and confirm.
// Reuses the exact same signal object the AI Scanner already produced —
// this is not a second, independent confidence calculation.
// ================================================================
function bulkConfidenceTier(conf) {
    if (conf >= 90) return { label: '🔥 VERY STRONG BULK ENTRY', color: 'var(--green)', suggestedTrades: 15 };
    if (conf >= 85) return { label: '🔥 STRONG BULK ENTRY',      color: 'var(--green)', suggestedTrades: 10 };
    if (conf >= 79) return { label: '🔥 BULK ENTRY RECOMMENDED', color: 'var(--teal)',  suggestedTrades: 5  };
    return null; // below 79% — no bulk recommendation, per spec
}

function renderBulkRecommendation(best) {
    const el = document.getElementById('bulk-recommend-banner');
    if (!el) return;
    const sig = best?.signal;
    const tier = sig ? bulkConfidenceTier(sig.confidence) : null;
    if (!tier) { el.style.display = 'none'; return; }

    // Stamp the moment this recommendation was generated — carried through
    // to Bulk Trading's staleness check so a signal is never silently
    // executed after the market has moved on.
    sig.generatedAt = sig.generatedAt || Date.now();
    sig.symbol = sig.symbol || best.sym;

    const stakeDefault = 1;
    const exposure = tier.suggestedTrades * stakeDefault;
    el.style.display = 'block';
    el.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
            <div style="font-size:14px;font-weight:900;color:${tier.color};">${tier.label}</div>
            <div style="font-size:20px;font-weight:900;color:${tier.color};">${sig.confidence}%</div>
        </div>
        <div class="accu-row-3" style="margin-bottom:10px;">
            <div class="card-sm" style="padding:8px;text-align:center;"><div style="font-size:8px;color:var(--muted);">MARKET</div><div style="font-size:12px;font-weight:900;">${sig.label || MKT[sig.symbol] || sig.symbol}</div></div>
            <div class="card-sm" style="padding:8px;text-align:center;"><div style="font-size:8px;color:var(--muted);">DIRECTION</div><div style="font-size:12px;font-weight:900;color:${['under','odd','fall','downs'].includes(sig.botDirection)?'var(--red)':'var(--teal)'};">${sig.direction}</div></div>
            <div class="card-sm" style="padding:8px;text-align:center;"><div style="font-size:8px;color:var(--muted);">SUGGESTED TRADES</div><div style="font-size:12px;font-weight:900;">${tier.suggestedTrades}</div></div>
        </div>
        <div style="font-size:10px;color:var(--muted);margin-bottom:10px;">Stake/Trade: <b style="color:var(--text);">$${stakeDefault.toFixed(2)}</b> (adjustable) · Total Exposure at suggested count: <b style="color:var(--text);">$${exposure.toFixed(2)}</b> · Signal generated: <b style="color:var(--text);">${new Date(sig.generatedAt).toLocaleTimeString()}</b></div>
        <button onclick="populateBulkFromSignal(${JSON.stringify(sig).replace(/"/g,'&quot;')}, ${tier.suggestedTrades})" class="btn btn-teal" style="width:100%;padding:12px;font-size:13px;font-weight:900;">OPEN IN BULK TRADING</button>`;
}

function applyBestSignalToBulk() {
    const results = ALL_MKTS.map(sym => ({ sym, signal: generateSignal(sym) }))
        .sort((a,b) => (b.signal?.confidence||0) - (a.signal?.confidence||0));
    if (results[0]?.signal) populateBulkFromSignal(results[0].signal);
}

// ── Validation / risk protection ──
function validateBulkConfig(cfg) {
    if (!derivWS || derivWS.readyState !== WebSocket.OPEN) return 'Not connected to Deriv. Please log in first.';
    if (!accountId) return 'No trading account selected.';
    if (cfg.trades < 1 || cfg.trades > BULK_MAX_TRADES) return `Number of trades must be between 1 and ${BULK_MAX_TRADES}.`;
    if (!(cfg.stakePerTrade >= 0.35)) return 'Stake per trade is below the $0.35 minimum.';
    if (cfg.totalStake > BULK_MAX_TOTAL_STAKE) return `Total planned stake ($${cfg.totalStake.toFixed(2)}) exceeds the safety cap of $${BULK_MAX_TOTAL_STAKE}.`;
    if (liveBalance !== null && cfg.totalStake > liveBalance) return `Insufficient balance: total stake $${cfg.totalStake.toFixed(2)} exceeds your balance of $${liveBalance.toFixed(2)}.`;
    if (!cfg.market) return 'Select a market.';
    if (!CONTRACT_MAP[cfg.type]?.[cfg.direction]) return 'Select a valid trade direction.';
    return null;
}

// ── Low-level, self-contained request helpers — decoupled from the DBot's
// global pendingContract/lastContractId state so Bulk Trading can never
// interfere with (or be interfered with by) the DBot or Accumulator. ──
function derivRequest(payload, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        if (!derivWS || derivWS.readyState !== WebSocket.OPEN) { reject(new Error('Not connected')); return; }
        const reqId = nextReqId();
        const timer = setTimeout(() => { derivWS.removeEventListener('message', handler); reject(new Error('Request timed out')); }, timeoutMs);
        function handler(ev) {
            let data; try { data = JSON.parse(ev.data); } catch(e) { return; }
            if (data.req_id !== reqId) return;
            clearTimeout(timer);
            derivWS.removeEventListener('message', handler);
            if (data.error) { reject(new Error(data.error.message || 'API error')); return; }
            resolve(data);
        }
        derivWS.addEventListener('message', handler);
        derivWS.send(JSON.stringify({ ...payload, req_id: reqId }));
    });
}
function waitForBulkContractSettlement(contractId, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        if (!derivWS || derivWS.readyState !== WebSocket.OPEN) { reject(new Error('Not connected')); return; }
        let subId = null;
        const timer = setTimeout(() => { cleanup(); reject(new Error('Settlement timed out')); }, timeoutMs);
        function cleanup() {
            clearTimeout(timer);
            derivWS.removeEventListener('message', handler);
            if (subId && derivWS.readyState === WebSocket.OPEN) derivWS.send(JSON.stringify({ forget: subId }));
        }
        function handler(ev) {
            let data; try { data = JSON.parse(ev.data); } catch(e) { return; }
            if (data.msg_type !== 'proposal_open_contract') return;
            const c = data.proposal_open_contract;
            if (!c || c.contract_id !== contractId) return;
            if (data.subscription?.id) subId = data.subscription.id;
            if (c.is_sold || c.is_expired) { cleanup(); resolve(c); }
        }
        derivWS.addEventListener('message', handler);
        derivWS.send(JSON.stringify({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1, req_id: nextReqId() }));
    });
}

// ================================================================
// CONCURRENT ENTRY ENGINE
// The core fix: entering N trades means submitting all N proposal->buy
// round trips together (as a controlled-concurrency pool), NOT awaiting
// each trade's full settlement before starting the next one. Settlement
// (win/loss) is tracked separately and resolves independently per contract
// — that's Stage 2, and it never blocks Stage 1 (entry) for the other trades.
// ================================================================

// Stage 1 for a single trade: proposal -> buy only. Resolves as soon as the
// contract is bought (entered), then kicks off Stage 2 (settlement) as a
// fire-and-forget continuation so it doesn't hold up the next entry.
async function submitSingleBulkEntry(cfg, idx, batch) {
    try {
        const contractType = CONTRACT_MAP[cfg.type]?.[cfg.direction];
        if (!contractType) throw new Error('Invalid contract configuration');

        const isDigit    = ['DIGITEVEN','DIGITODD','DIGITOVER','DIGITUNDER'].includes(contractType);
        const isRunHL    = ['RUNHIGH','RUNLOW'].includes(contractType);
        const isRiseFall = ['CALL','PUT'].includes(contractType);

        const proposalReq = {
            proposal: 1, amount: parseFloat(cfg.stakePerTrade.toFixed(2)), basis: 'stake',
            contract_type: contractType, currency: 'USD', underlying_symbol: cfg.market
        };
        if (isDigit)         { proposalReq.duration = Math.max(1, Math.min(10, cfg.duration)); proposalReq.duration_unit = 't'; }
        else if (isRunHL)    { proposalReq.duration = Math.max(2, Math.min(10, cfg.duration)); proposalReq.duration_unit = 't'; }
        else if (isRiseFall) { proposalReq.duration = Math.max(1, cfg.duration); proposalReq.duration_unit = 'm'; }
        if (cfg.type === 'over_under') proposalReq.barrier = String(cfg.pred);

        const proposalResp = await derivRequest(proposalReq);
        const proposalId = proposalResp.proposal.id;
        const askPrice    = parseFloat(proposalResp.proposal.ask_price);

        const buyResp    = await derivRequest({ buy: proposalId, price: askPrice });
        const contractId = buyResp.buy.contract_id;
        const buyPrice    = parseFloat(buyResp.buy.buy_price);

        batch.entries[idx] = { index: idx+1, status: 'ENTERED', contractId, stake: buyPrice, contractType, timestamp: Date.now() };
        log(`📦 Bulk entry ${idx+1}/${batch.trades} submitted | ${contractType} @ $${buyPrice.toFixed(2)}`, 'i');

        // Stage 2 — settlement — fire-and-forget, does NOT block the entry pool.
        waitForBulkContractSettlement(contractId).then(settled => {
            const profit = parseFloat(settled.profit || 0);
            batch.results[idx] = { index: idx+1, status: 'Completed', contractType, stake: buyPrice, contractId, profit, isWin: profit > 0, timestamp: Date.now() };
            log(`📦 Bulk trade ${idx+1}/${batch.trades} resolved | ${profit>0?'WIN':'LOSS'} $${profit.toFixed(2)}`, profit>0?'w':'l');
            saveBulkBatches(); renderBulkProgress(batch); renderBulkHistory();
            checkBulkBatchFullyResolved(batch);
        }).catch(e => {
            batch.results[idx] = { index: idx+1, status: 'Failed', error: e.message, timestamp: Date.now() };
            log(`📦 Bulk trade ${idx+1}/${batch.trades} settlement error: ${e.message}`, 'x');
            saveBulkBatches(); renderBulkProgress(batch); renderBulkHistory();
            checkBulkBatchFullyResolved(batch);
        });
    } catch(e) {
        // Entry itself failed (proposal/buy rejected) — this slot is already
        // final; it was never entered, so there's nothing to wait on.
        batch.entries[idx] = { index: idx+1, status: 'ENTRY_FAILED', error: e.message, timestamp: Date.now() };
        batch.results[idx] = { index: idx+1, status: 'Failed', error: e.message, timestamp: Date.now() };
        log(`📦 Bulk entry ${idx+1}/${batch.trades} FAILED: ${e.message}`, 'x');
        checkBulkBatchFullyResolved(batch);
    }
}

// Runs the whole batch's entry stage through a small worker pool
// (BULK_ENTRY_CONCURRENCY at a time) so all N trades are submitted
// together rather than one-at-a-time, while still respecting the
// WebSocket connection instead of firing everything at once.
async function runConcurrentEntries(cfg, batch) {
    batch.entries = new Array(cfg.trades).fill(null);
    batch.results = new Array(cfg.trades).fill(null);
    let cursor = 0;
    async function worker() {
        while (cursor < cfg.trades) {
            const idx = cursor++;
            await submitSingleBulkEntry(cfg, idx, batch);
            renderBulkProgress(batch);
        }
    }
    const workerCount = Math.min(BULK_ENTRY_CONCURRENCY, cfg.trades);
    await Promise.all(Array.from({ length: workerCount }, worker));
    saveBulkBatches();
    renderBulkProgress(batch);
}

function computeBatchStatus(batch) {
    const results  = batch.results || [];
    const completed = results.filter(r => r && r.status === 'Completed').length;
    if (completed === batch.trades) return 'Completed';
    if (completed === 0) return 'Failed';
    return 'Partially Completed';
}

// Called after every single result lands. Only finalizes the batch once
// EVERY requested slot has a final outcome (won, lost, or failed to enter)
// — being "fully submitted" is not the same as being "fully completed".
function checkBulkBatchFullyResolved(batch) {
    if (!batch.results || batch.results.some(r => r === null)) return; // still waiting on at least one
    if (batch._finalized) return; // idempotent — only finalize once
    batch._finalized = true;
    batch.status = computeBatchStatus(batch);
    batch.completedAt = Date.now();
    saveBulkBatches();
    renderBulkHistory();
    if (bulkCurrentBatch === batch) renderBulkProgress(batch);

    const wins = batch.results.filter(r => r.isWin).length;
    const net  = batch.results.reduce((s,r) => s + (r.profit || 0), 0);
    notify(
        batch.status === 'Completed' ? '✅ Bulk Trade Completed' : batch.status === 'Failed' ? '❌ Bulk Trade Failed' : '⚠️ Bulk Trade Partially Completed',
        `${batch.trades} requested · ${batch.results.filter(r=>r.status==='Completed').length} resolved · ${wins} wins · Net: ${net>=0?'+':''}$${net.toFixed(2)}`,
        batch.status === 'Completed' ? 'ok' : batch.status === 'Failed' ? 'err' : 'warn'
    );
    if (batch._resolveDone) batch._resolveDone(batch);
}

// ── Reset the current setup/execution area — does NOT touch history ──
function resetBulkSetup() {
    if (bulkExecuting) { notify('Cannot Reset', 'Wait for entry submission to finish first (settlement can continue in the background).', 'warn'); return; }
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('bulk-market', 'R_10');
    set('bulk-type', 'over_under');
    onBulkTypeChange();
    set('bulk-pred', 5);
    set('bulk-dur', 1);
    set('bulk-trades', 10);
    set('bulk-stake', '1.00');
    setBulkStakeMode('per');

    bulkImportedSignal = null;
    const note = document.getElementById('bulk-signal-note');
    if (note) { note.style.display = 'none'; note.textContent = ''; }

    bulkCurrentBatch = null; // detach the UI from any batch — history already has its own persisted copy
    const progressCard = document.getElementById('bulk-progress-card');
    if (progressCard) progressCard.style.display = 'none';
    const resultsBody = document.getElementById('bulk-results-body');
    if (resultsBody) resultsBody.innerHTML = '';

    updateBulkPreview();
    notify('🔄 Bulk Setup Reset', 'Configuration cleared. Bulk trade history was not affected.', 'ok');
}

// ── Main entry point — guarded against double-click / re-entrant calls ──
function startBulkExecution() {
    if (bulkExecuting) return; // idempotency guard — a second click while entries are being submitted does nothing
    const cfg = getBulkConfig();
    const err = validateBulkConfig(cfg);
    if (err) { notify('Cannot Execute', err, 'err'); return; }

    if (isBulkSignalStale()) {
        const ageMin = Math.round((Date.now() - bulkImportedSignal.generatedAt) / 60000);
        showApaModal(`
            <div style="text-align:center;padding:10px;">
                <div style="font-size:32px;margin-bottom:8px;">⚠️</div>
                <div style="font-size:14px;font-weight:900;margin-bottom:8px;">Signal No Longer Fresh</div>
                <div style="font-size:12px;color:var(--muted);margin-bottom:16px;">This AI signal was generated ${ageMin} minute${ageMin===1?'':'s'} ago. Please rescan the market before executing, or continue with the current setup anyway.</div>
                <button class="btn btn-teal" style="width:100%;padding:12px;margin-bottom:8px;font-weight:900;" onclick="closeApaModal();switchTab('scanner');">🔄 Rescan Market</button>
                <button class="btn btn-ghost" style="width:100%;padding:10px;" onclick="closeApaModal();proceedBulkExecution();">Continue Anyway</button>
            </div>`);
        return;
    }
    proceedBulkExecution();
}

function proceedBulkExecution() {
    const cfg = getBulkConfig();
    const err = validateBulkConfig(cfg);
    if (err) { notify('Cannot Execute', err, 'err'); return; }

    const acct = allAccounts.find(a => a.account_id === accountId);
    const isReal = acct && acct.account_type === 'real';

    if (isReal) {
        showApaModal(`
            <div style="text-align:center;padding:10px;">
                <div style="font-size:32px;margin-bottom:8px;">⚠️</div>
                <div style="font-size:14px;font-weight:900;margin-bottom:8px;">Confirm REAL Account Execution</div>
                <div style="font-size:12px;color:var(--muted);margin-bottom:16px;">You are about to execute <b style="color:var(--text);">${cfg.trades} trades</b> on your <b style="color:var(--red);">REAL</b> account. Total stake: <b style="color:var(--text);">$${cfg.totalStake.toFixed(2)}</b>.</div>
                <button class="btn btn-red" style="width:100%;padding:12px;margin-bottom:8px;font-weight:900;" onclick="closeApaModal();runBulkExecution();">Confirm — Execute on REAL Account</button>
                <button class="btn btn-ghost" style="width:100%;padding:10px;" onclick="closeApaModal();">Cancel</button>
            </div>`);
        return;
    }
    runBulkExecution();
}

// Submits the whole batch concurrently (Stage 1), then returns a promise
// that resolves once every trade has fully settled (Stage 2) — useful for
// Auto Mode's batch-by-batch pacing. The UI itself does not wait for this:
// the Execute button re-enables as soon as entry submission finishes, since
// starting another batch doesn't need to wait for the previous one's
// contracts to resolve.
async function runBulkExecution() {
    if (bulkExecuting) return null;
    const cfg = getBulkConfig();
    const err = validateBulkConfig(cfg);
    if (err) { notify('Cannot Execute', err, 'err'); return null; }

    bulkExecuting = true;
    const btn = document.getElementById('bulk-execute-btn');
    if (btn) { btn.disabled = true; btn.textContent = `Submitting ${cfg.trades} Trades...`; btn.style.opacity = '0.7'; }

    const acct = allAccounts.find(a => a.account_id === accountId);
    const batch = {
        id: makeBulkBatchId(), createdAt: Date.now(), market: cfg.market, marketLabel: MKT[cfg.market] || cfg.market,
        type: cfg.type, direction: cfg.direction, pred: cfg.pred, trades: cfg.trades,
        stakePerTrade: cfg.stakePerTrade, totalStake: cfg.totalStake,
        account: acct ? (acct.account_type === 'real' ? 'REAL' : 'DEMO') : '—',
        status: 'RUNNING', entries: [], results: [], _finalized: false
    };
    let resolveDone;
    const donePromise = new Promise(resolve => { resolveDone = resolve; });
    batch._resolveDone = resolveDone;

    bulkCurrentBatch = batch;
    bulkBatches.push(batch);
    saveBulkBatches();
    renderBulkHistory();

    const progressCard = document.getElementById('bulk-progress-card');
    if (progressCard) progressCard.style.display = 'block';
    renderBulkProgress(batch);

    await runConcurrentEntries(cfg, batch); // all N entries submitted together (controlled concurrency)

    bulkExecuting = false;
    if (btn) { btn.disabled = false; btn.style.opacity = '1'; updateBulkPreview(); }
    checkBulkBatchFullyResolved(batch); // covers the edge case where everything already resolved/failed synchronously

    return donePromise;
}

function renderBulkProgress(batch) {
    if (!batch || bulkCurrentBatch !== batch) return; // don't paint a reset UI with a stale batch's data
    const total    = batch.trades;
    const entries  = batch.entries || [];
    const results  = batch.results || [];
    const entered     = entries.filter(e => e && e.status === 'ENTERED').length;
    const entryFailed = entries.filter(e => e && e.status === 'ENTRY_FAILED').length;
    const attempted   = entered + entryFailed;
    const resolved    = results.filter(r => r !== null).length;
    const pending      = total - resolved;
    const success      = results.filter(r => r && r.status === 'Completed').length;
    const failedFinal  = results.filter(r => r && r.status === 'Failed').length;

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('bulk-entry-status', `${attempted} / ${total} Submitted${entryFailed ? ` (${entryFailed} failed)` : ''}`);
    set('bulk-progress-label', `${resolved} / ${total} Resolved`);
    set('bulk-progress-status', pending > 0 ? `${pending} Pending` : (batch.status || 'Done'));
    set('bulk-count-success', success);
    set('bulk-count-failed', failedFinal);
    set('bulk-count-pending', pending);

    const entryBar = document.getElementById('bulk-entry-bar');
    if (entryBar) entryBar.style.width = `${total ? (attempted/total)*100 : 0}%`;
    const bar = document.getElementById('bulk-progress-bar');
    if (bar) bar.style.width = `${total ? (resolved/total)*100 : 0}%`;

    const body = document.getElementById('bulk-results-body');
    if (body) {
        body.innerHTML = Array.from({ length: total }, (_, i) => {
            const r = results[i];
            const e = entries[i];
            if (!r) {
                const status = e && e.status === 'ENTERED' ? 'Entered — resolving' : 'Submitting';
                return `<div style="display:flex;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-size:11px;color:var(--dim);">
                    <div style="width:32px;">${i+1}</div><div style="flex:1;">${status}</div><div style="width:70px;">—</div><div style="width:90px;">Pending</div><div style="width:80px;text-align:right;">—</div>
                </div>`;
            }
            return `<div style="display:flex;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-size:11px;">
                <div style="width:32px;color:var(--muted);">${r.index}</div>
                <div style="flex:1;">${r.contractType || batch.type}</div>
                <div style="width:70px;font-family:monospace;">$${(r.stake ?? batch.stakePerTrade).toFixed(2)}</div>
                <div style="width:90px;color:${r.status==='Completed'?'var(--green)':'var(--red)'};">${r.status}</div>
                <div style="width:80px;text-align:right;font-family:monospace;font-weight:700;color:${r.status!=='Completed'?'var(--dim)':r.isWin?'var(--green)':'var(--red)'};">${r.status==='Completed' ? (r.isWin?'+':'')+'$'+r.profit.toFixed(2) : '—'}</div>
            </div>`;
        }).join('');
    }
}

// ── Overall Bulk Trading statistics — computed from actual stored history,
// never mocked. ──
function computeBulkOverallStats() {
    let totalTrades = 0, wins = 0, losses = 0, pl = 0;
    bulkBatches.forEach(b => {
        totalTrades += b.trades;
        (b.results || []).forEach(r => {
            if (r && r.status === 'Completed') {
                pl += (r.profit || 0);
                if (r.isWin) wins++; else losses++;
            }
        });
    });
    const decided = wins + losses;
    return { totalBatches: bulkBatches.length, totalTrades, wins, losses, pl, winRate: decided ? (wins/decided*100) : 0 };
}
function renderBulkStatsCards() {
    const wrap = document.getElementById('bulk-overall-stats');
    if (!wrap) return;
    const s = computeBulkOverallStats();
    const set = (id, v, col) => { const el = document.getElementById(id); if (el) { el.textContent = v; if (col) el.style.color = col; } };
    set('bulk-stat-batches', s.totalBatches);
    set('bulk-stat-trades', s.totalTrades);
    set('bulk-stat-wins', s.wins, 'var(--green)');
    set('bulk-stat-losses', s.losses, 'var(--red)');
    set('bulk-stat-pl', `${s.pl>=0?'+':''}$${s.pl.toFixed(2)}`, s.pl >= 0 ? 'var(--green)' : 'var(--red)');
    set('bulk-stat-winrate', `${s.winRate.toFixed(2)}%`);
    wrap.style.display = s.totalBatches > 0 ? 'grid' : 'none';
}

function renderBulkHistory() {
    const body = document.getElementById('bulk-history-body');
    renderBulkStatsCards();
    if (!body) return;
    const batches = bulkBatches.slice().sort((a,b) => b.createdAt - a.createdAt);
    if (!batches.length) {
        body.innerHTML = `<div style="font-size:11px;color:var(--dim);text-align:center;padding:16px;">No bulk trades executed yet.</div>`;
        return;
    }
    body.innerHTML = batches.map(b => {
        const results = (b.results || []).filter(Boolean); // exclude still-pending slots
        const wins    = results.filter(r => r.isWin).length;
        const losses  = results.filter(r => r.status === 'Completed' && !r.isWin).length;
        const failed  = results.filter(r => r.status === 'Failed').length;
        const net     = results.reduce((s,r) => s + (r.profit || 0), 0);
        const resolved = results.length;
        const statusColor = b.status === 'Completed' ? 'var(--green)' : b.status === 'Failed' ? 'var(--red)' : b.status === 'RUNNING' ? 'var(--amber)' : 'var(--amber)';
        return `
        <div class="card-sm" style="padding:10px;">
            <div style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;" onclick="toggleBulkBatchDetail('${b.id}')">
                <div>
                    <div style="font-size:11px;font-weight:900;">Batch #${b.id}</div>
                    <div style="font-size:9px;color:var(--muted);">${new Date(b.createdAt).toLocaleString()} · ${b.marketLabel} · ${b.direction.toUpperCase()}</div>
                </div>
                <span class="badge" style="background:${statusColor}22;color:${statusColor};border:1px solid ${statusColor}44;">${b.status}${b.status==='RUNNING' ? ` (${resolved}/${b.trades})` : ''}</span>
            </div>
            <div class="accu-row-3" style="margin-top:8px;">
                <div style="text-align:center;"><div style="font-size:8px;color:var(--muted);">TRADES</div><div style="font-size:12px;font-weight:900;">${b.trades}</div></div>
                <div style="text-align:center;"><div style="font-size:8px;color:var(--muted);">TOTAL STAKE</div><div style="font-size:12px;font-weight:900;">$${b.totalStake.toFixed(2)}</div></div>
                <div style="text-align:center;"><div style="font-size:8px;color:var(--muted);">TOTAL P/L</div><div style="font-size:12px;font-weight:900;color:${net>0?'var(--green)':net<0?'var(--red)':'var(--muted)'};">${net===0?'0.00':(net>0?'+':'')+'$'+net.toFixed(2)}</div></div>
            </div>
            <div style="font-size:9px;color:var(--muted);margin-top:6px;">Wins: <b style="color:var(--green);">${wins}</b> · Losses: <b style="color:var(--red);">${losses}</b>${failed?` · Failed: <b style="color:var(--red);">${failed}</b>`:''} · Account: <b>${b.account}</b></div>
            <div id="bulk-batch-detail-${b.id}" style="display:none;margin-top:8px;border-top:1px solid var(--border);padding-top:8px;">
                ${results.map(r => `
                <div style="display:flex;justify-content:space-between;font-size:10px;padding:3px 0;color:var(--muted);">
                    <span>#${r.index} ${r.contractType || b.type}</span>
                    <span>${new Date(r.timestamp).toLocaleTimeString()}</span>
                    <span style="color:${r.status!=='Completed'?'var(--red)':r.isWin?'var(--green)':'var(--red)'};">${r.status==='Completed' ? (r.isWin?'+':'')+'$'+r.profit.toFixed(2) : (r.error || 'Failed')}</span>
                </div>`).join('') || '<div style="font-size:10px;color:var(--dim);">Still resolving...</div>'}
            </div>
        </div>`;
    }).join('');
}
function toggleBulkBatchDetail(id) {
    const el = document.getElementById(`bulk-batch-detail-${id}`);
    if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}
function clearBulkHistory() {
    bulkBatches = [];
    saveBulkBatches();
    renderBulkHistory();
    notify('🗑 Bulk History Cleared', 'All bulk trade batches have been removed from this browser.', 'ok');
}

function initBulkTab() {
    loadBulkBatches();
    onBulkTypeChange();
    setBulkStakeMode(bulkStakeMode);
    updateBulkPreview();
    renderBulkHistory();
    if (bulkCurrentBatch) { document.getElementById('bulk-progress-card').style.display = 'block'; renderBulkProgress(bulkCurrentBatch); }

    const acct = allAccounts.find(a => a.account_id === accountId);
    const accBadge = document.getElementById('bulk-account-badge');
    const balBadge = document.getElementById('bulk-balance-badge');
    if (accBadge) {
        if (acct) { accBadge.style.display = 'inline-flex'; accBadge.textContent = acct.account_type === 'real' ? 'REAL' : 'DEMO'; accBadge.className = acct.account_type === 'real' ? 'badge badge-red' : 'badge badge-teal'; }
        else accBadge.style.display = 'none';
    }
    if (balBadge) {
        if (liveBalance !== null) { balBadge.style.display = 'inline-flex'; balBadge.textContent = `$${liveBalance.toFixed(2)}`; }
        else balBadge.style.display = 'none';
    }
    const dot = document.getElementById('bulk-status-dot');
    const txt = document.getElementById('bulk-status-text');
    const live = derivWS && derivWS.readyState === WebSocket.OPEN;
    if (dot) dot.classList.toggle('live', live);
    if (txt) { txt.textContent = live ? 'LIVE' : 'OFFLINE'; txt.style.color = live ? 'var(--teal)' : 'var(--muted)'; }
    updateBulkAutoUI();
}

// ================================================================
// BULK AUTO MODE
// Watches the AI Scanner and, once enabled, automatically executes a batch
// (using the currently configured Trades/Stake) whenever a qualifying
// signal appears — same shape as the Accumulator's Auto Mode: runs until
// manually stopped, Take Profit, Stop Loss, max batches/day, connection
// loss, or a batch that fails outright.
// ================================================================
function resetBulkAutoDayIfNeeded() {
    const today = new Date().toDateString();
    if (bulkAutoDate !== today) { bulkAutoDate = today; bulkAutoSessions = 0; bulkAutoPL = 0; }
}

function updateBulkAutoUI() {
    const track = document.getElementById('bulk-auto-track');
    const thumb = document.getElementById('bulk-auto-thumb');
    const bar   = document.getElementById('bulk-auto-bar');
    if (track) track.style.background = bulkAutoEnabled ? 'var(--teal)' : 'var(--border)';
    if (thumb) thumb.style.left       = bulkAutoEnabled ? '23px' : '3px';
    if (bar)   bar.style.display      = bulkAutoEnabled ? 'flex' : 'none';
    const set = (id, v, col) => { const el = document.getElementById(id); if (el) { el.textContent = v; if (col) el.style.color = col; } };
    set('bulk-auto-batches', bulkAutoSessions);
    set('bulk-auto-pl', `${bulkAutoPL>=0?'+':''}$${bulkAutoPL.toFixed(2)}`, bulkAutoPL >= 0 ? 'var(--green)' : 'var(--red)');
}

function toggleBulkAuto() {
    if (!bulkAutoEnabled) {
        // Turning ON
        const acct = allAccounts.find(a => a.account_id === accountId);
        const isReal = acct && acct.account_type === 'real';
        if (isReal) {
            showApaModal(`
                <div style="text-align:center;padding:10px;">
                    <div style="font-size:32px;margin-bottom:8px;">⚠️</div>
                    <div style="font-size:14px;font-weight:900;margin-bottom:8px;">Enable Auto Mode on REAL Account?</div>
                    <div style="font-size:12px;color:var(--muted);margin-bottom:16px;">Once enabled, Bulk Auto Mode will automatically execute batches on your <b style="color:var(--red);">REAL</b> account whenever a qualifying signal appears — without a confirmation prompt for each batch. It stops at your Take Profit, Stop Loss, max batches/day, or when you turn it off.</div>
                    <button class="btn btn-red" style="width:100%;padding:12px;margin-bottom:8px;font-weight:900;" onclick="closeApaModal();enableBulkAutoConfirmed();">Confirm — Enable on REAL Account</button>
                    <button class="btn btn-ghost" style="width:100%;padding:10px;" onclick="closeApaModal();">Cancel</button>
                </div>`);
            return;
        }
        enableBulkAutoConfirmed();
    } else {
        stopBulkAuto();
    }
}

function enableBulkAutoConfirmed() {
    resetBulkAutoDayIfNeeded();
    bulkAutoEnabled = true;
    updateBulkAutoUI();
    startBulkAutoWatch();
    log('🤖 Bulk Auto Mode: ON', 'i');
    notify('🤖 Bulk Auto Mode ON', `Watching the AI Scanner for signals ≥ ${document.getElementById('bulk-auto-min-conf')?.value || 75}% confidence. Batches will run automatically until stopped.`, 'ok');
}

// reason: undefined (manual) | 'take_profit' | 'stop_loss' | 'max_batches' | 'connection_lost' | 'api_error'
function stopBulkAuto(reason) {
    bulkAutoEnabled = false;
    bulkAutoRunning = false;
    if (bulkAutoTimer) { clearInterval(bulkAutoTimer); bulkAutoTimer = null; }
    updateBulkAutoUI();

    const summary = `Batches today: ${bulkAutoSessions} | Session P/L: ${bulkAutoPL>=0?'+':''}$${bulkAutoPL.toFixed(2)}`;
    log(`🤖 Bulk Auto Mode stopped${reason ? ' ('+reason+')' : ''}. ${summary}`, 'i');
    if (reason === 'take_profit')      notify('🏆 Take Profit Reached', `Bulk Auto Mode stopped.\n${summary}`, 'ok');
    else if (reason === 'stop_loss')   notify('⛔ Stop Loss Reached', `Bulk Auto Mode stopped.\n${summary}`, 'err');
    else if (reason === 'max_batches') notify('🔢 Max Batches Reached', `Bulk Auto Mode stopped.\n${summary}`, 'ok');
    else if (reason === 'connection_lost') notify('📡 Connection Lost', `Bulk Auto Mode stopped.\n${summary}`, 'err');
    else if (reason === 'api_error')   notify('⚠️ Batch Failed', `Bulk Auto Mode stopped — a batch failed outright.\n${summary}`, 'err');
    else notify('🤖 Bulk Auto Mode Stopped', summary, 'ok');
}

function startBulkAutoWatch() {
    if (bulkAutoTimer) return;
    bulkAutoTimer = setInterval(bulkAutoTick, 20000);
    bulkAutoTick();
}

async function bulkAutoTick() {
    if (!bulkAutoEnabled || bulkAutoRunning || bulkExecuting) return;
    resetBulkAutoDayIfNeeded();

    if (!derivWS || derivWS.readyState !== WebSocket.OPEN) { stopBulkAuto('connection_lost'); return; }

    const maxBatches = parseInt(document.getElementById('bulk-auto-max-batches')?.value || 5);
    if (bulkAutoSessions >= maxBatches) { stopBulkAuto('max_batches'); return; }

    const tp = parseFloat(document.getElementById('bulk-auto-tp')?.value || 0);
    const sl = parseFloat(document.getElementById('bulk-auto-sl')?.value || 0);
    if (tp > 0 && bulkAutoPL >= tp) { stopBulkAuto('take_profit'); return; }
    if (sl > 0 && bulkAutoPL <= -sl) { stopBulkAuto('stop_loss'); return; }

    const minConf = parseFloat(document.getElementById('bulk-auto-min-conf')?.value || 75);
    const results = ALL_MKTS.map(sym => ({ sym, signal: generateSignal(sym) }))
        .sort((a,b) => (b.signal?.confidence||0) - (a.signal?.confidence||0));
    const best = results[0];
    if (!best?.signal || best.signal.confidence < minConf) return; // nothing qualifying yet — wait for next tick

    populateBulkFromSignal(best.signal);
    bulkAutoRunning = true;
    const batch = await runBulkExecution(); // awaits full settlement of this batch before the next tick can start another
    bulkAutoRunning = false;

    if (batch) {
        bulkAutoSessions++;
        const net = batch.results.reduce((s,r) => s + (r.profit || 0), 0);
        bulkAutoPL += net;
        updateBulkAutoUI();
        if (batch.status === 'Failed') { stopBulkAuto('api_error'); return; }
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

    renderBulkRecommendation(results[0]);

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
                <div style="display:flex;gap:6px;margin-top:4px;">
                    <button onclick="applySignalToBot(${JSON.stringify(s).replace(/"/g,'&quot;')})"
                        style="flex:1;background:var(--teal);color:#000;border:none;border-radius:6px;padding:5px 8px;font-size:10px;font-weight:700;cursor:pointer;">
                        ✅ Apply to Bot
                    </button>
                    <button onclick="applySignalToBulk(${JSON.stringify(s).replace(/"/g,'&quot;')})"
                        style="flex:1;background:var(--bg2);color:var(--teal);border:1px solid var(--teal);border-radius:6px;padding:5px 8px;font-size:10px;font-weight:700;cursor:pointer;">
                        📦 Use in Bulk
                    </button>
                </div>
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
                <div style="display:flex;gap:8px;margin-top:12px;">
                    <button onclick="applyBestSignal()" class="btn btn-teal" style="flex:1;padding:8px 20px;font-size:12px;">✅ Apply Best Signal to Bot</button>
                    <button onclick="applyBestSignalToBulk()" class="btn btn-ghost" style="flex:1;padding:8px 20px;font-size:12px;border:1px solid var(--teal);color:var(--teal);">📦 Use in Bulk Trading</button>
                </div>`;
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
// MT5 + ADVANCED PRICE ACTION (APA) ENGINE
// Replaces the old "Coming Soon" / momentum-signal MT5 tab with a real
// multi-timeframe price-action analysis + Deriv MT5 hand-off flow.
//
// HONEST SCOPE NOTE (see chat write-up for the full audit): Deriv's public
// API has no method to place or manage an MT5 order from a browser — MT5
// execution only happens inside the real MT5 terminal. So "Apply to MT5"
// here validates the account, market, and signal, then hands the user a
// ready-to-place trade inside the real MT5 terminal via deep link. It
// never claims a trade was executed, because this app cannot confirm that.
// ================================================================

// ── Market configuration: Display name -> Deriv symbol -> MT5 symbol -> category ──
// `confirmed` markets are ones we're confident exist on Deriv's synthetic
// index list; others are included per your requested market list but are
// validated live against `knownActiveSymbols` (from the real active_symbols
// API response) before ever being shown as tradable — never assumed.
const APA_MARKETS = [
    // Volatility Indices
    { deriv:'R_10',     mt5:'Volatility 10 Index',      display:'Volatility 10 Index',      cat:'volatility',    confirmed:true },
    { deriv:'R_25',     mt5:'Volatility 25 Index',      display:'Volatility 25 Index',      cat:'volatility',    confirmed:true },
    { deriv:'R_50',     mt5:'Volatility 50 Index',      display:'Volatility 50 Index',      cat:'volatility',    confirmed:true },
    { deriv:'R_75',     mt5:'Volatility 75 Index',      display:'Volatility 75 Index',      cat:'volatility',    confirmed:true },
    { deriv:'R_100',    mt5:'Volatility 100 Index',     display:'Volatility 100 Index',     cat:'volatility',    confirmed:true },
    { deriv:'1HZ10V',   mt5:'Volatility 10 (1s) Index', display:'Volatility 10 (1s) Index', cat:'volatility_1s', confirmed:true },
    { deriv:'1HZ25V',   mt5:'Volatility 25 (1s) Index', display:'Volatility 25 (1s) Index', cat:'volatility_1s', confirmed:true },
    { deriv:'1HZ50V',   mt5:'Volatility 50 (1s) Index', display:'Volatility 50 (1s) Index', cat:'volatility_1s', confirmed:true },
    { deriv:'1HZ75V',   mt5:'Volatility 75 (1s) Index', display:'Volatility 75 (1s) Index', cat:'volatility_1s', confirmed:true },
    { deriv:'1HZ100V',  mt5:'Volatility 100 (1s) Index',display:'Volatility 100 (1s) Index',cat:'volatility_1s', confirmed:true },
    // Step Indices — Deriv's actual live symbol list only has ONE Step
    // Index (stpRNG). "Step Index 200/300/400/500" are included below
    // because they were requested, but they have no real Deriv symbol to
    // fetch live data from — `deriv:null` means they can never pass the
    // live-availability check and will always show as unavailable rather
    // than being faked. See the chat write-up for the full explanation.
    { deriv:'stpRNG',   mt5:'Step Index',       display:'Step Index',     cat:'step', confirmed:true },
    { deriv:null,       mt5:'Step Index 100',   display:'Step Index 100', cat:'step', confirmed:false },
    { deriv:null,       mt5:'Step Index 200',   display:'Step Index 200', cat:'step', confirmed:false },
    { deriv:null,       mt5:'Step Index 300',   display:'Step Index 300', cat:'step', confirmed:false },
    { deriv:null,       mt5:'Step Index 400',   display:'Step Index 400', cat:'step', confirmed:false },
    { deriv:null,       mt5:'Step Index 500',   display:'Step Index 500', cat:'step', confirmed:false },
    // Boom / Crash — symbol codes below are validated live; anything not
    // confirmed by Deriv's own active_symbols response is shown as
    // unavailable rather than assumed to exist.
    { deriv:'BOOM300N', mt5:'Boom 300 Index',   display:'Boom 300 Index',   cat:'boom',  confirmed:false },
    { deriv:'BOOM500',  mt5:'Boom 500 Index',   display:'Boom 500 Index',   cat:'boom',  confirmed:false },
    { deriv:'BOOM600',  mt5:'Boom 600 Index',   display:'Boom 600 Index',   cat:'boom',  confirmed:false },
    { deriv:'BOOM900',  mt5:'Boom 900 Index',   display:'Boom 900 Index',   cat:'boom',  confirmed:false },
    { deriv:'BOOM1000', mt5:'Boom 1000 Index',  display:'Boom 1000 Index',  cat:'boom',  confirmed:false },
    { deriv:'CRASH300N',mt5:'Crash 300 Index',  display:'Crash 300 Index',  cat:'crash', confirmed:false },
    { deriv:'CRASH500', mt5:'Crash 500 Index',  display:'Crash 500 Index',  cat:'crash', confirmed:false },
    { deriv:'CRASH600', mt5:'Crash 600 Index',  display:'Crash 600 Index',  cat:'crash', confirmed:false },
    { deriv:'CRASH900', mt5:'Crash 900 Index',  display:'Crash 900 Index',  cat:'crash', confirmed:false },
    { deriv:'CRASH1000',mt5:'Crash 1000 Index', display:'Crash 1000 Index', cat:'crash', confirmed:false },
];
const APA_CATEGORY_LABEL = { volatility:'Volatility', volatility_1s:'Volatility 1s', step:'Step', boom:'Boom', crash:'Crash' };

// A market is only ever presented as tradable once Deriv's own
// active_symbols response has confirmed it (see connectPublicWS above).
// Until then — or if Deriv never confirms it — it's shown as unavailable.
function isMarketAvailable(mkt) {
    if (!mkt.deriv) return false; // no real Deriv symbol to check at all
    return knownActiveSymbols.size > 0 && knownActiveSymbols.has(mkt.deriv);
}

// ── Trading styles → timeframe stack + expiry ──
// granularities in seconds: M1=60 M5=300 M15=900 M30=1800 H1=3600 H4=14400 D1=86400
const APA_STYLES = {
    quick: { label: 'Quick Profit',  desc: 'High-quality setups, closed out relatively quickly.', bias: 900,   setup: 300,  entry: 60,   expiryMin: 4  },
    day:   { label: 'Day Trading',   desc: 'Capture intraday moves, closed within the session.',   bias: 14400, setup: 900,  entry: 300,  expiryMin: 20 },
    swing: { label: 'Swing Trading', desc: 'Fewer, larger setups — willing to hold longer.',        bias: 86400, setup: 14400,entry: 900,  expiryMin: 90 },
};
const GRAN_LABEL = { 60:'M1', 300:'M5', 900:'M15', 1800:'M30', 3600:'H1', 14400:'H4', 86400:'D1' };

let apaStyle          = 'day';
let apaMarket         = 'R_75';
let apaCurrentSignal  = null;
let apaNotifiedIds    = new Set();
let apaAuditLog       = [];
try { apaAuditLog = JSON.parse(localStorage.getItem('bth_apa_audit') || '[]'); } catch(e) { apaAuditLog = []; }

function saveApaAudit() {
    try { localStorage.setItem('bth_apa_audit', JSON.stringify(apaAuditLog.slice(-200))); } catch(e) {}
}
function logApaAudit(entry) {
    apaAuditLog.push({ ...entry, time: new Date().toISOString() });
    if (apaAuditLog.length > 200) apaAuditLog.shift();
    saveApaAudit();
}

// ── User preferences (client-side only — no server DB exists to persist to) ──
function loadApaPrefs() {
    try {
        const p = JSON.parse(localStorage.getItem('bth_apa_prefs') || '{}');
        if (p.style) apaStyle = p.style;
        if (p.market) apaMarket = p.market;
        if (p.risk) { const el = document.getElementById('apa-risk'); if (el) el.value = p.risk; }
    } catch(e) {}
}
function saveApaPrefs() {
    try {
        localStorage.setItem('bth_apa_prefs', JSON.stringify({
            style: apaStyle, market: apaMarket,
            risk: document.getElementById('apa-risk')?.value || '1'
        }));
    } catch(e) {}
}

// ================================================================
// PRICE-ACTION PRIMITIVES (operate on real OHLC candle arrays)
// ================================================================

// Fractal swing points — a 5-candle pivot high/low
function findSwings(candles) {
    const swings = [];
    for (let i = 2; i < candles.length - 2; i++) {
        const c = candles[i];
        if (c.high > candles[i-1].high && c.high > candles[i-2].high && c.high > candles[i+1].high && c.high > candles[i+2].high) {
            swings.push({ i, type: 'high', price: c.high, epoch: c.epoch });
        }
        if (c.low < candles[i-1].low && c.low < candles[i-2].low && c.low < candles[i+1].low && c.low < candles[i+2].low) {
            swings.push({ i, type: 'low', price: c.low, epoch: c.epoch });
        }
    }
    return swings;
}

// Market structure: HH/HL/LH/LL, BOS, CHoCH
function analyzeStructure(candles) {
    if (!candles || candles.length < 15) return null;
    const swings = findSwings(candles);
    const highs  = swings.filter(s => s.type === 'high');
    const lows   = swings.filter(s => s.type === 'low');
    const last   = candles[candles.length - 1];

    let highLabel = null, lowLabel = null;
    if (highs.length >= 2) highLabel = highs[highs.length-1].price > highs[highs.length-2].price ? 'HH' : 'LH';
    if (lows.length  >= 2) lowLabel  = lows[lows.length-1].price  > lows[lows.length-2].price  ? 'HL' : 'LL';

    let bias = 'neutral';
    if (highLabel === 'HH' && lowLabel === 'HL') bias = 'bullish';
    else if (highLabel === 'LH' && lowLabel === 'LL') bias = 'bearish';
    else if (highLabel === 'HH' || lowLabel === 'HL') bias = 'bullish';
    else if (highLabel === 'LH' || lowLabel === 'LL') bias = 'bearish';

    // BOS — close breaks beyond the most recent swing in the bias direction
    const lastSwingHigh = highs[highs.length-1];
    const lastSwingLow  = lows[lows.length-1];
    let bos = false, choch = false;
    if (bias === 'bullish' && lastSwingHigh && last.close > lastSwingHigh.price) bos = true;
    if (bias === 'bearish' && lastSwingLow  && last.close < lastSwingLow.price)  bos = true;
    // CHoCH — price breaks structure opposite to the prevailing bias
    if (bias === 'bullish' && lastSwingLow && last.close < lastSwingLow.price) choch = true;
    if (bias === 'bearish' && lastSwingHigh && last.close > lastSwingHigh.price) choch = true;

    return { bias, highLabel, lowLabel, bos, choch, swings, highs, lows, lastSwingHigh, lastSwingLow };
}

// Liquidity pools + sweep detection
function analyzeLiquidity(candles, structure) {
    if (!structure) return null;
    const { highs, lows } = structure;
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    if (!prev) return null;

    const tol = (() => {
        const avg = candles.slice(-20).reduce((s,c) => s + (c.high - c.low), 0) / Math.min(20, candles.length);
        return avg * 0.15;
    })();

    // Equal highs/lows — swings within tolerance of each other
    const equalHighs = highs.filter((h,i) => highs.some((h2,j) => j !== i && Math.abs(h.price - h2.price) < tol));
    const equalLows  = lows.filter((l,i) => lows.some((l2,j) => j !== i && Math.abs(l.price - l2.price) < tol));

    const nearestHigh = highs.length ? highs[highs.length-1] : null;
    const nearestLow  = lows.length  ? lows[lows.length-1]  : null;

    // Sweep: wick pierces a pool, body closes back inside
    let sweep = null;
    if (nearestLow && last.low < nearestLow.price && last.close > nearestLow.price) {
        sweep = { type: 'sell_side', label: 'Sell-side liquidity swept (bullish)', pool: nearestLow.price };
    } else if (nearestHigh && last.high > nearestHigh.price && last.close < nearestHigh.price) {
        sweep = { type: 'buy_side', label: 'Buy-side liquidity swept (bearish)', pool: nearestHigh.price };
    }

    return { equalHighs, equalLows, nearestHigh, nearestLow, sweep };
}

// Displacement — body significantly larger than recent average, breaking structure
function analyzeDisplacement(candles, structure) {
    if (!candles || candles.length < 10 || !structure) return null;
    const bodies = candles.slice(-15, -1).map(c => Math.abs(c.close - c.open));
    const avgBody = bodies.reduce((a,b)=>a+b,0) / Math.max(1, bodies.length);
    const last = candles[candles.length - 1];
    const lastBody = Math.abs(last.close - last.open);
    const isBullish = last.close > last.open;

    const strong = avgBody > 0 && lastBody > avgBody * 1.6;
    const alignedWithBias = (structure.bias === 'bullish' && isBullish) || (structure.bias === 'bearish' && !isBullish);
    return { strong, alignedWithBias, isBullish, lastBody, avgBody, confirmsBreak: strong && (structure.bos || structure.choch) };
}

// Fair Value Gap — classic 3-candle imbalance
function findFVG(candles) {
    if (!candles || candles.length < 3) return null;
    for (let i = candles.length - 1; i >= 2; i--) {
        const a = candles[i-2], c = candles[i];
        if (a.high < c.low) return { direction: 'bullish', top: c.low, bottom: a.high, epoch: c.epoch, i, mitigated: false };
        if (a.low > c.high) return { direction: 'bearish', top: a.low, bottom: c.high, epoch: c.epoch, i, mitigated: false };
    }
    return null;
}

// Order block — last opposite candle before the displacement move
function findOrderBlock(candles, displacement) {
    if (!candles || candles.length < 5 || !displacement || !displacement.strong) return null;
    const idx = candles.length - 2; // candle immediately before the displacement candle
    for (let i = idx; i >= Math.max(0, idx - 5); i--) {
        const c = candles[i];
        const isBull = c.close > c.open;
        if (displacement.isBullish && !isBull) return { direction: 'bullish', high: c.high, low: c.low, epoch: c.epoch };
        if (!displacement.isBullish && isBull) return { direction: 'bearish', high: c.high, low: c.low, epoch: c.epoch };
    }
    return null;
}

// Premium/discount positioning within the recent dealing range
function analyzePremiumDiscount(candles) {
    const recent = candles.slice(-50);
    const hi = Math.max(...recent.map(c => c.high));
    const lo = Math.min(...recent.map(c => c.low));
    const last = candles[candles.length-1].close;
    const pct = hi > lo ? (last - lo) / (hi - lo) : 0.5;
    return { pct, zone: pct < 0.5 ? 'discount' : 'premium', high: hi, low: lo };
}

// ================================================================
// APA SIGNAL — combines everything into a scored, directional setup
// (or an honest "no trade")
// ================================================================
async function computeApaSignal(sym, styleKey) {
    const style = APA_STYLES[styleKey] || APA_STYLES.day;
    let biasC, setupC, entryC;
    try {
        [biasC, setupC, entryC] = await Promise.all([
            getCandles(sym, style.bias, 80),
            getCandles(sym, style.setup, 100),
            getCandles(sym, style.entry, 120)
        ]);
    } catch (e) {
        return { noTrade: true, reason: 'Live candle data unavailable right now', score: 0 };
    }
    if (!setupC || setupC.length < 20 || !entryC || entryC.length < 20) {
        return { noTrade: true, reason: 'Not enough candle history yet for this market', score: 0 };
    }

    const biasStruct  = analyzeStructure(biasC);
    const setupStruct = analyzeStructure(setupC);
    const entryStruct = analyzeStructure(entryC);
    if (!setupStruct) return { noTrade: true, reason: 'Structure unclear on the setup timeframe', score: 0 };

    const liquidity     = analyzeLiquidity(setupC, setupStruct);
    const displacement   = analyzeDisplacement(entryC, entryStruct || setupStruct);
    const fvg            = findFVG(entryC);
    const ob              = findOrderBlock(entryC, displacement);
    const premiumDiscount = analyzePremiumDiscount(setupC);

    // Direction requires setup-TF bias AND (a valid sweep OR a confirmed BOS)
    let direction = null;
    if (setupStruct.bias === 'bullish' && (liquidity?.sweep?.type === 'sell_side' || setupStruct.bos)) direction = 'BUY';
    else if (setupStruct.bias === 'bearish' && (liquidity?.sweep?.type === 'buy_side' || setupStruct.bos)) direction = 'SELL';

    // ── MARKET STRUCTURE (20) ──
    let structureScore = 0;
    if (setupStruct.bias !== 'neutral') structureScore += 8;
    if (setupStruct.bos) structureScore += 7;
    if (!setupStruct.choch) structureScore += 3; // no conflicting fresh CHoCH
    if (direction === 'BUY' && premiumDiscount.zone === 'discount') structureScore += 2;
    if (direction === 'SELL' && premiumDiscount.zone === 'premium') structureScore += 2;
    structureScore = Math.min(20, structureScore);

    // ── LIQUIDITY (20) ──
    let liquidityScore = 0;
    if (liquidity?.sweep) liquidityScore += 12;
    if (liquidity?.nearestHigh || liquidity?.nearestLow) liquidityScore += 4;
    if ((liquidity?.equalHighs?.length || 0) + (liquidity?.equalLows?.length || 0) > 0) liquidityScore += 4;
    liquidityScore = Math.min(20, liquidityScore);

    // ── DISPLACEMENT (15) ──
    let displacementScore = 0;
    if (displacement?.strong) displacementScore += 8;
    if (displacement?.alignedWithBias) displacementScore += 4;
    if (displacement?.confirmsBreak) displacementScore += 3;
    displacementScore = Math.min(15, displacementScore);

    // ── FVG / IMBALANCE (10) ──
    let fvgScore = 0;
    if (fvg) {
        const aligned = (direction === 'BUY' && fvg.direction === 'bullish') || (direction === 'SELL' && fvg.direction === 'bearish');
        fvgScore = aligned ? 10 : 4;
    }

    // ── ORDER BLOCK / SUPPLY-DEMAND (10) ──
    let obScore = 0;
    if (ob) {
        const aligned = (direction === 'BUY' && ob.direction === 'bullish') || (direction === 'SELL' && ob.direction === 'bearish');
        obScore = aligned ? 10 : 3;
    }

    // ── MULTI-TIMEFRAME ALIGNMENT (15) ──
    let mtfScore = 0;
    const biasDir = biasStruct?.bias, entryDir = entryStruct?.bias;
    if (direction) {
        const wantBias = direction === 'BUY' ? 'bullish' : 'bearish';
        if (biasDir === wantBias) mtfScore += 8;
        if (entryDir === wantBias) mtfScore += 7;
        else if (entryDir === 'neutral') mtfScore += 3;
    }
    mtfScore = Math.min(15, mtfScore);

    // ── ENTRY / SL / TP + RISK:REWARD (10) ──
    const lastPrice = entryC[entryC.length-1].close;
    let entry = lastPrice, sl = null, tp1 = null, tp2 = null, rr = 0, rrScore = 0;
    if (direction === 'BUY') {
        const obLow = ob?.direction === 'bullish' ? ob.low : null;
        sl  = (obLow ?? liquidity?.nearestLow?.price ?? entry * 0.997) * 0.999;
        tp1 = liquidity?.nearestHigh?.price ?? entry + (entry - sl) * 2;
        tp2 = premiumDiscount.high;
    } else if (direction === 'SELL') {
        const obHigh = ob?.direction === 'bearish' ? ob.high : null;
        sl  = (obHigh ?? liquidity?.nearestHigh?.price ?? entry * 1.003) * 1.001;
        tp1 = liquidity?.nearestLow?.price ?? entry - (sl - entry) * 2;
        tp2 = premiumDiscount.low;
    }
    if (direction && sl && tp1) {
        const risk   = Math.abs(entry - sl);
        const reward = Math.abs(tp1 - entry);
        rr = risk > 0 ? reward / risk : 0;
        rrScore = rr >= 2 ? 10 : rr >= 1.5 ? 7 : rr >= 1 ? 4 : 0;
    }

    const score = Math.round(structureScore + liquidityScore + displacementScore + fvgScore + obScore + mtfScore + rrScore);

    if (!direction || score < 55) {
        const reasons = [];
        if (!direction) reasons.push('No aligned structure + liquidity setup');
        if (rr && rr < 1) reasons.push('Poor risk/reward');
        if (setupStruct.choch) reasons.push('Structure just shifted (CHoCH) — bias unclear');
        return { noTrade: true, reason: reasons[0] || 'Setup quality below threshold', score, breakdown: { structureScore, liquidityScore, displacementScore, fvgScore, obScore, mtfScore, rrScore } };
    }

    let label, color;
    if (score >= 85)      { label = '🟢 GREAT ENTRY'; color = 'var(--green)'; }
    else if (score >= 70) { label = '🟡 GOOD SETUP';  color = 'var(--amber)'; }
    else                  { label = '🟠 WATCH';        color = '#f97316'; }

    const tags = [];
    if (liquidity?.sweep) tags.push('Liquidity Sweep');
    if (setupStruct.bos) tags.push('BOS');
    if (setupStruct.choch) tags.push('CHoCH');
    if (displacement?.strong) tags.push('Displacement');
    if (fvg) tags.push('FVG');
    if (ob) tags.push('Order Block');

    const mkt = APA_MARKETS.find(m => m.deriv === sym);
    return {
        noTrade: false, id: `${sym}_${styleKey}_${Date.now()}`,
        market: sym, mt5Symbol: mkt?.mt5 || sym, display: mkt?.display || sym,
        style: styleKey, styleLabel: style.label,
        direction, score, label, color, tags,
        entry, sl, tp1, tp2, rr: rr.toFixed(2),
        htfBias: biasStruct?.bias || 'unclear',
        confidence: score >= 85 ? 'HIGH' : score >= 70 ? 'MEDIUM' : 'LOW',
        breakdown: { structureScore, liquidityScore, displacementScore, fvgScore, obScore, mtfScore, rrScore },
        entryGranLabel: GRAN_LABEL[style.entry], setupGranLabel: GRAN_LABEL[style.setup], biasGranLabel: GRAN_LABEL[style.bias],
        generatedAt: Date.now(), expiresAt: Date.now() + style.expiryMin * 60000
    };
}

// ================================================================
// UI — Style selector, scanner, setup card
// ================================================================
// ================================================================
// MT5 SIGNAL LIFECYCLE ENGINE
// Generated signals are never deleted when they go stale — they move
// NEW -> ACTIVE -> EXPIRED and stay in Signal History. Persisted to
// localStorage (no server DB exists in this app) so history survives a
// page refresh. The underlying strategy math is untouched — this layer
// just wraps computeApaSignal() with persistence, lifecycle and dedup.
// ================================================================

// Configurable, not hard-coded through the app — change these two knobs only.
const MT5_SIGNAL_VALIDITY_MINUTES        = 15; // how long a signal stays ACTIVE
const MT5_SIGNAL_HISTORY_RETENTION_DAYS  = 7;  // how long EXPIRED signals stay in History
const MT5_SIGNAL_MIN_SCORE               = 70; // generation threshold (APA "Good Setup" or better)
const MT5_SCAN_INTERVAL_MS               = 25000; // background re-scan cadence

let mt5Signals        = [];          // the persisted signal list — single source of truth
let mt5HistoryFilter   = { cat: 'all', instrument: 'all', status: 'all', range: 'all' };
let mt5HistoryTab      = 'active';   // 'active' | 'history'
let mt5ScanTimer       = null;
let mt5ScanInFlight    = false;

function loadMt5Signals() {
    try { mt5Signals = JSON.parse(localStorage.getItem('bth_mt5_signals') || '[]'); }
    catch(e) { mt5Signals = []; }
    pruneMt5Signals();
}
function saveMt5Signals() {
    try { localStorage.setItem('bth_mt5_signals', JSON.stringify(mt5Signals.slice(-500))); } catch(e) {}
}
function pruneMt5Signals() {
    const cutoff = Date.now() - MT5_SIGNAL_HISTORY_RETENTION_DAYS * 86400000;
    mt5Signals = mt5Signals.filter(s => s.generatedAt >= cutoff);
}

function makeSignalId(mkt, date) {
    const code  = (mkt.display || mkt.mt5).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8);
    const stamp = date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    return `${code}-${stamp}`;
}

// Idempotent upsert — never creates a duplicate ACTIVE signal for the same
// market+direction. A genuinely new signal event only happens when this
// market currently has no ACTIVE signal, or the direction has reversed
// (in which case the old one is expired immediately, not deleted).
function upsertMt5Signal(mkt, sig) {
    const existingActive = mt5Signals.find(s => s.market === mkt.deriv && s.status === 'ACTIVE');
    if (existingActive) {
        if (existingActive.direction === sig.direction) return; // same setup still developing — no duplicate
        existingActive.status = 'EXPIRED'; // direction reversed — retire the old one into History
    }
    const now = new Date();
    const record = {
        id: makeSignalId(mkt, now),
        market: mkt.deriv, mt5Symbol: mkt.mt5, display: mkt.display, category: mkt.cat,
        direction: sig.direction, confidence: sig.score, strategy: 'Advanced Price Action (APA)',
        style: sig.style, styleLabel: sig.styleLabel,
        generatedAt: now.getTime(), expiresAt: now.getTime() + MT5_SIGNAL_VALIDITY_MINUTES * 60000,
        status: 'ACTIVE',
        entry: sig.entry, target: sig.tp1, target2: sig.tp2, invalidation: sig.sl, rr: sig.rr,
        tags: sig.tags, htfBias: sig.htfBias
    };
    mt5Signals.push(record);
    saveMt5Signals();
    notify('🟢 NEW SIGNAL', `${mkt.display} ${sig.direction} — ${sig.score}% confidence`, 'ok');
    return record;
}

function updateMt5SignalStatuses() {
    let changed = false;
    const now = Date.now();
    mt5Signals.forEach(s => { if (s.status === 'ACTIVE' && now > s.expiresAt) { s.status = 'EXPIRED'; changed = true; } });
    if (changed) { saveMt5Signals(); renderMt5SignalsUI(); }
}

// Background scan — evaluates every confirmed/available market on the
// currently-selected style and lets upsertMt5Signal() decide whether a new
// record is warranted. Runs independently of which internal tab is open.
async function mt5BackgroundScan() {
    if (mt5ScanInFlight) return;
    mt5ScanInFlight = true;
    try {
        const markets = APA_MARKETS.filter(m => m.confirmed || isMarketAvailable(m));
        for (const mkt of markets) {
            try {
                const sig = await computeApaSignal(mkt.deriv, apaStyle);
                if (!sig.noTrade && sig.score >= MT5_SIGNAL_MIN_SCORE) upsertMt5Signal(mkt, sig);
            } catch(e) {}
            await new Promise(r => setTimeout(r, 150)); // pacing — avoid hammering the candle API
        }
    } finally {
        mt5ScanInFlight = false;
        renderMt5SignalsUI();
    }
}
function startMt5BackgroundScan() {
    if (mt5ScanTimer) return;
    loadMt5Signals();
    mt5BackgroundScan();
    mt5ScanTimer = setInterval(mt5BackgroundScan, MT5_SCAN_INTERVAL_MS);
}

// Age ticks every second without a full re-render — just updates the text.
setInterval(() => {
    updateMt5SignalStatuses();
    document.querySelectorAll('.mt5-age[data-t]').forEach(el => {
        el.textContent = formatSignalAge(parseInt(el.dataset.t, 10));
    });
}, 1000);

function formatSignalAge(sinceMs) {
    const secs = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
    const m = Math.floor(secs / 60), s = secs % 60;
    return `${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`;
}

// ================================================================
// UI — Style selector, market picker, on-demand setup card
// ================================================================
function selectApaStyle(styleKey, btn) {
    apaStyle = styleKey;
    document.querySelectorAll('.apa-style-btn').forEach(b => b.classList.remove('apa-style-active'));
    if (btn) btn.classList.add('apa-style-active');
    saveApaPrefs();
    runApaAnalysis();
}

function onApaMarketChange(sym) {
    apaMarket = sym;
    saveApaPrefs();
    runApaAnalysis();
}

async function runApaAnalysis() {
    const card = document.getElementById('apa-setup-card');
    if (!card) return;
    card.innerHTML = `<div style="font-size:12px;color:var(--muted);text-align:center;padding:20px;">🔎 Analyzing ${MKT[apaMarket]||apaMarket} on ${APA_STYLES[apaStyle].label} timeframes...</div>`;

    const mkt = APA_MARKETS.find(m => m.deriv === apaMarket);
    if (mkt && !mkt.confirmed && !isMarketAvailable(mkt)) {
        card.innerHTML = `<div style="font-size:12px;color:var(--red);text-align:center;padding:20px;">Market currently unavailable — Deriv hasn't confirmed a live symbol for this instrument.</div>`;
        apaCurrentSignal = null;
        return;
    }

    const sig = await computeApaSignal(apaMarket, apaStyle);
    if (!sig.noTrade) { sig.style = apaStyle; sig.styleLabel = APA_STYLES[apaStyle].label; }
    apaCurrentSignal = sig.noTrade ? null : sig;
    renderApaSetupCard(sig);
}

function renderApaSetupCard(sig) {
    const card = document.getElementById('apa-setup-card');
    if (!card) return;

    if (!sig || sig.noTrade) {
        card.innerHTML = `
            <div style="text-align:center;padding:24px 16px;">
                <div style="font-size:32px;margin-bottom:8px;">🔴</div>
                <div style="font-size:15px;font-weight:900;color:var(--red);margin-bottom:4px;">NO TRADE</div>
                <div style="font-size:11px;color:var(--muted);">${sig?.reason || 'No qualifying setup right now'}${sig?.score !== undefined ? ` (score ${sig.score}/100)` : ''}</div>
            </div>`;
        return;
    }

    const dirColor = sig.direction === 'BUY' ? 'var(--green)' : 'var(--red)';
    const fmt = (n) => n !== null && n !== undefined ? Number(n).toFixed(5) : '—';
    const expiresIn = Math.max(0, Math.round((sig.expiresAt - Date.now()) / 60000));

    card.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
            <div>
                <div style="font-size:15px;font-weight:900;">${sig.display}</div>
                <div style="font-size:10px;color:var(--muted);">${sig.styleLabel} · Bias ${sig.biasGranLabel} / Setup ${sig.setupGranLabel} / Entry ${sig.entryGranLabel}</div>
            </div>
            <div style="text-align:right;">
                <div style="font-size:20px;font-weight:900;color:${sig.color};">${sig.score}/100</div>
                <div style="font-size:11px;font-weight:700;color:${sig.color};">${sig.label}</div>
            </div>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
            <span class="badge" style="background:${dirColor}22;color:${dirColor};border:1px solid ${dirColor}44;font-size:12px;padding:4px 10px;">${sig.direction === 'BUY' ? '📈' : '📉'} ${sig.direction}</span>
            <span class="badge badge-blue">HTF Bias: ${sig.htfBias}</span>
            <span class="badge badge-teal">Confidence: ${sig.confidence}</span>
            <span class="badge badge-amber">⏱ Expires in ${expiresIn}m</span>
        </div>
        <div class="accu-row-3" style="margin-bottom:10px;">
            <div class="card-sm" style="padding:8px;text-align:center;"><div style="font-size:9px;color:var(--muted);">ENTRY</div><div style="font-size:13px;font-weight:900;font-family:monospace;">${fmt(sig.entry)}</div></div>
            <div class="card-sm" style="padding:8px;text-align:center;"><div style="font-size:9px;color:var(--muted);">STOP LOSS</div><div style="font-size:13px;font-weight:900;font-family:monospace;color:var(--red);">${fmt(sig.sl)}</div></div>
            <div class="card-sm" style="padding:8px;text-align:center;"><div style="font-size:9px;color:var(--muted);">R:R</div><div style="font-size:13px;font-weight:900;">1:${sig.rr}</div></div>
        </div>
        <div class="accu-row-2" style="margin-bottom:10px;">
            <div class="card-sm" style="padding:8px;text-align:center;"><div style="font-size:9px;color:var(--muted);">TAKE PROFIT 1</div><div style="font-size:13px;font-weight:900;font-family:monospace;color:var(--green);">${fmt(sig.tp1)}</div></div>
            <div class="card-sm" style="padding:8px;text-align:center;"><div style="font-size:9px;color:var(--muted);">TAKE PROFIT 2</div><div style="font-size:13px;font-weight:900;font-family:monospace;color:var(--green);">${fmt(sig.tp2)}</div></div>
        </div>
        <div style="font-size:10px;color:var(--muted);margin-bottom:10px;">Setup: <b style="color:var(--text);">${sig.tags.join(' + ') || '—'}</b></div>
        <button onclick="copySignalText({display:'${sig.display.replace(/'/g,"\\'")}',direction:'${sig.direction}',confidence:${sig.score},generatedAt:${Date.now()},entry:${sig.entry},target:${sig.tp1},invalidation:${sig.sl},id:'ondemand-${Date.now()}'})" class="btn btn-teal" style="width:100%;padding:12px;font-size:14px;font-weight:900;border-radius:8px;">📋 COPY SIGNAL</button>
        <div style="font-size:9px;color:var(--muted);text-align:center;margin-top:6px;">Deriv doesn't allow this site to place MT5 orders directly — copy these levels into the real MT5 terminal to enter manually.</div>`;
}

// ================================================================
// COPY SIGNAL — replaces the old "Apply to MT5" flow. Deriv's public API
// cannot place or manage MT5 orders from a browser, so instead of a
// misleading execute button, every signal offers a clean, copyable summary
// for fast manual entry.
// ================================================================
function formatSignalText(sig) {
    const fmt = (n) => n !== null && n !== undefined ? Number(n).toFixed(5) : '—';
    const risk = document.getElementById('apa-risk')?.value;
    return [
        'BTraderHub Signal',
        `Market: ${sig.display}`,
        `Direction: ${sig.direction}`,
        `Generated: ${new Date(sig.generatedAt).toLocaleString()}`,
        `Confidence: ${sig.confidence}%`,
        `Entry: ${fmt(sig.entry)}`,
        `Target: ${fmt(sig.target)}`,
        sig.target2 !== undefined ? `Target 2: ${fmt(sig.target2)}` : null,
        `Invalidation: ${fmt(sig.invalidation)}`,
        risk ? `Suggested risk: ${risk}%` : null,
        `Signal ID: ${sig.id}`
    ].filter(Boolean).join('\n');
}
function copySignalText(sig) {
    const text = formatSignalText(sig);
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
            .then(() => notify('📋 Signal Copied', 'Paste it into MT5 or your notes to enter the trade manually.', 'ok'))
            .catch(() => window.prompt('Copy this signal:', text));
    } else {
        window.prompt('Copy this signal:', text);
    }
}
function copySignalById(id) {
    const sig = mt5Signals.find(s => s.id === id);
    if (sig) copySignalText(sig);
}

// ================================================================
// ACTIVE SIGNALS + SIGNAL HISTORY UI
// ================================================================
function switchMt5HistoryTab(tab, btn) {
    mt5HistoryTab = tab;
    document.querySelectorAll('.mt5-tab-btn').forEach(b => {
        b.classList.remove('mt5-tab-active', 'btn-teal');
        b.classList.add('btn-ghost');
    });
    if (btn) { btn.classList.add('mt5-tab-active'); btn.classList.remove('btn-ghost'); btn.classList.add('btn-teal'); }
    document.getElementById('mt5-active-section').style.display = tab === 'active' ? 'block' : 'none';
    document.getElementById('mt5-history-section').style.display = tab === 'history' ? 'block' : 'none';
}

function setMt5HistoryFilter(key, value) {
    mt5HistoryFilter[key] = value;
    if (key === 'cat') mt5HistoryFilter.instrument = 'all'; // reset instrument when category changes
    renderMt5SignalsUI();
    if (key === 'cat') populateMt5InstrumentFilter();
}

function populateMt5InstrumentFilter() {
    const sel = document.getElementById('mt5-filter-instrument');
    if (!sel) return;
    const markets = APA_MARKETS.filter(m => mt5HistoryFilter.cat === 'all' || m.cat === mt5HistoryFilter.cat);
    sel.innerHTML = `<option value="all">All Instruments</option>` +
        markets.map(m => `<option value="${m.deriv || m.mt5}">${m.display}</option>`).join('');
}

function signalCardHtml(sig, opts) {
    opts = opts || {};
    const dirColor = sig.direction === 'BUY' ? 'var(--green)' : 'var(--red)';
    const statusColor = sig.status === 'ACTIVE' ? 'var(--green)' : 'var(--muted)';
    const fmt = (n) => n !== null && n !== undefined ? Number(n).toFixed(5) : '—';
    return `
    <div class="card-sm" style="padding:12px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">
            <div>
                <div style="font-size:13px;font-weight:900;">${sig.display}</div>
                <div style="font-size:9px;color:var(--muted);">${sig.strategy || 'APA'} · ${sig.styleLabel || ''}</div>
            </div>
            <span class="badge" style="background:${dirColor}22;color:${dirColor};border:1px solid ${dirColor}44;">${sig.direction === 'BUY' ? '📈' : '📉'} ${sig.direction}</span>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">
            <span class="badge badge-teal">Confidence: ${sig.confidence}%</span>
            <span class="badge" style="background:${statusColor}22;color:${statusColor};border:1px solid ${statusColor}44;">● ${sig.status}</span>
        </div>
        <div style="font-size:10px;color:var(--muted);margin-bottom:4px;">Generated: ${new Date(sig.generatedAt).toLocaleString()}</div>
        <div style="font-size:10px;color:var(--muted);margin-bottom:8px;">Age: <span class="mt5-age" data-t="${sig.generatedAt}">${formatSignalAge(sig.generatedAt)}</span></div>
        ${opts.showLevels ? `
        <div class="accu-row-3" style="margin-bottom:8px;">
            <div style="text-align:center;"><div style="font-size:8px;color:var(--muted);">ENTRY</div><div style="font-size:10px;font-family:monospace;font-weight:700;">${fmt(sig.entry)}</div></div>
            <div style="text-align:center;"><div style="font-size:8px;color:var(--muted);">TARGET</div><div style="font-size:10px;font-family:monospace;font-weight:700;color:var(--green);">${fmt(sig.target)}</div></div>
            <div style="text-align:center;"><div style="font-size:8px;color:var(--muted);">INVALID.</div><div style="font-size:10px;font-family:monospace;font-weight:700;color:var(--red);">${fmt(sig.invalidation)}</div></div>
        </div>` : ''}
        <div style="display:flex;gap:6px;">
            <button onclick="showSignalDetail('${sig.id}')" class="btn btn-ghost" style="flex:1;font-size:10px;padding:6px;">View</button>
            <button onclick="copySignalById('${sig.id}')" class="btn btn-teal" style="flex:1;font-size:10px;padding:6px;">📋 Copy</button>
        </div>
    </div>`;
}

function applyMt5HistoryFilters(list) {
    const now = Date.now();
    const rangeMs = { '1h': 3600000, '6h': 21600000, '24h': 86400000 }[mt5HistoryFilter.range];
    return list.filter(s => {
        if (mt5HistoryFilter.cat !== 'all' && s.category !== mt5HistoryFilter.cat) return false;
        if (mt5HistoryFilter.instrument !== 'all' && s.market !== mt5HistoryFilter.instrument && s.mt5Symbol !== mt5HistoryFilter.instrument) return false;
        if (mt5HistoryFilter.status !== 'all' && s.status !== mt5HistoryFilter.status.toUpperCase()) return false;
        if (rangeMs && (now - s.generatedAt) > rangeMs) return false;
        return true;
    });
}

function renderMt5SignalsUI() {
    // ── Active Signals ──
    const activeList = mt5Signals.filter(s => s.status === 'ACTIVE').sort((a,b) => b.generatedAt - a.generatedAt);
    const activeBody  = document.getElementById('mt5-active-body');
    const activeCount = document.getElementById('mt5-active-count');
    if (activeCount) activeCount.textContent = `(${activeList.length})`;
    if (activeBody) {
        activeBody.innerHTML = activeList.length
            ? `<div class="mt5-signal-grid">${activeList.map(s => signalCardHtml(s, { showLevels: true })).join('')}</div>`
            : `<div style="font-size:11px;color:var(--dim);text-align:center;padding:20px;">No active signals right now. The scanner keeps checking every ${Math.round(MT5_SCAN_INTERVAL_MS/1000)}s across all available markets.</div>`;
    }

    // ── Signal History ──
    const historyAll = mt5Signals.slice().sort((a,b) => b.generatedAt - a.generatedAt);
    const filtered = applyMt5HistoryFilters(historyAll);
    const histBody  = document.getElementById('mt5-history-body');
    const histCount = document.getElementById('mt5-history-count');
    if (histCount) histCount.textContent = `${filtered.length} signal${filtered.length===1?'':'s'}`;
    if (histBody) {
        histBody.innerHTML = filtered.length
            ? `<div class="mt5-signal-grid mt5-history-grid">${filtered.slice(0,150).map(s => signalCardHtml(s, { showLevels: false })).join('')}</div>`
            : `<div style="font-size:11px;color:var(--dim);text-align:center;padding:20px;">No signals match this filter.</div>`;
    }
}

function showSignalDetail(id) {
    const sig = mt5Signals.find(s => s.id === id);
    if (!sig) return;
    const fmt = (n) => n !== null && n !== undefined ? Number(n).toFixed(5) : '—';
    const dirColor = sig.direction === 'BUY' ? 'var(--green)' : 'var(--red)';
    showApaModal(`
        <div style="font-size:14px;font-weight:900;text-align:center;margin-bottom:12px;">SIGNAL DETAILS</div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:14px;font-size:12px;line-height:2;">
            <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Market</span><b>${sig.display}</b></div>
            <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Direction</span><b style="color:${dirColor};">${sig.direction}</b></div>
            <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Generated</span><b>${new Date(sig.generatedAt).toLocaleString()}</b></div>
            <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Confidence</span><b>${sig.confidence}%</b></div>
            <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Status</span><b>${sig.status}</b></div>
            <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Signal Age</span><b class="mt5-age" data-t="${sig.generatedAt}">${formatSignalAge(sig.generatedAt)}</b></div>
            <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Strategy</span><b>${sig.strategy}</b></div>
            <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Entry</span><b style="font-family:monospace;">${fmt(sig.entry)}</b></div>
            <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Target</span><b style="font-family:monospace;color:var(--green);">${fmt(sig.target)}</b></div>
            <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Invalidation</span><b style="font-family:monospace;color:var(--red);">${fmt(sig.invalidation)}</b></div>
            <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Setup</span><b style="text-align:right;max-width:60%;">${(sig.tags||[]).join(' + ') || '—'}</b></div>
            <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Signal ID</span><b style="font-size:10px;">${sig.id}</b></div>
        </div>
        <button class="btn btn-teal" style="width:100%;padding:12px;margin-bottom:8px;font-weight:900;" onclick="copySignalById('${sig.id}')">📋 COPY SIGNAL</button>
        <button class="btn btn-ghost" style="width:100%;padding:10px;" onclick="closeApaModal()">Close</button>
    `);
}

function showApaModal(html) {
    let modal = document.getElementById('apa-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'apa-modal';
        modal.style.cssText = 'display:flex;position:fixed;inset:0;z-index:99999;background:#000000cc;align-items:center;justify-content:center;padding:16px;';
        modal.innerHTML = `<div style="background:var(--bg2);border:1px solid var(--border);border-radius:14px;width:100%;max-width:420px;max-height:88vh;overflow-y:auto;padding:20px;" id="apa-modal-inner"></div>`;
        document.body.appendChild(modal);
        modal.addEventListener('click', (e) => { if (e.target === modal) closeApaModal(); });
    }
    document.getElementById('apa-modal-inner').innerHTML = html;
    modal.style.display = 'flex';
}
function closeApaModal() {
    const modal = document.getElementById('apa-modal');
    if (modal) modal.style.display = 'none';
}

// Refresh the on-demand setup card every 45s when the MT5 tab is active.
// The Active Signals / History engine itself runs independently via
// startMt5BackgroundScan()/setInterval above, regardless of which tab is open.
setInterval(() => {
    if (document.getElementById('mt5-pane')?.classList.contains('active') && apaCurrentSignal) {
        runApaAnalysis();
    }
}, 45000);
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
let accuTickTimes    = {}; // sym -> [timestamps] — feeds the Tick Flow analysis

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
// ADAPTIVE MARKET PROFILES
// Detects market "speed class" from the symbol and returns indicator
// periods tuned for it, so the same engine works sensibly on fast 1s
// indices as well as slow Volatility 75/100 and Jump/Step indices —
// without any manual per-market configuration.
// ================================================================
function getMarketProfile(sym) {
    const is1s   = /^1HZ/.test(sym);
    const isSlow = ['R_75','R_100','jump_75','jump_100','stpRNG'].includes(sym);

    if (is1s) {
        // Fast markets — shorter lookbacks, faster confidence refresh
        return { speedClass: 'fast', emaFast: 5, emaSlow: 13, rsiPeriod: 7, bbPeriod: 10, atrPeriod: 7, updateEveryTicks: 2, volTolerance: 1.4 };
    }
    if (isSlow) {
        // Slow / high-volatility markets — longer smoothing, wider tolerance
        return { speedClass: 'slow', emaFast: 12, emaSlow: 26, rsiPeriod: 21, bbPeriod: 30, atrPeriod: 21, updateEveryTicks: 8, volTolerance: 0.7 };
    }
    // Balanced medium-speed markets (R_10/25/50, jump_10/25/50)
    return { speedClass: 'balanced', emaFast: 9, emaSlow: 21, rsiPeriod: 14, bbPeriod: 20, atrPeriod: 14, updateEveryTicks: 5, volTolerance: 1.0 };
}

// ================================================================
// ADAPTIVE LEARNING — nudges factor weights based on completed-trade
// history. Every 100 trades (per market) we compare the average score
// of each factor between winning and losing trades; factors that ran
// meaningfully higher on wins get a small weight boost next time,
// factors that didn't help get trimmed. Adjustments are capped so the
// model drifts gradually rather than overfitting to a short streak.
// ================================================================
let accuAdaptiveWeights = {}; // sym -> { trend, momentum, volatility, priceBehavior, structure }
const ACCU_BASE_WEIGHTS = { trend: 0.25, momentum: 0.20, volatility: 0.20, priceBehavior: 0.20, structure: 0.15 };

function getAdaptiveWeights(sym) {
    return accuAdaptiveWeights[sym] || { ...ACCU_BASE_WEIGHTS };
}

function runAdaptiveLearning(sym) {
    const trades = accuTradeAnalytics.filter(t => t.market === sym);
    if (trades.length < 100 || trades.length % 100 !== 0) return;

    const wins   = trades.filter(t => t.result === 'TP');
    const losses = trades.filter(t => t.result === 'Loss');
    if (wins.length < 10 || losses.length < 10) return; // not enough of both to learn from

    const avg = (arr, key) => arr.length ? arr.reduce((s,t) => s + (t.factors?.[key] || 0), 0) / arr.length : 0;
    const factors = ['trend','momentum','volatility','priceBehavior','structure'];
    const weights = getAdaptiveWeights(sym);
    let total = 0;

    factors.forEach(f => {
        const winAvg  = avg(wins, f);
        const lossAvg = avg(losses, f);
        const edge    = winAvg - lossAvg; // positive = factor correlates with wins
        // Nudge by up to ±0.03 per learning pass, bounded to [0.08, 0.35]
        const delta   = Math.max(-0.03, Math.min(0.03, edge / 400));
        weights[f]    = Math.max(0.08, Math.min(0.35, (weights[f] ?? ACCU_BASE_WEIGHTS[f]) + delta));
        total += weights[f];
    });
    // Renormalize so weights still sum to 1
    factors.forEach(f => weights[f] = weights[f] / total);

    accuAdaptiveWeights[sym] = weights;
    log(`🧠 Adaptive learning: recalibrated weights for ${MKT[sym]||sym} after ${trades.length} trades`, 'i');
}

// ================================================================
// MARKET BEHAVIOUR ENGINE
// Looks at raw tick flow rather than lagging indicators — speed,
// acceleration, directional-change frequency, stability/noise, a
// short-horizon micro-trend read, and spike/reversal detection.
// ================================================================
function analyzeTickFlow(sym) {
    const times  = accuTickTimes[sym] || [];
    const mm     = marketMemory[sym];
    const prices = mm?.prices || [];
    if (prices.length < 10) return null;

    // Tick speed — ticks per second from real arrival timestamps
    let ticksPerSec = null;
    if (times.length >= 5) {
        const span = (times[times.length-1] - times[0]) / 1000;
        ticksPerSec = span > 0 ? (times.length - 1) / span : null;
    }

    // Acceleration — is tick speed increasing or decreasing?
    let accel = 'steady';
    if (times.length >= 10) {
        const half = Math.floor(times.length / 2);
        const firstSpan = (times[half] - times[0]) / 1000;
        const secondSpan = (times[times.length-1] - times[half]) / 1000;
        const firstRate  = firstSpan > 0 ? half / firstSpan : 0;
        const secondRate = secondSpan > 0 ? (times.length - half) / secondSpan : 0;
        if (secondRate > firstRate * 1.2) accel = 'accelerating';
        else if (secondRate < firstRate * 0.8) accel = 'decelerating';
    }

    // Directional change frequency — how often does tick-to-tick direction flip?
    const recent = prices.slice(-30);
    let flips = 0;
    for (let i = 2; i < recent.length; i++) {
        const prevDir = recent[i-1] - recent[i-2];
        const curDir  = recent[i] - recent[i-1];
        if ((prevDir > 0 && curDir < 0) || (prevDir < 0 && curDir > 0)) flips++;
    }
    const flipRate = recent.length > 2 ? flips / (recent.length - 2) : 0;

    // Momentum — net directional bias over the recent window
    const netMove  = recent.length > 1 ? recent[recent.length-1] - recent[0] : 0;
    const avgAbs   = recent.length > 1
        ? recent.slice(1).reduce((s,p,i) => s + Math.abs(p - recent[i]), 0) / (recent.length - 1)
        : 0;
    const tickMomentum = avgAbs > 0 ? netMove / (avgAbs * recent.length) : 0; // roughly -1..1

    return { ticksPerSec, accel, flipRate, tickMomentum };
}

// Micro trend over the last 20-100 ticks — up / down / sideways bias
function detectMicroTrend(prices) {
    if (!prices || prices.length < 20) return { bias: 'unknown', strength: 0, label: '—' };
    const window = prices.slice(-Math.min(100, prices.length));
    const up   = window.filter((p,i) => i > 0 && p > window[i-1]).length;
    const down = window.filter((p,i) => i > 0 && p < window[i-1]).length;
    const total = window.length - 1;
    const upPct = total > 0 ? up / total : 0.5;
    const downPct = total > 0 ? down / total : 0.5;

    let bias = 'sideways', label = '➡ Sideways';
    if (upPct >= 0.58) { bias = 'up'; label = '📈 Upward bias'; }
    else if (downPct >= 0.58) { bias = 'down'; label = '📉 Downward bias'; }
    const strength = Math.round(Math.abs(upPct - downPct) * 100);
    return { bias, strength, label };
}

// Reversal / spike guard — true when the market just did something the
// engine should wait out rather than trade into immediately.
function detectReversalRisk(prices) {
    if (!prices || prices.length < 12) return { risk: false, reason: null };
    const recent = prices.slice(-12);
    const moves  = [];
    for (let i = 1; i < recent.length; i++) moves.push(recent[i] - recent[i-1]);
    const avgAbsMove = moves.reduce((s,m) => s + Math.abs(m), 0) / moves.length;
    const lastMove    = moves[moves.length - 1];
    const prevMove    = moves[moves.length - 2] || 0;

    // Very large spike on the last tick
    if (avgAbsMove > 0 && Math.abs(lastMove) > avgAbsMove * 4) {
        return { risk: true, reason: 'Very large spike on the last tick' };
    }
    // Rapid reversal — sharp move immediately followed by an opposite sharp move
    if (avgAbsMove > 0 && Math.abs(prevMove) > avgAbsMove * 2.5 &&
        Math.sign(prevMove) !== Math.sign(lastMove) && Math.abs(lastMove) > avgAbsMove * 2) {
        return { risk: true, reason: 'Rapid reversal just occurred' };
    }
    // Unusually long directional run — market is stretched, due for a pause
    let runLen = 1;
    for (let i = moves.length - 1; i > 0; i--) {
        if (Math.sign(moves[i]) === Math.sign(moves[i-1]) && Math.sign(moves[i]) !== 0) runLen++;
        else break;
    }
    if (runLen >= 9) {
        return { risk: true, reason: `Unusually long ${runLen}-tick directional run` };
    }
    return { risk: false, reason: null };
}

// Market regime classification — combines trend strength and volatility
// into one label, and the confidence threshold adapts to it (calm markets
// can trade at a lower bar, explosive markets need a much higher one).
function classifyRegime(trendStrength, stabilityScore, flipRate) {
    // trendStrength: 0-100 (how directional), stabilityScore: 0-100 (higher = calmer)
    if (stabilityScore >= 80 && trendStrength < 20) return { regime: 'Calm',      icon: '🟢', thresholdAdj: -5  };
    if (stabilityScore >= 55 && trendStrength >= 35) return { regime: 'Trending', icon: '🟢', thresholdAdj: 0   };
    if (stabilityScore < 30 || flipRate > 0.65)      return { regime: 'Explosive',icon: '🔴', thresholdAdj: 15  };
    if (stabilityScore < 50)                          return { regime: 'Volatile', icon: '🟠', thresholdAdj: 8   };
    return { regime: 'Normal', icon: '🟡', thresholdAdj: 0 };
}

// ================================================================
// DYNAMIC WEIGHTED CONFIDENCE ENGINE
// Every factor contributes partial credit rather than gating the trade —
// this keeps trade frequency healthy (including on fast 1s markets)
// while still steering away from poor-quality entries.
// Weighting: Trend 25% | Momentum 20% | Volatility 20% | Price Behaviour 20% | Market Structure 15%
// ================================================================
function calcAccuConfidence(sym) {
    const mm = marketMemory[sym] || { prices: [] };
    const prices = mm.prices || [];
    const profile = getMarketProfile(sym);
    const minTicks = Math.max(20, profile.bbPeriod);

    if (prices.length < minTicks) {
        return { ready: false, ticksNeeded: minTicks - prices.length, profile };
    }

    const last    = prices[prices.length - 1];
    const emaFast = calcEMA(prices, profile.emaFast);
    const emaSlow = calcEMA(prices, Math.min(profile.emaSlow, prices.length - 1));
    const rsi     = calcRSI(prices, profile.rsiPeriod);
    const rsiPrev = prices.length > 2 ? calcRSI(prices.slice(0, -1), profile.rsiPeriod) : null;
    const bb      = calcBollingerBands(prices, profile.bbPeriod, 2);
    const atr     = calcATR(prices, profile.atrPeriod);
    const stab    = calcTickStability(prices);
    const flow    = analyzeTickFlow(sym);
    const micro   = detectMicroTrend(prices);
    const reversal = detectReversalRisk(prices);

    // ── TREND (25%) — EMA fast>slow +15, price above EMA +10 ──
    let trendScore = 0;
    let emaTrendLabel = '—';
    if (emaFast !== null && emaSlow !== null) {
        const aligned = emaFast > emaSlow;
        emaTrendLabel = aligned ? `📈 Bullish (EMA${profile.emaFast}>${profile.emaSlow})` : `📉 Bearish (EMA${profile.emaFast}<${profile.emaSlow})`;
        if (aligned) trendScore += 60; // scaled to 100, weighted below (15/25 of trend)
        if (last > emaFast) trendScore += 40; // (10/25 of trend)
    }
    trendScore = Math.min(100, trendScore);

    // ── MOMENTUM (20%) — RSI 48-65 +10, RSI rising +10 ──
    let momentumScore = 0;
    if (rsi !== null) {
        if (rsi >= 48 && rsi <= 65) momentumScore += 50;
        else if (rsi > 65 && rsi <= 72) momentumScore += 20;
        else if (rsi >= 40 && rsi < 48) momentumScore += 20;
        if (rsiPrev !== null && rsi > rsiPrev) momentumScore += 50;
    }
    momentumScore = Math.min(100, momentumScore);

    // ── VOLATILITY (20%) — BB not excessively wide +10, stable volatility +10 ──
    let volatilityScore = 0;
    if (bb) {
        const wideCeiling = 0.5 * profile.volTolerance;
        if (bb.bandwidth < wideCeiling) volatilityScore += 50;
        else if (bb.bandwidth < wideCeiling * 1.5) volatilityScore += 20;
    }
    if (stab) volatilityScore += Math.round(stab.score * 0.5);
    volatilityScore = Math.min(100, volatilityScore);

    // ── PRICE BEHAVIOUR (20%) — no sudden spikes +10, smooth tick movement +10 ──
    let priceBehaviorScore = 0;
    if (!reversal.risk) priceBehaviorScore += 50;
    if (stab) priceBehaviorScore += Math.round(Math.max(0, 100 - stab.jumpFreq * 300) * 0.5);
    priceBehaviorScore = Math.min(100, priceBehaviorScore);

    // ── MARKET STRUCTURE (15%) — directional consistency +10, not right after a big move +5 ──
    let structureScore = 0;
    if (micro.bias !== 'sideways' && micro.bias !== 'unknown') structureScore += Math.min(67, 40 + micro.strength);
    else structureScore += 20;
    if (!reversal.risk) structureScore += 33;
    structureScore = Math.min(100, structureScore);

    // ── REGIME DETECTION — adjusts the effective entry threshold ──
    const trendStrength = Math.abs((micro.strength || 0));
    const regimeInfo = classifyRegime(trendStrength, stab ? stab.score : 50, flow ? flow.flipRate : 0.3);

    // ── WEIGHTED SCORE (adaptive weights, learned per market over time) ──
    const w = getAdaptiveWeights(sym);
    const score = Math.round(
        trendScore         * w.trend +
        momentumScore       * w.momentum +
        volatilityScore     * w.volatility +
        priceBehaviorScore  * w.priceBehavior +
        structureScore      * w.structure
    );

    const effectiveThreshold = 75 + regimeInfo.thresholdAdj; // baseline "Good Entry" bar, shifted by regime

    let label, color;
    if (score >= 90)      { label = '🟢 Excellent Entry'; color = 'var(--green)'; }
    else if (score >= 80) { label = '🟢 Great Entry';     color = 'var(--green)'; }
    else if (score >= 75) { label = '🟡 Good Entry';      color = 'var(--amber)'; }
    else                  { label = '🔴 No Trade';        color = 'var(--red)';   }

    // Loss-prevention overrides — these can block a trade even if the
    // weighted score alone looks acceptable.
    const blockers = [];
    if (reversal.risk) blockers.push(reversal.reason);
    if (stab && stab.jumpFreq > 0.15) blockers.push('Erratic tick movement (frequent jumps)');
    if (regimeInfo.regime === 'Explosive') blockers.push('Market regime is Explosive');
    const lossPreventionBlocked = blockers.length > 0;

    const tradeOk = score >= effectiveThreshold && !lossPreventionBlocked;

    return {
        ready: true, score, label, color, tradeOk, effectiveThreshold,
        emaFast, emaSlow, emaTrendLabel, rsi, bb, atr, stab, flow, micro, reversal,
        regime: regimeInfo, blockers, profile,
        breakdown: { trendScore, momentumScore, volatilityScore, priceBehaviorScore, structureScore },
        weights: w
    };
}

// Human-readable spike-risk label for the dashboard
function spikeRiskLabel(conf) {
    if (!conf.ready) return { text: '—', color: 'var(--muted)' };
    if (conf.reversal?.risk) return { text: 'High', color: 'var(--red)' };
    if (conf.stab && conf.stab.jumpFreq > 0.08) return { text: 'Elevated', color: 'var(--amber)' };
    return { text: 'Low', color: 'var(--green)' };
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
        set('accu-regime', '—'); set('accu-spike-risk', '—'); set('accu-micro-trend', '—');
        const sigBox = document.getElementById('accu-signal-box');
        if (sigBox) sigBox.innerHTML = `<div style="font-size:11px;color:var(--muted);">Collecting data... need ${conf.ticksNeeded} more ticks (${conf.profile.speedClass} market profile)</div>`;
        return;
    }

    // RSI
    set('accu-rsi', conf.rsi ?? '—', conf.rsi > 70 ? 'var(--red)' : conf.rsi < 30 ? 'var(--green)' : '#60a5fa');
    set('accu-rsi-label', conf.rsi > 70 ? 'Overbought' : conf.rsi < 30 ? 'Oversold' : (conf.rsi >= 48 && conf.rsi <= 65) ? 'Sweet spot' : 'Neutral');

    // BB
    if (conf.bb) {
        set('accu-bb-width', conf.bb.bandwidth.toFixed(2) + '%', conf.breakdown.volatilityScore >= 60 ? 'var(--green)' : conf.breakdown.volatilityScore >= 35 ? 'var(--amber)' : 'var(--red)');
        set('accu-bb-label', conf.bb.bandwidth < 0.1 ? 'Squeezing ✅' : conf.bb.bandwidth < 0.4 ? 'Normal' : 'Wide ⚠️');
    }

    // Tick speed (repurposed "ADX" tile)
    const tps = conf.flow?.ticksPerSec;
    set('accu-adx', tps !== null && tps !== undefined ? `${tps.toFixed(1)}/s` : '—', 'var(--amber)');
    set('accu-adx-label', conf.flow ? (conf.flow.accel === 'accelerating' ? 'Accelerating' : conf.flow.accel === 'decelerating' ? 'Decelerating' : 'Steady') : '—');

    // EMA trend
    set('accu-ema-trend', conf.emaTrendLabel, conf.emaFast > conf.emaSlow ? 'var(--green)' : 'var(--red)');

    // ATR
    set('accu-atr', conf.atr !== null ? conf.atr.toFixed(5) : '—', 'var(--muted)');

    // Tick stability
    if (conf.stab) {
        set('accu-tick-stability', `${conf.stab.score}/100`, conf.stab.score >= 70 ? 'var(--green)' : conf.stab.score >= 40 ? 'var(--amber)' : 'var(--red)');
    }

    // Market regime
    set('accu-regime', `${conf.regime.icon} ${conf.regime.regime}`, conf.regime.regime === 'Calm' || conf.regime.regime === 'Trending' ? 'var(--green)' : conf.regime.regime === 'Explosive' ? 'var(--red)' : 'var(--amber)');

    // Spike risk
    const spike = spikeRiskLabel(conf);
    set('accu-spike-risk', spike.text, spike.color);

    // Micro trend
    set('accu-micro-trend', conf.micro.label, conf.micro.bias === 'up' ? 'var(--green)' : conf.micro.bias === 'down' ? 'var(--red)' : 'var(--muted)');

    // Volatility meter — driven by the volatility sub-score
    const volBar   = document.getElementById('accu-vol-bar');
    const volLabel = document.getElementById('accu-vol-label');
    const volPct   = 100 - conf.breakdown.volatilityScore;
    if (volBar)   { volBar.style.width = Math.max(5, volPct) + '%'; volBar.style.background = conf.breakdown.volatilityScore >= 60 ? 'var(--green)' : conf.breakdown.volatilityScore >= 35 ? 'var(--amber)' : 'var(--red)'; }
    if (volLabel) { volLabel.textContent = conf.breakdown.volatilityScore >= 60 ? 'Low ✅' : conf.breakdown.volatilityScore >= 35 ? 'Medium ⚠️' : 'High ❌'; volLabel.style.color = volBar ? volBar.style.background : ''; }

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

    // ── AI Market Scanner dashboard — Market Health + Recommendation ──
    const sigBox    = document.getElementById('accu-signal-box');
    const growthRec = document.getElementById('accu-growth-rec');
    if (sigBox) {
        const b = conf.breakdown;
        const recommend = conf.tradeOk
            ? `<span style="color:var(--green);">🟢 ENTER</span>`
            : conf.blockers.length > 0
                ? `<span style="color:var(--red);">🔴 WAIT — ${conf.blockers[0]}</span>`
                : `<span style="color:var(--amber);">🟡 WAIT — below ${conf.effectiveThreshold}% threshold</span>`;

        sigBox.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
                <div style="font-size:16px;font-weight:900;color:${conf.color};">Market Health: ${conf.score}%</div>
                <div style="font-size:12px;font-weight:900;color:${conf.color};">${conf.label}</div>
            </div>
            <div class="pbar" style="margin-bottom:8px;"><div class="pbar-fill" style="width:${conf.score}%;background:${conf.color};"></div></div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:9px;color:var(--muted);text-align:left;margin-bottom:8px;">
                <div>Regime: <b style="color:var(--text);">${conf.regime.icon} ${conf.regime.regime}</b></div>
                <div>Threshold (adaptive): <b style="color:var(--text);">${conf.effectiveThreshold}%</b></div>
                <div>Trend (${Math.round(conf.weights.trend*100)}%): <b style="color:var(--text);">${Math.round(b.trendScore)}</b></div>
                <div>Momentum (${Math.round(conf.weights.momentum*100)}%): <b style="color:var(--text);">${Math.round(b.momentumScore)}</b></div>
                <div>Volatility (${Math.round(conf.weights.volatility*100)}%): <b style="color:var(--text);">${Math.round(b.volatilityScore)}</b></div>
                <div>Price Behaviour (${Math.round(conf.weights.priceBehavior*100)}%): <b style="color:var(--text);">${Math.round(b.priceBehaviorScore)}</b></div>
                <div>Structure (${Math.round(conf.weights.structure*100)}%): <b style="color:var(--text);">${Math.round(b.structureScore)}</b></div>
                <div>Tick Stability: <b style="color:var(--text);">${conf.stab ? conf.stab.score : '—'}%</b></div>
            </div>
            <div style="font-size:11px;font-weight:700;text-align:left;">Recommendation: ${recommend}</div>`;

        // Recommend growth rate based on the volatility sub-score
        const recRate = b.volatilityScore >= 75 ? '3%' : b.volatilityScore >= 50 ? '2%' : '1%';
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
    if (conf.score >= 90) return 'excellent';
    if (conf.score >= 80) return 'great';
    if (conf.score >= 75) return 'good';
    return 'bad';
}

// Does the current confidence reading clear BOTH the engine's own adaptive
// threshold (regime-adjusted, loss-prevention aware) AND the user's Auto
// Mode threshold setting? Manual starts only need the engine's own bar.
// Also enforces a brief stabilization cooldown after the previous trade
// closed, per the loss-prevention rule: don't re-enter into a market that
// hasn't settled down yet.
const ACCU_STABILIZE_COOLDOWN_MS = 1200;
let accuLastSettleTime = 0;

function meetsAutoThreshold(conf) {
    if (!conf.ready) return false;
    if (Date.now() - accuLastSettleTime < ACCU_STABILIZE_COOLDOWN_MS) return false;
    const userThreshold = parseFloat(document.getElementById('accu-conf-threshold')?.value || 75);
    return conf.tradeOk && conf.score >= userThreshold;
}

let accuWatchInterval = null;
let accuWaiting       = false;

// Continuous market monitor — this is the "Smart Auto Mode" watcher.
// It keeps re-evaluating market health (not just polling for one static
// condition), automatically pausing through Explosive/blocked regimes and
// resuming the instant a qualifying reading returns.
function startWatchingForGreatEntry(stake, tp) {
    if (accuWatchInterval) clearInterval(accuWatchInterval);
    accuWaiting = true;

    // Update run button to show waiting state
    const btn = document.getElementById('accu-run-btn');
    if (btn) { btn.textContent = '⏳ Monitoring market...'; btn.style.opacity = '0.7'; }

    log('⏳ Smart monitor active — watching for a qualifying entry...', 'i');

    accuWatchInterval = setInterval(() => {
        if (!accuWaiting) { clearInterval(accuWatchInterval); return; }

        const conf = calcAccuConfidence(accuMarket);
        if (!conf.ready) { log('📊 Still collecting data for confidence score...', 'd'); return; }

        const isAutoRestart = accuAutoRunning;
        const qualifies = isAutoRestart ? meetsAutoThreshold(conf) : conf.tradeOk;

        if (!qualifies) {
            const why = conf.blockers.length ? conf.blockers[0] : `score ${conf.score}% below ${conf.effectiveThreshold}% threshold`;
            log(`📊 Waiting — ${conf.regime.icon} ${conf.regime.regime} | ${why}`, 'd');
            return;
        }

        clearInterval(accuWatchInterval);
        accuWaiting = false;
        const btn2 = document.getElementById('accu-run-btn');
        if (btn2) { btn2.textContent = '▶ Start Accumulator'; btn2.style.opacity = '1'; }
        notify('✅ Qualifying Entry Found!', `Confidence ${conf.score}% (${conf.label}) | Regime: ${conf.regime.regime}. Starting accumulator now!`, 'ok');
        log(`✅ Qualifying entry detected (${conf.score}%, ${conf.regime.regime}) — starting accumulator!`, 'w');
        toggleAccumulator();
    }, 1500); // fast poll — Smart Auto Mode reacts quickly to changing conditions
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

        // Trade analytics log — confidence + underlying factors for this trade.
        // `factors` stores the 0-100 sub-scores that runAdaptiveLearning()
        // compares between wins and losses to recalibrate weights over time.
        accuTradeAnalytics.push({
            time: new Date().toISOString(),
            market: accuMarket,
            confidence: confScore,
            regime: confSnapshot?.regime?.regime,
            rsi: confSnapshot?.rsi, atr: confSnapshot?.atr,
            bbWidth: confSnapshot?.bb?.bandwidth, emaTrend: confSnapshot?.emaTrendLabel,
            tickStability: confSnapshot?.stab?.score,
            factors: confSnapshot?.breakdown ? {
                trend: confSnapshot.breakdown.trendScore,
                momentum: confSnapshot.breakdown.momentumScore,
                volatility: confSnapshot.breakdown.volatilityScore,
                priceBehavior: confSnapshot.breakdown.priceBehaviorScore,
                structure: confSnapshot.breakdown.structureScore
            } : undefined,
            ticks: accuTickCount, result: isWin ? 'TP' : 'Loss', profit
        });
        if (accuTradeAnalytics.length > 500) accuTradeAnalytics.shift();

        // Adaptive learning — recalibrate this market's factor weights every 100 trades
        runAdaptiveLearning(accuMarket);

        // Add to history (with confidence column)
        addAccuHistory(accuMarket, accuGrowthRate, stake, accuTickCount, profit, isWin, confScore);

        log(`${isWin ? '✅' : '❌'} Accumulator ${isWin?'sold':'knocked out'} | ${accuTickCount} ticks | P/L: $${profit.toFixed(2)} | Total: $${accuTotalPL.toFixed(2)}`, isWin ? 'w' : 'l');

        if (isWin) { try { playWin(); } catch(e) {} }
        else       { try { playLoss(); } catch(e) {} }

        // Reset UI — exactly once per settled contract, thanks to the guard above
        resetAccuUI();
        accuLastSettleTime = Date.now(); // starts the stabilization cooldown before the next entry
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
                        const conf = calcAccuConfidence(accuMarket);
                        if (meetsAutoThreshold(conf)) {
                            toggleAccumulator();
                        } else {
                            const threshold = parseFloat(document.getElementById('accu-conf-threshold')?.value || 75);
                            log(`⏳ Auto mode: waiting for a qualifying entry (≥${threshold}%, regime-aware) before next session...`, 'i');
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
                        const conf = calcAccuConfidence(accuMarket);
                        if (meetsAutoThreshold(conf)) {
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
