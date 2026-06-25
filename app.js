// ================================================================
// BTRADERHUB app.js — Complete Professional Build
// Auth: Amy-verified PKCE (preserved exactly)
// ================================================================

const DERIV_CLIENT_ID = "33ByqD0GecGTE5whirko8";
const DERIV_APP_ID    = "33ByqD0GecGTE5whirko8";
const DERIV_REDIRECT  = "https://btraderhub.vercel.app/";

// ── Global state ──────────────────────────────────────────────
let derivWS        = null;
let accessToken    = null;
let accountId      = null;
let allAccounts    = [];
let isReconnecting = false;

// Bot state
let isBotRunning    = false;
let activeBotId     = null;
let activeBotName   = "None";
let botDirection    = null;
let currentStake    = 0;
let totalProfitLoss = 0;
let totalRuns       = 0;
let totalWins       = 0;
let currentStreak   = 0;
let peakExposure    = 0;
let lastContractId  = null;
let slaveAccounts   = [];
let seenSignals     = new Set();
let consecutiveCount = 0;
let lastDigitSeen   = null;

// Digit data per market — populated from REAL tick history only
let digitData = {};
// { "R_10": { counts:[0..9], ticks:0 } }

let currentHubMarket = "R_10";
let activeTickSubs   = new Set();

// Bot repository
let botRepository = [
    { id:1, name:"Over/Under Bot",  type:"over_under",    market:"R_10",  stake:1, martingale:2.1, tp:50, sl:100, direction:"over",  ticks:1, prediction:1 },
    { id:2, name:"Even/Odd Bot",    type:"even_odd",      market:"R_50",  stake:1, martingale:2.1, tp:50, sl:100, direction:"even",  ticks:1, prediction:0 },
    { id:3, name:"Rise/Fall Bot",   type:"rise_fall",     market:"R_100", stake:1, martingale:2.1, tp:50, sl:100, direction:"rise",  ticks:5, prediction:0 },
    { id:4, name:"Only Ups Bot",    type:"only_ups_downs",market:"R_75",  stake:1, martingale:2.0, tp:30, sl:60,  direction:"ups",   ticks:5, prediction:0 },
];

// Valid Deriv contract types — for validation
const CONTRACT_TYPES = {
    over_under:     { over:"DIGITOVER", under:"DIGITUNDER" },
    even_odd:       { even:"DIGITEVEN", odd:"DIGITODD" },
    rise_fall:      { rise:"CALL", fall:"PUT" },
    only_ups_downs: { ups:"RUNHIGH", downs:"RUNLOW" },
    high_low_ticks: { high:"TICKHIGH", low:"TICKLOW" },
    accumulator:    { accumulator:"ACCU" }
};

const MARKETS_ALL = ["R_10","R_25","R_50","R_75","R_100","1HZ10V","1HZ50V","JD10","JD50"];
const MARKET_LABELS = {
    R_10:"Volatility 10",R_25:"Volatility 25",R_50:"Volatility 50",
    R_75:"Volatility 75",R_100:"Volatility 100",
    "1HZ10V":"V10 (1s)","1HZ25V":"V25 (1s)","1HZ50V":"V50 (1s)",
    "1HZ75V":"V75 (1s)","1HZ100V":"V100 (1s)",
    JD10:"Jump 10",JD25:"Jump 25",JD50:"Jump 50",JD75:"Jump 75",JD100:"Jump 100"
};

const winAudio  = new Audio('https://actions.google.com/sounds/v1/cartoon/slide_whistle_up.ogg');
const lossAudio = new Audio('https://actions.google.com/sounds/v1/cartoon/boing_long.ogg');

// ================================================================
// PAGE LOAD
// ================================================================
window.addEventListener('load', async () => {
    renderBotRepository();
    onTradeTypeChange();
    initTVChart("OANDA:XAUUSD");

    const params = new URLSearchParams(window.location.search);
    const code   = params.get('code');
    const state  = params.get('state');
    if (code && state) {
        window.history.replaceState({}, document.title, window.location.pathname);
        await handleOAuthCallback(code, state);
    }
});

// ================================================================
// TAB NAVIGATION
// ================================================================
function switchTab(tabId) {
    document.querySelectorAll('.tab-pane').forEach(p => {
        p.style.display = 'none';
        p.classList.remove('active');
    });
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));

    const pane = document.getElementById(tabId + '-pane');
    const btn  = document.getElementById('tab-btn-' + tabId);

    if (pane) {
        pane.classList.add('active');
        if (['bot-builder','deriv-chart','tv-chart'].includes(tabId)) {
            pane.style.display = 'flex';
        } else if (tabId === 'hub') {
            pane.style.display = 'grid';
        } else {
            pane.style.display = 'block';
        }
    }
    if (btn) btn.classList.add('active');

    if (tabId === 'tv-chart')   setTimeout(() => initTVChart("OANDA:XAUUSD"), 120);
    if (tabId === 'hub')        { onHubMarketChange(currentHubMarket); }
    if (tabId === 'bot-builder') onBuilderChange();
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

    if (state !== savedState) { showStatus("Security error: state mismatch.", 'error'); return; }

    showStatus("Exchanging authorization code...", 'info');
    try {
        const resp = await fetch('/api/deriv-token', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ code, code_verifier, redirect_uri:DERIV_REDIRECT, client_id:DERIV_CLIENT_ID })
        });
        const tokens = await resp.json();
        if (!resp.ok) { showStatus(`Auth failed: ${tokens.error||'Unknown'}`, 'error'); return; }
        accessToken = tokens.access_token;
        showStatus("Loading your accounts...", 'info');
        await loadAccounts();
    } catch(err) {
        showStatus("Connection error. Please try again.", 'error');
        console.error(err);
    }
}

// ================================================================
// AUTH — STEP 3: Load all accounts
// ================================================================
async function loadAccounts() {
    try {
        const headers = { 'Authorization':`Bearer ${accessToken}`, 'Deriv-App-ID':DERIV_APP_ID };
        let resp = await fetch('https://api.derivws.com/trading/v1/options/accounts', { method:'GET', headers });
        let data = await resp.json();
        allAccounts = Array.isArray(data?.data) ? data.data : [];

        if (allAccounts.length === 0) {
            showStatus("Creating demo account...", 'info');
            resp = await fetch('https://api.derivws.com/trading/v1/options/accounts', {
                method:'POST', headers:{...headers,'Content-Type':'application/json'},
                body: JSON.stringify({ currency:"USD", group:"row", account_type:"demo" })
            });
            data = await resp.json();
            if (!resp.ok||!data?.data) { showStatus("Failed to create account.", 'error'); return; }
            allAccounts = [data.data];
        }

        // Populate switcher
        const sw = document.getElementById('account-switcher');
        if (sw) {
            sw.innerHTML = '';
            allAccounts.forEach(acc => {
                const opt    = document.createElement('option');
                opt.value    = acc.account_id;
                const isDemo = acc.account_type === 'demo';
                opt.text     = `${isDemo ? '🟡 Demo' : '🟢 Real'} — ${acc.currency||'USD'}`;
                sw.appendChild(opt);
            });
        }

        const demo = allAccounts.find(a => a.account_type === 'demo') || allAccounts[0];
        accountId  = demo.account_id;
        if (sw) sw.value = accountId;

        await openAuthenticatedWS();
    } catch(err) {
        showStatus("Failed to load accounts.", 'error');
        console.error(err);
    }
}

// ================================================================
// AUTH — STEP 4: Switch account
// ================================================================
async function switchAccount(newId) {
    if (newId === accountId) return;
    accountId = newId;
    logJournal(`Switching account: ${accountId}`);
    if (derivWS) { derivWS.close(); derivWS = null; }
    await openAuthenticatedWS();
}

// ================================================================
// AUTH — STEP 5: OTP → WebSocket
// ================================================================
async function openAuthenticatedWS() {
    try {
        showStatus("Opening secure connection...", 'info');
        const headers = { 'Authorization':`Bearer ${accessToken}`, 'Deriv-App-ID':DERIV_APP_ID };

        const otpResp = await fetch(
            `https://api.derivws.com/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
            { method:'POST', headers }
        );
        const otpData = await otpResp.json();

        if (!otpResp.ok || !otpData?.data?.url) {
            showStatus(`OTP failed: ${JSON.stringify(otpData?.error||otpData)}`, 'error');
            return;
        }

        derivWS = new WebSocket(otpData.data.url);

        derivWS.onopen = () => {
            isReconnecting = false;
            updateConnectionStatus(true);
            showStatus("✅ Connected and ready!", 'success');

            document.getElementById('login-nav-btn')?.classList.add('hidden');
            document.getElementById('signup-nav-btn')?.classList.add('hidden');
            const sw = document.getElementById('account-switcher-wrap');
            if (sw) sw.style.display = 'flex';
            document.getElementById('auth-card')?.classList.add('hidden');
            const ds = document.getElementById('dashboard-stats');
            if (ds) ds.style.display = 'block';
            const bs = document.getElementById('bar-stats');
            if (bs) bs.style.display = 'flex';

            // Fetch balance
            derivWS.send(JSON.stringify({ balance:1, subscribe:1 }));

            // Subscribe digit feed for hub market
            subscribeMarketTicks(currentHubMarket);

            // Update account info bar
            updateInfoBar();
        };

        derivWS.onerror = () => updateConnectionStatus(false);
        derivWS.onclose = () => updateConnectionStatus(false);
        derivWS.onmessage = (msg) => {
            try { routeMessage(JSON.parse(msg.data)); } catch(e) {}
        };

    } catch(err) {
        showStatus("Failed to open connection.", 'error');
        console.error(err);
    }
}

// Auto-reconnect
setInterval(async () => {
    if (derivWS && derivWS.readyState === WebSocket.OPEN) {
        isReconnecting = false;
    } else if (!isReconnecting && accessToken && accountId) {
        isReconnecting = true;
        updateConnectionStatus(false);
        await openAuthenticatedWS();
    }
}, 5000);

// ================================================================
// MESSAGE ROUTER
// ================================================================
function routeMessage(r) {
    // Balance
    if (r.msg_type === 'balance' && r.balance) {
        const el = document.getElementById('account-balance');
        if (el) el.textContent = `${parseFloat(r.balance.balance).toFixed(2)} ${r.balance.currency}`;
    }

    // Tick — process digit data from REAL market ticks only
    if (r.msg_type === 'tick' && r.tick) {
        const sym = r.tick.symbol;
        const q   = r.tick.quote;
        processRealTick(sym, q);
    }

    // History — bulk load from tick_history
    if (r.msg_type === 'history' && r.history) {
        processTickHistory(r.echo_req?.ticks_history || r.history?.id, r.history);
    }

    // Contract settled
    if (r.msg_type === 'proposal_open_contract') {
        const c = r.proposal_open_contract;
        if (c?.is_sold) updateDashboardAfterTrade(c.profit, c.status);
    }

    // Bot message handling
    handleBotMessage(r);
}

// ================================================================
// REAL TICK PROCESSING — no fake data ever
// ================================================================
function processRealTick(symbol, quote) {
    const digit = parseInt(quote.toString().slice(-1));
    if (isNaN(digit)) return;

    if (!digitData[symbol]) digitData[symbol] = { counts: new Array(10).fill(0), ticks: 0 };
    const d = digitData[symbol];
    d.counts[digit]++;
    d.ticks = Math.min(d.ticks + 1, 1000);

    // Consecutive tracking
    if (digit === lastDigitSeen) { consecutiveCount++; }
    else { consecutiveCount = 1; lastDigitSeen = digit; }

    // Update Hub if it's the active market
    if (symbol === currentHubMarket) {
        const lastEl  = document.getElementById('hub-last-digit');
        const tickEl  = document.getElementById('hub-tick-count');
        const consecEl = document.getElementById('hub-consec');
        if (lastEl)   lastEl.textContent   = digit;
        if (tickEl)   tickEl.textContent   = d.ticks;
        if (consecEl) consecEl.textContent = consecutiveCount;
        renderHubDigits(symbol);
        updateHubStatBadges(symbol);
        updateHubCurrentSignal(symbol);
    }
}

function processTickHistory(symbol, history) {
    if (!symbol || !history?.prices) return;
    if (!digitData[symbol]) digitData[symbol] = { counts: new Array(10).fill(0), ticks: 0 };
    const d = digitData[symbol];

    history.prices.forEach(price => {
        const digit = parseInt(price.toString().slice(-1));
        if (!isNaN(digit)) { d.counts[digit]++; d.ticks++; }
    });
    d.ticks = Math.min(d.ticks, 1000);

    logJournal(`📊 Loaded ${history.prices.length} ticks for ${symbol}`);
    if (symbol === currentHubMarket) {
        renderHubDigits(symbol);
        updateHubStatBadges(symbol);
        updateHubCurrentSignal(symbol);
    }
}

// Subscribe to real tick stream + fetch history
function subscribeMarketTicks(symbol) {
    if (!derivWS || derivWS.readyState !== WebSocket.OPEN) return;
    if (activeTickSubs.has(symbol)) return;

    // Fetch last 500 ticks as history first
    derivWS.send(JSON.stringify({
        ticks_history: symbol,
        adjust_start_time: 1,
        count: 500,
        end: "latest",
        style: "ticks",
        subscribe: 1
    }));

    activeTickSubs.add(symbol);
    logJournal(`📡 Subscribed: ${symbol}`);
}

// ================================================================
// HUB — Market select
// ================================================================
function onHubMarketChange(symbol) {
    currentHubMarket = symbol;
    consecutiveCount = 0;
    lastDigitSeen    = null;

    const lastEl = document.getElementById('hub-last-digit');
    if (lastEl) lastEl.textContent = '—';

    subscribeMarketTicks(symbol);

    if (digitData[symbol] && digitData[symbol].ticks > 0) {
        renderHubDigits(symbol);
        updateHubStatBadges(symbol);
        updateHubCurrentSignal(symbol);
    } else {
        const circles = document.getElementById('hub-digit-circles');
        if (circles) circles.innerHTML = '<div style="font-size:11px;color:#475569;padding:12px;">Loading tick data...</div>';
    }
}

// ================================================================
// HUB — Render digit circles (REAL data only)
// ================================================================
function renderHubDigits(symbol) {
    const circlesEl = document.getElementById('hub-digit-circles');
    const barsEl    = document.getElementById('hub-digit-bars');
    if (!circlesEl) return;

    const data   = digitData[symbol] || { counts: new Array(10).fill(0), ticks: 0 };
    const counts = data.counts;
    const total  = data.ticks || 1;
    const pred   = parseInt(document.getElementById('bot-prediction')?.value ?? -1);

    // Rank digits by frequency
    const ranked = counts.map((c,d) => ({d,c})).sort((a,b) => b.c - a.c);

    circlesEl.innerHTML = '';
    if (barsEl) barsEl.innerHTML = '';

    counts.forEach((count, digit) => {
        const rank = ranked.findIndex(r => r.d === digit);
        // TRUE percentage from real data
        const pct  = ((count / total) * 100).toFixed(1);

        let cls = '';
        if (rank === 0) cls = 'rank-0';
        else if (rank === 1) cls = 'rank-1';
        else if (rank === 8) cls = 'rank-8';
        else if (rank === 9) cls = 'rank-9';

        const isActivePred = digit === pred;

        const circle = document.createElement('div');
        circle.className = `d-circle ${cls} ${isActivePred ? 'active-pred' : ''}`;
        circle.title     = `Digit ${digit}: appeared ${count} times (${pct}% of ${total} ticks)`;
        circle.onclick   = () => {
            const p = document.getElementById('bot-prediction');
            if (p) { p.value = digit; renderHubDigits(symbol); logJournal(`Prediction → ${digit}`); }
        };
        circle.innerHTML = `
            <span style="font-size:18px;font-weight:900;line-height:1;">${digit}</span>
            <span style="font-size:9px;opacity:.8;margin-top:1px;">${pct}%</span>
            <span style="font-size:8px;color:#64748b;">${count}</span>`;
        circlesEl.appendChild(circle);

        // Bar row
        if (barsEl) {
            const barColor = cls === 'rank-0' ? '#00C853' : cls === 'rank-9' ? '#ef4444' : '#3b82f6';
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:10px;';
            row.innerHTML = `
                <span style="width:14px;text-align:right;font-weight:900;color:#e2e8f0;">${digit}</span>
                <div style="flex:1;height:5px;background:#1e293b;border-radius:3px;">
                    <div class="dbar-fill" style="width:${pct}%;background:${barColor};"></div>
                </div>
                <span style="width:38px;text-align:right;font-family:monospace;color:#94a3b8;">${pct}%</span>
                <span style="width:30px;text-align:right;font-family:monospace;color:#475569;">${count}</span>`;
            barsEl.appendChild(row);
        }
    });

    // Update hot/cold
    const hotEl  = document.getElementById('hub-hot');
    const coldEl = document.getElementById('hub-cold');
    if (hotEl)  hotEl.textContent  = ranked[0]?.d ?? '—';
    if (coldEl) coldEl.textContent = ranked[9]?.d ?? '—';
}

function updateHubStatBadges(symbol) {
    const data   = digitData[symbol] || { counts: new Array(10).fill(0), ticks: 0 };
    const counts = data.counts;
    const total  = Math.max(data.ticks, 1);

    const evenCount  = counts.filter((_,i) => i%2===0).reduce((a,b)=>a+b,0);
    const oddCount   = total - evenCount;
    const overCount  = counts.slice(5).reduce((a,b)=>a+b,0); // digits 5-9
    const underCount = total - overCount;

    const pct = n => ((n/total)*100).toFixed(1);

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('hub-even-badge',  `Even ${pct(evenCount)}%`);
    set('hub-odd-badge',   `Odd ${pct(oddCount)}%`);
    set('hub-over-badge',  `Over ${pct(overCount)}%`);
    set('hub-under-badge', `Under ${pct(underCount)}%`);
}

// ================================================================
// HUB — Current market signal (REAL data driven)
// ================================================================
function updateHubCurrentSignal(symbol) {
    const el = document.getElementById('hub-current-signal');
    if (!el) return;

    const data   = digitData[symbol] || { counts: new Array(10).fill(0), ticks: 0 };
    const counts = data.counts;
    const total  = Math.max(data.ticks, 1);

    if (total < 50) {
        el.innerHTML = `<div style="font-size:11px;color:#64748b;">Collecting data... (${total}/50 ticks needed)</div>`;
        return;
    }

    const label   = MARKET_LABELS[symbol] || symbol;
    const ranked  = counts.map((c,d)=>({d,c})).sort((a,b)=>b.c-a.c);
    const evenPct = (counts.filter((_,i)=>i%2===0).reduce((a,b)=>a+b,0)/total*100);
    const overPct = (counts.slice(5).reduce((a,b)=>a+b,0)/total*100);

    let signal = '', color = '#64748b', confidence = 0, direction = '', type = '';

    if (evenPct > 55)        { signal='Strong Even Dominance'; color='#00C853'; confidence=Math.min(99,Math.round(evenPct)); direction='Even Only'; type='even_odd'; }
    else if (evenPct < 45)   { signal='Strong Odd Dominance';  color='#ef4444'; confidence=Math.min(99,Math.round(100-evenPct)); direction='Odd Only'; type='even_odd'; }
    else if (overPct > 55)   { signal='Over Bias Detected';    color='#3b82f6'; confidence=Math.min(99,Math.round(overPct)); direction='Over Only'; type='over_under'; }
    else if (overPct < 45)   { signal='Under Bias Detected';   color='#f59e0b'; confidence=Math.min(99,Math.round(100-overPct)); direction='Under Only'; type='over_under'; }
    else                     { signal='Neutral — No Strong Signal'; color='#64748b'; confidence=0; direction='—'; type='—'; }

    el.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
            <span style="font-size:12px;font-weight:900;color:#e2e8f0;">${label}</span>
            <span class="badge" style="background:${color}22;color:${color};border-color:${color}44;">${confidence > 0 ? confidence+'% Confidence' : 'Neutral'}</span>
        </div>
        <div style="font-size:14px;font-weight:900;color:${color};margin-bottom:6px;">${signal}</div>
        <div style="font-size:10px;color:#64748b;">Direction: <b style="color:#e2e8f0;">${direction}</b> | Type: <b style="color:#e2e8f0;">${type.replace(/_/g,' ')}</b></div>
        <div style="font-size:10px;color:#64748b;margin-top:4px;">Based on ${total} real ticks | Even ${evenPct.toFixed(1)}% | Over ${overPct.toFixed(1)}%</div>
        <div style="font-size:10px;color:#64748b;">Hot: <b style="color:#00C853;">${ranked[0]?.d}</b> | Cold: <b style="color:#ef4444;">${ranked[9]?.d}</b> | Consecutive same: <b style="color:#60a5fa;">${consecutiveCount}</b></div>`;

    // Fire notification if strong signal and not seen before
    if (confidence >= 60) {
        const key = `${symbol}-${signal}-${Math.floor(Date.now()/60000)}`; // once per minute
        if (!seenSignals.has(key)) {
            seenSignals.add(key);
            fireNotification(`🚨 ${label}`, `${signal}\nDirection: ${direction}\nConfidence: ${confidence}%`, confidence >= 75 ? 'strong' : 'medium');
            logHubSignal(label, signal, direction, confidence);
        }
    }
}

// ================================================================
// HUB — Scan ALL markets
// ================================================================
function runFullScan() {
    const container = document.getElementById('hub-scan-results');
    if (!container) return;

    // Subscribe to all markets for data
    MARKETS_ALL.forEach(sym => subscribeMarketTicks(sym));

    container.innerHTML = '';

    MARKETS_ALL.forEach(sym => {
        const data   = digitData[sym] || { counts: new Array(10).fill(0), ticks: 0 };
        const counts = data.counts;
        const total  = Math.max(data.ticks, 1);
        const label  = MARKET_LABELS[sym] || sym;
        const ranked = counts.map((c,d)=>({d,c})).sort((a,b)=>b.c-a.c);
        const evenPct = (counts.filter((_,i)=>i%2===0).reduce((a,b)=>a+b,0)/total*100);
        const overPct = (counts.slice(5).reduce((a,b)=>a+b,0)/total*100);

        let signal = 'Neutral', color = '#334155', cls = '', confidence = 0;

        if (data.ticks < 30) { signal = `Collecting... (${data.ticks} ticks)`; color = '#475569'; }
        else if (evenPct > 58)      { signal=`Even ${evenPct.toFixed(0)}%`; color='#00C853'; cls='strong'; confidence=Math.round(evenPct); }
        else if (evenPct < 42)      { signal=`Odd ${(100-evenPct).toFixed(0)}%`; color='#ef4444'; cls='strong'; confidence=Math.round(100-evenPct); }
        else if (overPct > 58)      { signal=`Over ${overPct.toFixed(0)}%`; color='#3b82f6'; cls='medium'; confidence=Math.round(overPct); }
        else if (overPct < 42)      { signal=`Under ${(100-overPct).toFixed(0)}%`; color='#f59e0b'; cls='medium'; confidence=Math.round(100-overPct); }
        else                         { signal='No clear signal'; color='#475569'; }

        const card = document.createElement('div');
        card.className = `signal-card ${cls}`;
        card.style.borderColor = color;
        card.style.cursor = 'pointer';
        card.onclick = () => {
            document.getElementById('hub-market-select').value = sym;
            onHubMarketChange(sym);
        };
        card.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;">
                <span style="font-size:11px;font-weight:900;color:#e2e8f0;">${label}</span>
                ${confidence > 0 ? `<span class="badge" style="background:${color}22;color:${color};border:1px solid ${color}44;">${confidence}%</span>` : ''}
            </div>
            <div style="font-size:13px;font-weight:900;margin-top:4px;color:${color};">${signal}</div>
            <div style="font-size:9px;color:#475569;margin-top:3px;">${data.ticks} ticks | Hot:${ranked[0]?.d??'—'} Cold:${ranked[9]?.d??'—'}</div>`;
        container.appendChild(card);
    });
}

function logHubSignal(market, signal, direction, confidence) {
    const log = document.getElementById('hub-signal-log');
    if (!log) return;
    const row = document.createElement('div');
    row.style.cssText = 'font-size:10px;padding:5px 8px;background:#0a0f1e;border-radius:5px;border:1px solid #1e293b;';
    row.innerHTML = `<span style="color:#64748b;">${new Date().toLocaleTimeString()}</span> <b style="color:#e2e8f0;">${market}</b> — <span style="color:#00C853;">${signal}</span> | ${direction} | ${confidence}%`;
    log.insertBefore(row, log.firstChild);
    if (log.children.length > 20) log.removeChild(log.lastChild);
}

// ================================================================
// NOTIFICATIONS
// ================================================================
function fireNotification(title, body, type = 'info') {
    const container = document.getElementById('notification-container');
    if (!container) return;

    const notif = document.createElement('div');
    notif.className = `notif ${type === 'error' ? 'error' : type === 'warning' ? 'warning' : ''}`;

    const colorMap = { strong:'#00C853', medium:'#3b82f6', info:'#64748b', error:'#ef4444', warning:'#f59e0b' };
    const color = colorMap[type] || '#64748b';

    notif.innerHTML = `
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
            <div>
                <div style="font-size:12px;font-weight:900;color:${color};margin-bottom:3px;">${title}</div>
                <div style="font-size:10px;color:#94a3b8;white-space:pre-line;">${body}</div>
            </div>
            <button onclick="this.parentElement.parentElement.remove()" style="background:none;border:none;color:#475569;cursor:pointer;font-size:14px;flex-shrink:0;">✕</button>
        </div>`;

    container.appendChild(notif);
    setTimeout(() => { try { notif.remove(); } catch(e){} }, 8000);
}

// ================================================================
// DIRECTION CONTROLS
// ================================================================
function onTradeTypeChange() {
    const type = document.getElementById('bot-trade-type')?.value;
    const wrap = document.getElementById('direction-controls');
    const pred = document.getElementById('prediction-wrap');
    const accu = document.getElementById('accu-panel');
    if (!wrap) return;

    wrap.innerHTML = '';
    if (accu) accu.style.display = 'none';
    if (pred) pred.style.display = 'block';

    const dirMap = {
        over_under:     [['over','Over Only'],['under','Under Only']],
        even_odd:       [['even','Even Only'],['odd','Odd Only']],
        rise_fall:      [['rise','Rise Only'],['fall','Fall Only']],
        only_ups_downs: [['ups','Only Ups'],['downs','Only Downs']],
        high_low_ticks: [['high','High Ticks'],['low','Low Ticks']],
        accumulator:    []
    };

    if (type === 'accumulator') {
        if (accu) accu.style.display = 'block';
        if (pred) pred.style.display = 'none';
        botDirection = 'accumulator';
        updateInfoBar();
        return;
    }

    const opts = dirMap[type] || [];
    opts.forEach(([val, label]) => {
        const btn = document.createElement('button');
        btn.className = 'dir-btn';
        btn.textContent = label;
        btn.dataset.dir = val;
        btn.onclick = () => selectDirection(val);
        wrap.appendChild(btn);
    });

    if (!['over_under','even_odd'].includes(type)) {
        if (pred) pred.style.display = 'none';
    }

    if (opts.length > 0) selectDirection(opts[0][0]);
    updateInfoBar();
}

function selectDirection(dir) {
    botDirection = dir;
    document.querySelectorAll('#direction-controls .dir-btn').forEach(b => {
        b.classList.remove('sel-green','sel-red');
        if (b.dataset.dir === dir) {
            const isNeg = ['under','odd','fall','downs','low'].includes(dir);
            b.classList.add(isNeg ? 'sel-red' : 'sel-green');
        }
    });
    updateInfoBar();
}

function onBuilderChange() {
    const sym    = document.getElementById('bot-market')?.value || 'R_10';
    const iframe = document.getElementById('deriv-chart-frame');
    const ticker = document.getElementById('chart-asset-ticker');
    if (iframe) iframe.src = `https://charts.deriv.com/?symbol=${sym}&granularity=60`;
    if (ticker) ticker.textContent = sym;
    updateInfoBar();
}

function updateInfoBar() {
    const market = document.getElementById('bot-market')?.value || '—';
    const type   = document.getElementById('bot-trade-type')?.value || '—';
    const acc    = allAccounts.find(a => a.account_id === accountId);
    const accLabel = acc ? `${acc.account_type === 'demo' ? 'Demo' : 'Real'}` : '—';

    const set = (id, val, color) => {
        const el = document.getElementById(id);
        if (el) { el.textContent = val; if (color) el.style.color = color; }
    };
    set('info-market',    market);
    set('info-type',      type.replace(/_/g,' '));
    set('info-direction', botDirection?.toUpperCase() || '—',
        ['under','odd','fall','downs'].includes(botDirection) ? '#ef4444' : '#00C853');
    set('info-account',   accLabel);
}

// ================================================================
// BOT REPOSITORY
// ================================================================
function renderBotRepository() {
    const container = document.getElementById('bot-repository');
    if (!container) return;

    if (botRepository.length === 0) {
        container.innerHTML = '<div style="font-size:12px;color:#475569;text-align:center;padding:30px;">No bots. Create one or import XML.</div>';
        return;
    }

    container.innerHTML = '';
    botRepository.forEach(bot => {
        const isLoaded  = bot.id === activeBotId;
        const isRunning = isLoaded && isBotRunning;

        const card = document.createElement('div');
        card.className = `bot-card ${isLoaded ? 'is-loaded' : ''} ${isRunning ? 'is-running' : ''}`;
        card.innerHTML = `
            <div style="flex:1;min-width:0;">
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
                    <span style="font-size:13px;font-weight:900;color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${bot.name}</span>
                    ${isLoaded  ? '<span class="badge badge-green">LOADED</span>' : ''}
                    ${isRunning ? '<span class="badge badge-amber">RUNNING</span>' : ''}
                </div>
                <div style="font-size:10px;color:#64748b;">${MARKET_LABELS[bot.market]||bot.market} · ${bot.type.replace(/_/g,' ')} · ${bot.direction?.toUpperCase()||''} · $${bot.stake} stake</div>
            </div>
            <div style="display:flex;gap:5px;flex-shrink:0;">
                <button onclick="loadBotIntoBuilder(${bot.id})" class="btn btn-green" style="font-size:10px;padding:4px 10px;">Load</button>
                <button onclick="duplicateBot(${bot.id})" class="btn btn-ghost" style="font-size:10px;padding:4px 8px;">Copy</button>
                <button onclick="exportBot(${bot.id})" class="btn btn-ghost" style="font-size:10px;padding:4px 8px;">Export</button>
                <button onclick="deleteBot(${bot.id})" class="btn btn-ghost" style="font-size:10px;padding:4px 8px;color:#ef4444;">✕</button>
            </div>`;
        container.appendChild(card);
    });
}

function loadBotIntoBuilder(id) {
    const bot = botRepository.find(b => b.id === id);
    if (!bot) return;
    activeBotId   = id;
    activeBotName = bot.name;

    const set = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val; };
    set('bot-market',     bot.market);
    set('bot-trade-type', bot.type);
    set('bot-stake',      bot.stake);
    set('bot-martingale', bot.martingale);
    set('bot-tp',         bot.tp);
    set('bot-sl',         bot.sl);
    set('bot-duration',   bot.ticks || 1);
    if (bot.prediction !== undefined) set('bot-prediction', bot.prediction);

    onTradeTypeChange();
    if (bot.direction) selectDirection(bot.direction);

    const nameEl = document.getElementById('builder-bot-name');
    if (nameEl) nameEl.textContent = bot.name;

    onBuilderChange();
    updateBotBar();
    renderBotRepository();
    logJournal(`📋 Loaded: ${bot.name}`);
    switchTab('bot-builder');
}

function saveBotConfig() {
    if (!activeBotId) { alert("Load a bot first."); return; }
    const bot = botRepository.find(b => b.id === activeBotId);
    if (!bot) return;

    bot.market     = document.getElementById('bot-market')?.value       || bot.market;
    bot.type       = document.getElementById('bot-trade-type')?.value   || bot.type;
    bot.stake      = parseFloat(document.getElementById('bot-stake')?.value      || bot.stake);
    bot.martingale = parseFloat(document.getElementById('bot-martingale')?.value || bot.martingale);
    bot.tp         = parseFloat(document.getElementById('bot-tp')?.value         || bot.tp);
    bot.sl         = parseFloat(document.getElementById('bot-sl')?.value         || bot.sl);
    bot.ticks      = parseInt(document.getElementById('bot-duration')?.value     || bot.ticks);
    bot.direction  = botDirection || bot.direction;
    bot.prediction = parseInt(document.getElementById('bot-prediction')?.value   || 0);

    renderBotRepository();
    logJournal(`💾 Saved: ${bot.name}`);
    fireNotification('Bot Saved', `${bot.name} configuration updated.`, 'info');
}

function createNewBot() {
    const name = prompt("Bot name:", `My Bot ${botRepository.length + 1}`);
    if (!name) return;
    const nb = { id:Date.now(), name, type:"over_under", market:"R_10", stake:1, martingale:2.1, tp:50, sl:100, direction:"over", ticks:1, prediction:1 };
    botRepository.push(nb);
    renderBotRepository();
    loadBotIntoBuilder(nb.id);
}

function duplicateBot(id) {
    const bot = botRepository.find(b => b.id === id);
    if (!bot) return;
    const copy = { ...bot, id:Date.now(), name:bot.name+' (Copy)' };
    botRepository.push(copy);
    renderBotRepository();
}

function exportBot(id) {
    const bot = botRepository.find(b => b.id === id);
    if (!bot) return;
    // Export as XML
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<btraderhub-bot>
  <name>${bot.name}</name>
  <market>${bot.market}</market>
  <type>${bot.type}</type>
  <direction>${bot.direction}</direction>
  <stake>${bot.stake}</stake>
  <martingale>${bot.martingale}</martingale>
  <take_profit>${bot.tp}</take_profit>
  <stop_loss>${bot.sl}</stop_loss>
  <ticks>${bot.ticks}</ticks>
  <prediction>${bot.prediction||0}</prediction>
</btraderhub-bot>`;
    const blob = new Blob([xml], { type:'application/xml' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = `${bot.name.replace(/\s+/g,'_')}.xml`;
    a.click();
}

function deleteBot(id) {
    if (!confirm("Delete this bot?")) return;
    botRepository = botRepository.filter(b => b.id !== id);
    if (activeBotId === id) { activeBotId = null; activeBotName = "None"; }
    renderBotRepository();
}

function importBot(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        const text = e.target.result.trim();
        try {
            let bot;
            if (text.startsWith('<')) {
                // XML parsing
                const parser = new DOMParser();
                const doc = parser.parseFromString(text, 'application/xml');
                const parseErr = doc.querySelector('parsererror');
                if (parseErr) throw new Error('Invalid XML structure');

                const get = tag => doc.querySelector(tag)?.textContent?.trim() || '';
                bot = {
                    id:         Date.now(),
                    name:       get('name')        || 'Imported Bot',
                    market:     get('market')      || 'R_10',
                    type:       get('type')        || 'over_under',
                    direction:  get('direction')   || 'over',
                    stake:      parseFloat(get('stake'))        || 1,
                    martingale: parseFloat(get('martingale'))   || 2.1,
                    tp:         parseFloat(get('take_profit'))  || 50,
                    sl:         parseFloat(get('stop_loss'))    || 100,
                    ticks:      parseInt(get('ticks'))          || 1,
                    prediction: parseInt(get('prediction'))     || 0
                };
            } else {
                // JSON fallback
                bot = JSON.parse(text);
                bot.id = Date.now();
            }

            // Validate required fields
            if (!bot.name || !bot.market || !bot.type || !bot.direction) {
                throw new Error('Missing required fields: name, market, type, direction');
            }

            botRepository.push(bot);
            renderBotRepository();
            logJournal(`📥 Imported: ${bot.name}`);
            fireNotification('Bot Imported', `${bot.name} added to repository.`, 'info');
        } catch(err) {
            alert(`Import failed: ${err.message}`);
            logJournal(`❌ Import error: ${err.message}`);
        }
    };
    reader.readAsText(file);
    event.target.value = '';
}

// ================================================================
// BOT EXECUTION
// ================================================================
function toggleBotExecution() {
    if (!derivWS || derivWS.readyState !== WebSocket.OPEN) {
        fireNotification('Not Connected', 'Please log in to your Deriv account first.', 'error');
        return;
    }
    if (!activeBotId) {
        fireNotification('No Bot Loaded', 'Go to Trading Bots tab and load a bot first.', 'warning');
        switchTab('trading-bots');
        return;
    }
    if (!botDirection) {
        fireNotification('No Direction Set', 'Select a trade direction in Bot Builder.', 'warning');
        return;
    }

    const btn = document.getElementById('global-run-btn');

    if (!isBotRunning) {
        isBotRunning   = true;
        const bot      = botRepository.find(b => b.id === activeBotId);
        currentStake   = bot?.stake || parseFloat(document.getElementById('bot-stake')?.value || 1);
        botDirection   = bot?.direction || botDirection;

        if (btn) { btn.textContent='🛑 STOP BOT'; btn.className='btn btn-red'; btn.style.cssText='font-size:13px;font-weight:900;padding:8px 24px;border-radius:8px;letter-spacing:.03em;'; }

        const market = document.getElementById('bot-market')?.value || 'R_10';
        logJournal(`🟢 Bot: ${activeBotName} | ${market} | ${botDirection?.toUpperCase()}`);
        derivWS.send(JSON.stringify({ ticks: market, subscribe: 1 }));
        renderBotRepository();
    } else {
        isBotRunning = false;
        if (btn) { btn.textContent='▶ RUN BOT'; btn.className='btn btn-green'; btn.style.cssText='font-size:13px;font-weight:900;padding:8px 24px;border-radius:8px;letter-spacing:.03em;'; }
        logJournal("🔴 Bot stopped.");
        renderBotRepository();
    }
    updateBotBar();
}

function handleBotMessage(r) {
    if (!isBotRunning) return;

    if (r.msg_type === 'tick' && r.tick) {
        if (lastContractId !== null) return;
        const price     = r.tick.quote.toString();
        const digit     = parseInt(price.slice(-1));
        const type      = document.getElementById('bot-trade-type')?.value || 'over_under';
        const pred      = parseInt(document.getElementById('bot-prediction')?.value || 1);

        let shouldTrade = false;
        switch(type) {
            case 'over_under':
                if (botDirection==='over'  && digit > pred) shouldTrade = true;
                if (botDirection==='under' && digit < pred) shouldTrade = true;
                break;
            case 'even_odd':
                if (botDirection==='even' && digit%2===0) shouldTrade = true;
                if (botDirection==='odd'  && digit%2!==0) shouldTrade = true;
                break;
            case 'rise_fall':
            case 'only_ups_downs':
            case 'high_low_ticks':
            case 'accumulator':
                shouldTrade = true;
                break;
        }
        if (shouldTrade) executeContract();
    }

    if (r.msg_type === 'buy') {
        if (r.error) {
            const market = document.getElementById('bot-market')?.value || '?';
            const type   = document.getElementById('bot-trade-type')?.value || '?';
            logJournal(`❌ Trade rejected:`);
            logJournal(`   Reason: ${r.error.message}`);
            logJournal(`   Market: ${market} | Type: ${type} | Direction: ${botDirection}`);
            logJournal(`   Fix: Check contract type mapping for ${type}`);
            lastContractId = null;
        } else {
            lastContractId = r.buy.contract_id;
            totalRuns++;
            logJournal(`📋 #${lastContractId} | ${document.getElementById('bot-market')?.value} | ${botDirection?.toUpperCase()}`);
            updateStatsDashboard();
        }
    }

    if (r.msg_type === 'proposal_open_contract' && r.proposal_open_contract) {
        const c = r.proposal_open_contract;
        if (c.is_expired && c.contract_id === lastContractId) {
            const profit = parseFloat(c.profit);
            lastContractId = null;

            if (profit > 0) {
                try { winAudio.play(); } catch(e) {}
                totalWins++;
                currentStreak   = currentStreak < 0 ? 1 : currentStreak + 1;
                totalProfitLoss += profit;
                logJournal(`🎯 WIN +$${profit.toFixed(2)}`);
                addTransactionRow('WIN', currentStake, profit);
                const bot = botRepository.find(b => b.id === activeBotId);
                currentStake = bot?.stake || parseFloat(document.getElementById('bot-stake')?.value || currentStake);
            } else {
                try { lossAudio.play(); } catch(e) {}
                currentStreak   = currentStreak > 0 ? -1 : currentStreak - 1;
                totalProfitLoss += profit;
                logJournal(`💥 LOSS $${profit.toFixed(2)}`);
                addTransactionRow('LOSS', currentStake, profit);
                const mult = parseFloat(document.getElementById('bot-martingale')?.value || 2.1);
                currentStake *= mult;
                logJournal(`📐 Next stake: $${currentStake.toFixed(2)}`);
            }
            updateStatsDashboard();
            checkThresholds();
        }
    }
}

// ================================================================
// EXECUTE CONTRACT — with full validation
// ================================================================
function executeContract() {
    if (!isBotRunning || lastContractId !== null) return;

    const market    = document.getElementById('bot-market')?.value || 'R_10';
    const duration  = parseInt(document.getElementById('bot-duration')?.value || 1);
    const tradeType = document.getElementById('bot-trade-type')?.value || 'over_under';
    const pred      = parseInt(document.getElementById('bot-prediction')?.value || 1);

    // Validate parameters
    const errors = [];
    if (!market)     errors.push('Market symbol missing');
    if (!botDirection) errors.push('Direction not set');
    if (currentStake < 0.35) errors.push(`Stake too low: $${currentStake.toFixed(2)} (min $0.35)`);

    if (errors.length > 0) {
        errors.forEach(e => logJournal(`❌ Validation: ${e}`));
        return;
    }

    // Map to Deriv contract type
    const typeMap = CONTRACT_TYPES[tradeType];
    if (!typeMap) { logJournal(`❌ Unknown trade type: ${tradeType}`); return; }

    const contractType = typeMap[botDirection];
    if (!contractType) { logJournal(`❌ Invalid direction "${botDirection}" for type "${tradeType}"`); return; }

    // Build order
    const order = {
        buy: 1,
        price: currentStake,
        parameters: {
            amount:        currentStake,
            basis:         "stake",
            contract_type: contractType,
            currency:      "USD",
            symbol:        market
        }
    };

    // Duration — not used for accumulator
    if (tradeType !== 'accumulator') {
        order.parameters.duration      = duration;
        order.parameters.duration_unit = "t";
    }

    // Barrier — for over/under
    if (tradeType === 'over_under') {
        order.parameters.barrier = pred.toString();
    }

    // Accumulator extras
    if (tradeType === 'accumulator') {
        const gr = parseFloat(document.getElementById('bot-growth-rate')?.value || 0.03);
        order.parameters.growth_rate = gr;
        const tp = parseFloat(document.getElementById('bot-tp')?.value || 0);
        if (tp > 0) order.parameters.limit_order = { take_profit: tp };
    }

    replicateOrderToSlaves(order.parameters);
    lastContractId = "pending";
    derivWS.send(JSON.stringify(order));
    logJournal(`🎯 ${contractType} @ $${currentStake.toFixed(2)} | ${market} | ${botDirection.toUpperCase()}`);
}

// ================================================================
// CHARTS
// ================================================================
function loadDerivChart(sym) {
    const f = document.getElementById('deriv-standalone-frame');
    if (f) f.src = `https://charts.deriv.com/?symbol=${sym}&granularity=60`;
}

let tvInitialized = false;
function initTVChart(symbol) {
    const container = document.getElementById('tv-chart-container');
    if (!container) return;
    container.innerHTML = '';
    tvInitialized = false;

    const opts = {
        autosize: true,
        symbol, interval:"5",
        timezone:"Etc/UTC", theme:"dark", style:"1", locale:"en",
        enable_publishing:false, allow_symbol_change:true,
        container_id:"tv-chart-container",
        studies:["RSI@tv-basicstudies","MACD@tv-basicstudies"]
    };
    const build = () => {
        if (typeof TradingView !== 'undefined' && !tvInitialized) {
            tvInitialized = true;
            new TradingView.widget(opts);
        }
    };
    if (typeof TradingView !== 'undefined') { build(); }
    else {
        const s = document.createElement('script');
        s.src = 'https://s3.tradingview.com/tv.js';
        s.async = true; s.onload = build;
        document.head.appendChild(s);
    }
}

// ================================================================
// STATS & TRANSACTIONS
// ================================================================
function addTransactionRow(type, stake, profit) {
    const container = document.getElementById('transaction-rows-container');
    const empty     = document.getElementById('empty-rows-msg');
    if (!container) return;
    if (empty) empty.style.display = 'none';

    const isWin = type === 'WIN';
    const c1    = isWin ? '#00C85318' : '#ef444418';
    const c2    = isWin ? '#00C85344' : '#ef444444';
    const c3    = isWin ? '#00C853'   : '#ef4444';

    const row = document.createElement('div');
    row.style.cssText = `display:flex;align-items:center;justify-content:space-between;padding:5px 7px;border-radius:5px;font-size:10px;font-weight:600;background:${c1};border:1px solid ${c2};margin-bottom:3px;`;
    row.innerHTML = `
        <div style="display:flex;align-items:center;gap:5px;">
            <span>${isWin?'🎯':'💥'}</span>
            <div>
                <div style="color:${c3};font-weight:900;">${type}</div>
                <div style="color:#475569;font-family:monospace;">$${stake.toFixed(2)}</div>
            </div>
        </div>
        <div style="font-family:monospace;font-weight:900;color:${c3};">${isWin?'+':''}$${profit.toFixed(2)}</div>`;
    container.insertBefore(row, container.firstChild);

    // Mirror to dashboard
    const recentList = document.getElementById('recent-trades-list');
    if (recentList) {
        if (recentList.querySelector('div[style*="text-align:center"]')) recentList.innerHTML = '';
        const r2 = row.cloneNode(true);
        recentList.insertBefore(r2, recentList.firstChild);
        if (recentList.children.length > 6) recentList.removeChild(recentList.lastChild);
    }
}

function updateStatsDashboard() {
    const $ = id => document.getElementById(id);
    const wr = totalRuns > 0 ? ((totalWins/totalRuns)*100).toFixed(1) : "0.0";

    if ($('stat-runs'))  $('stat-runs').textContent  = totalRuns;
    if ($('stat-stake')) $('stat-stake').textContent = currentStake.toFixed(2);
    if (currentStake > peakExposure) {
        peakExposure = currentStake;
        if ($('stat-peak-exposure')) $('stat-peak-exposure').textContent = peakExposure.toFixed(2);
    }
    if ($('stat-win-rate')) $('stat-win-rate').textContent = `${wr}%`;
    if ($('stat-current-streak')) {
        $('stat-current-streak').textContent = currentStreak > 0 ? `+${currentStreak}` : `${currentStreak}`;
        $('stat-current-streak').style.color = currentStreak > 0 ? '#00C853' : currentStreak < 0 ? '#ef4444' : '#e2e8f0';
    }
    if ($('stat-profit')) {
        $('stat-profit').textContent = totalProfitLoss.toFixed(2);
        $('stat-profit').style.color = totalProfitLoss > 0 ? '#00C853' : totalProfitLoss < 0 ? '#ef4444' : '#e2e8f0';
    }

    // Dashboard stats
    if ($('dash-runs')) $('dash-runs').textContent = totalRuns;
    if ($('dash-wr'))   { $('dash-wr').textContent = `${wr}%`; }
    if ($('dash-pl'))   { $('dash-pl').textContent = `$${totalProfitLoss.toFixed(2)}`; $('dash-pl').style.color = totalProfitLoss >= 0 ? '#00C853' : '#ef4444'; }
    if ($('dash-bot'))  $('dash-bot').textContent = activeBotName;

    updateBotBar();
}

function updateBotBar() {
    const $ = id => document.getElementById(id);
    const wr = totalRuns > 0 ? ((totalWins/totalRuns)*100).toFixed(1) : "0.0";
    if ($('bar-runs'))     $('bar-runs').textContent     = totalRuns;
    if ($('bar-pl'))       { $('bar-pl').textContent = `$${totalProfitLoss.toFixed(2)}`; $('bar-pl').style.color = totalProfitLoss >= 0 ? '#00C853' : '#ef4444'; }
    if ($('bar-wr'))       $('bar-wr').textContent       = `${wr}%`;
    if ($('bar-bot-name')) $('bar-bot-name').textContent = activeBotName;
}

function checkThresholds() {
    const tp = parseFloat(document.getElementById('bot-tp')?.value || 0);
    const sl = parseFloat(document.getElementById('bot-sl')?.value || 0) * -1;
    if (tp > 0 && totalProfitLoss >= tp) {
        logJournal(`🏆 Take profit $${tp} hit!`);
        fireNotification('Take Profit Hit! 🏆', `Profit of $${tp} reached. Bot stopped.`, 'strong');
        toggleBotExecution();
    } else if (sl < 0 && totalProfitLoss <= sl) {
        logJournal(`⚠️ Stop loss $${Math.abs(sl)} hit!`);
        fireNotification('Stop Loss Hit ⚠️', `Loss of $${Math.abs(sl)} reached. Bot stopped.`, 'error');
        toggleBotExecution();
    }
}

function updateDashboardAfterTrade(profit, status) {
    // Already handled in handleBotMessage
}

// ================================================================
// COPY TRADING
// ================================================================
function addNewSlave() {
    const tokenEl = document.getElementById('slave-token-input');
    const multEl  = document.getElementById('slave-multiplier-input');
    if (!tokenEl?.value) return alert("Enter a valid token");
    const slave = { id:Date.now(), token:tokenEl.value, multiplier:parseFloat(multEl?.value||1),
        ws:new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${DERIV_APP_ID}`) };
    slave.ws.onopen = () => slave.ws.send(JSON.stringify({ authorize: slave.token }));
    slaveAccounts.push(slave);
    tokenEl.value = '';
    renderSlaveList();
    logJournal(`👥 Slave added (x${slave.multiplier})`);
}

function renderSlaveList() {
    const c = document.getElementById('slave-list-container');
    if (!c) return;
    if (slaveAccounts.length === 0) { c.innerHTML = '<p style="font-size:11px;color:#475569;text-align:center;padding:16px;">No slave accounts.</p>'; return; }
    c.innerHTML = '';
    slaveAccounts.forEach(s => {
        const div = document.createElement('div');
        div.className = 'bot-card';
        div.innerHTML = `<div><div style="font-size:13px;font-weight:900;color:#e2e8f0;">Slave #${s.id}</div><div style="font-size:10px;color:#64748b;">Multiplier: ×${s.multiplier}</div></div>
            <button onclick="removeSlave(${s.id})" class="btn btn-ghost" style="font-size:10px;padding:4px 10px;color:#ef4444;">Remove</button>`;
        c.appendChild(div);
    });
}

function removeSlave(id) {
    const s = slaveAccounts.find(x => x.id === id);
    if (s?.ws) s.ws.close();
    slaveAccounts = slaveAccounts.filter(x => x.id !== id);
    renderSlaveList();
}

function replicateOrderToSlaves(params) {
    slaveAccounts.forEach(s => {
        if (s.ws?.readyState === WebSocket.OPEN) {
            s.ws.send(JSON.stringify({ buy:1, parameters:{...params, amount:params.amount*s.multiplier} }));
        }
    });
}

// ================================================================
// UI HELPERS
// ================================================================
function showStatus(msg, type) {
    const el = document.getElementById('connection-status');
    if (!el) return;
    const colors = { info:'#3b82f6', success:'#00C853', error:'#ef4444' };
    const c = colors[type] || '#64748b';
    el.style.cssText = `display:block;border-color:${c};color:${c};background:${c}18;font-size:11px;padding:10px;border-radius:8px;border:1px solid;margin-top:12px;`;
    el.textContent = msg;
}

function updateConnectionStatus(on) {
    const pairs = [
        [document.getElementById('status-dot'),    document.getElementById('status-text')],
        [document.getElementById('bar-status-dot'), document.getElementById('bar-status-text')]
    ];
    pairs.forEach(([dot, text]) => {
        if (dot)  { dot.style.background = on ? '#00C853' : '#ef4444'; }
        if (text) { text.textContent = on ? 'LIVE' : 'OFFLINE'; text.style.color = on ? '#00C853' : '#ef4444'; }
    });
}

function logJournal(text) {
    const t = document.getElementById('journal-terminal-log');
    if (!t) return;
    const div = document.createElement('div');
    div.style.cssText = 'font-size:10px;color:#4ade80;padding:1px 0;';
    div.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
    t.appendChild(div);
    t.scrollTop = t.scrollHeight;
    if (t.children.length > 300) t.removeChild(t.firstChild);
}