// Crypto Strategy AI - Auto Trading Client
const API_URL = '';

const presetBtn = document.getElementById('analyzeBtn');
const tbody = document.getElementById('tbody');
const comments = document.getElementById('comments');
const loader = document.getElementById('loader');
const results = document.getElementById('results');

const balanceEl = document.getElementById('balance');
const balanceWidget = document.getElementById('balanceWidget');
const balanceUnitEl = balanceWidget ? balanceWidget.querySelector('.unit') : null;
const bybitToggle = document.getElementById('bybitEnabled');
const bybitConfig = document.getElementById('bybitConfig');
const bybitWorkerUrlInput = document.getElementById('bybitWorkerUrl');
const bybitConfigStatus = document.getElementById('bybitConfigStatus');

const BYBIT_PREF_KEY = 'bybitIntegrationEnabled';
const BYBIT_WORKER_URL_KEY = 'bybitWorkerUrl';
const SELECTED_PAIRS_KEY = 'selectedPairs';

// All Bybit USDT-perp pairs the backend has decimal/tick-size data for
// (see `PRICE_DECIMALS` in api/_bybit.js). Keep this in sync if you add new
// supported pairs server-side.
const ALL_PAIRS = [
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT',
    'ADAUSDT', 'DOGEUSDT', 'DOTUSDT', 'AVAXUSDT',
    'LTCUSDT', 'LINKUSDT', 'MATICUSDT'
];

// Empty set means "use all pairs" (backend default). Persisted in localStorage.
function getSelectedPairs() {
    try {
        const raw = localStorage.getItem(SELECTED_PAIRS_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return [];
        return arr.filter(p => typeof p === 'string' && ALL_PAIRS.includes(p));
    } catch (_) { return []; }
}
function setSelectedPairs(pairs) {
    const clean = (pairs || []).filter(p => ALL_PAIRS.includes(p));
    if (clean.length === 0 || clean.length === ALL_PAIRS.length) {
        localStorage.removeItem(SELECTED_PAIRS_KEY);
    } else {
        localStorage.setItem(SELECTED_PAIRS_KEY, JSON.stringify(clean));
    }
    updatePairSelectorCount();
}
function activeSymbols() {
    const sel = getSelectedPairs();
    return sel.length ? sel : ALL_PAIRS.slice();
}
function updatePairSelectorCount() {
    const countEl = document.getElementById('pairSelectorCount');
    if (!countEl) return;
    const sel = getSelectedPairs();
    if (sel.length === 0) {
        countEl.textContent = `все ${ALL_PAIRS.length}`;
    } else {
        countEl.textContent = `${sel.length} из ${ALL_PAIRS.length}`;
    }
}
function renderPairSelector() {
    const body = document.getElementById('pairSelectorBody');
    if (!body) return;
    body.innerHTML = '';

    const controls = document.createElement('div');
    controls.className = 'pair-selector-controls';
    controls.innerHTML = `
        <button type="button" class="pair-bulk" data-action="all">Все ${ALL_PAIRS.length}</button>
        <button type="button" class="pair-bulk" data-action="majors">Только майоры</button>
    `;
    body.appendChild(controls);

    const grid = document.createElement('div');
    grid.className = 'pair-chips';
    body.appendChild(grid);

    const sel = new Set(activeSymbols());
    ALL_PAIRS.forEach(p => {
        const id = `pair-${p}`;
        const wrap = document.createElement('label');
        wrap.className = 'pair-chip';
        wrap.htmlFor = id;
        wrap.innerHTML = `
            <input type="checkbox" id="${id}" value="${p}" ${sel.has(p) ? 'checked' : ''}>
            <span>${p.replace(/USDT$/, '')}</span>
        `;
        grid.appendChild(wrap);
    });

    grid.addEventListener('change', () => {
        const checked = [...grid.querySelectorAll('input[type="checkbox"]:checked')].map(i => i.value);
        if (checked.length === 0) {
            // Don't allow zero selection — fall back to default (= all).
            setSelectedPairs([]);
        } else {
            setSelectedPairs(checked);
        }
    });

    controls.addEventListener('click', (e) => {
        const action = e.target?.dataset?.action;
        if (action === 'all') {
            setSelectedPairs([]);
            renderPairSelector();
        } else if (action === 'majors') {
            setSelectedPairs(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
            renderPairSelector();
        }
    });

    updatePairSelectorCount();
}

function isBybitEnabled() {
    return localStorage.getItem(BYBIT_PREF_KEY) === '1';
}
function getBybitWorkerUrl() {
    const raw = (localStorage.getItem(BYBIT_WORKER_URL_KEY) || '').trim().replace(/\/+$/, '');
    if (!raw) return '';
    try {
        const u = new URL(raw);
        return u.protocol === 'https:' ? u.origin : '';
    } catch (_) { return ''; }
}
function bybitFetchOptions(extra = {}) {
    const url = getBybitWorkerUrl();
    const headers = { ...(extra.headers || {}) };
    if (url) headers['X-Worker-Url'] = url;
    return { ...extra, headers };
}
function setBybitStatus(text, kind) {
    if (!bybitConfigStatus) return;
    bybitConfigStatus.textContent = text || '';
    bybitConfigStatus.dataset.kind = kind || '';
}
// Collapse the proxy URL panel into a small "connected" chip when the proxy
// is happy, expand it back when something goes wrong (or when user clicks the
// edit button). Single source of truth for the .is-connected class.
function setProxyConnected(connected) {
    if (!bybitConfig) return;
    bybitConfig.classList.toggle('is-connected', !!connected);
}

// Smoothly tween a numeric value displayed inside an element, then briefly
// flash it. Falls back to plain assignment when reduced-motion is preferred.
function animateNumber(el, target, opts = {}) {
    if (!el) return;
    const { duration = 700, decimals = 2, prefix = '', suffix = '' } = opts;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const fromText = (el.textContent || '').replace(/[^\d.\-]/g, '');
    const fromNum = parseFloat(fromText);
    const targetNum = Number(target);
    if (!isFinite(targetNum)) {
        el.textContent = prefix + String(target) + suffix;
        return;
    }
    if (reduce || !isFinite(fromNum)) {
        el.textContent = prefix + targetNum.toFixed(decimals) + suffix;
        flashValue(el);
        return;
    }
    const start = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    function tick(now) {
        const t = Math.min(1, (now - start) / duration);
        const v = fromNum + (targetNum - fromNum) * ease(t);
        el.textContent = prefix + v.toFixed(decimals) + suffix;
        if (t < 1) requestAnimationFrame(tick);
        else flashValue(el);
    }
    requestAnimationFrame(tick);
}

function flashValue(el) {
    if (!el || !el.classList) return;
    el.classList.remove('flash-update');
    void el.offsetWidth;
    el.classList.add('flash-update');
}
function applyBybitVisibility() {
    const on = isBybitEnabled();
    if (bybitToggle) bybitToggle.checked = on;
    if (balanceWidget) balanceWidget.style.display = on ? '' : 'none';
    if (bybitConfig) bybitConfig.style.display = on ? '' : 'none';
    const paBtn = document.getElementById('portfolioAnalyzeBtn');
    if (paBtn) paBtn.style.display = on ? '' : 'none';
    if (!on) {
        const paSection = document.getElementById('portfolioAnalysis');
        if (paSection) paSection.style.display = 'none';
    }
}
async function pingBybitWorker() {
    const url = getBybitWorkerUrl();
    if (!url) {
        setBybitStatus('URL не задан — балансы и анализ-портфеля не будут работать.', 'warn');
        setProxyConnected(false);
        return false;
    }
    setBybitStatus('Проверяю прокси…', '');
    try {
        const r = await fetch(`${url}/health`, { method: 'GET', mode: 'cors' });
        if (r.ok) {
            setBybitStatus('Прокси отвечает ✓', 'ok');
            setProxyConnected(true);
            // Refresh API-dependent UI (balance) so the user immediately sees
            // the proxy "come alive" without having to flip the toggle off
            // and back on.
            if (isBybitEnabled()) loadBalance();
            return true;
        }
        setBybitStatus(`Прокси вернул HTTP ${r.status}`, 'err');
        setProxyConnected(false);
        return false;
    } catch (e) {
        setBybitStatus(`Прокси недоступен: ${e.message}`, 'err');
        setProxyConnected(false);
        return false;
    }
}
if (bybitWorkerUrlInput) {
    bybitWorkerUrlInput.value = localStorage.getItem(BYBIT_WORKER_URL_KEY) || '';
    const save = () => {
        const raw = bybitWorkerUrlInput.value.trim().replace(/\/+$/, '');
        localStorage.setItem(BYBIT_WORKER_URL_KEY, raw);
        bybitWorkerUrlInput.value = raw;
        if (!raw) { setBybitStatus('', ''); return; }
        try {
            const u = new URL(raw);
            if (u.protocol !== 'https:') {
                setBybitStatus('Нужен https://-URL.', 'err');
                return;
            }
        } catch (_) {
            setBybitStatus('Невалидный URL.', 'err');
            return;
        }
        pingBybitWorker();
    };
    bybitWorkerUrlInput.addEventListener('change', save);
    bybitWorkerUrlInput.addEventListener('blur', save);
    bybitWorkerUrlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); bybitWorkerUrlInput.blur(); }
    });
}
// localStorage cleanup: previous releases stored an optional WORKER_AUTH_TOKEN
// override here. We no longer ship that UI, so wipe stale values to avoid the
// browser sending a header that the new proxy doesn't expect.
try { localStorage.removeItem('bybitWorkerToken'); } catch (_) {}
const bybitConfigEditBtn = document.getElementById('bybitConfigEdit');
if (bybitConfigEditBtn) {
    bybitConfigEditBtn.addEventListener('click', () => {
        setProxyConnected(false);
        if (bybitWorkerUrlInput) {
            bybitWorkerUrlInput.focus();
            bybitWorkerUrlInput.select();
        }
    });
}
if (bybitToggle) {
    bybitToggle.addEventListener('change', () => {
        localStorage.setItem(BYBIT_PREF_KEY, bybitToggle.checked ? '1' : '0');
        applyBybitVisibility();
        if (bybitToggle.checked) {
            if (getBybitWorkerUrl()) {
                pingBybitWorker();
            } else {
                setBybitStatus('URL не задан — балансы и анализ-портфеля не будут работать.', 'warn');
                setProxyConnected(false);
            }
        } else {
            setBybitStatus('', '');
            setProxyConnected(false);
            balanceEl.textContent = '--';
        }
    });
}
applyBybitVisibility();
if (isBybitEnabled()) {
    if (getBybitWorkerUrl()) {
        pingBybitWorker();
    } else {
        setBybitStatus('URL не задан — балансы и анализ-портфеля не будут работать.', 'warn');
    }
}

const pairEl = document.getElementById('pair');
const directionEl = document.getElementById('direction');
const entryPriceEl = document.getElementById('entryPrice');
const tpEl = document.getElementById('tp');
const slEl = document.getElementById('sl');
const rrEl = document.getElementById('rr');
const confidenceEl = document.getElementById('confidence');
const reasonEl = document.getElementById('reason');
const positionSizeEl = document.getElementById('positionSize');
const statusValueEl = document.getElementById('statusValue');

async function loadBalance() {
    if (!isBybitEnabled()) {
        balanceEl.textContent = '--';
        return;
    }
    try {
        // cache: 'no-store' + a cachebuster make sure no browser, ServiceWorker
        // or CDN tier returns a stale balance even if Cache-Control got dropped.
        const opts = bybitFetchOptions();
        opts.cache = 'no-store';
        const r = await fetch(`/api/balance?_=${Date.now()}`, opts);
        const d = await r.json();
        if (d.success) {
            // Prefer totalEquity — full UTA equity in USD: USDT cash + every
            // non-USDT spot holding at mark price + unrealised PnL of every
            // open position. This matches the headline number Bybit shows on
            // its own dashboard. Fall back to USDT-only equity, then to
            // walletBalance, so the widget never goes blank if the upstream
            // payload is partial.
            const display = (
                Number.isFinite(d.totalEquity) && d.totalEquity > 0 ? d.totalEquity :
                Number.isFinite(d.equity) && d.equity > 0 ? d.equity :
                d.balance
            );
            animateNumber(balanceEl, display, { decimals: 2 });
            // Switch the unit label to USD when we're showing totalEquity
            // (it's a USD-denominated aggregate across all coins, not USDT).
            if (balanceUnitEl) {
                balanceUnitEl.textContent = (Number.isFinite(d.totalEquity) && d.totalEquity > 0)
                    ? 'USD' : 'USDT';
            }
            if (balanceWidget) {
                const tip = `Total equity (UTA): ${(d.totalEquity ?? 0).toFixed(2)} USD\n` +
                            `Wallet (USDT): ${(d.wallet ?? d.balance).toFixed(2)}\n` +
                            `Equity (USDT): ${(d.equity ?? 0).toFixed(2)}\n` +
                            `Available (USDT): ${(d.available ?? 0).toFixed(2)}\n` +
                            `Unrealised PnL (USDT): ${(d.unrealisedPnl ?? 0).toFixed(2)}\n` +
                            `Updated: ${new Date(d.ts || Date.now()).toLocaleTimeString()}\n` +
                            `(refreshes every 60s while tab is active, click to refresh now)`;
                balanceWidget.title = tip;
                balanceWidget.dataset.lastTs = String(d.ts || Date.now());
            }
        } else {
            balanceEl.textContent = '--';
            if (d.error && bybitConfigStatus) {
                setBybitStatus(d.error, 'err');
                // Re-expand the proxy panel so the error is visible to the user
                // (panel was likely collapsed after a successful health-check).
                setProxyConnected(false);
            }
        }
    } catch (e) {
        console.error('Balance error:', e);
        balanceEl.textContent = '--';
        setBybitStatus(`Ошибка балансов: ${e.message}`, 'err');
        setProxyConnected(false);
    }
}

// Auto-refresh the balance while the page is visible AND the user has been
// active in the last 5 minutes. Without this, walletBalance/equity looks
// "frozen" between user actions; with it, we still don't burn Vercel /
// Bybit quota when the tab is just sitting open in the background.
// The user can also disable polling entirely via the round toggle button
// next to the theme switcher (state persisted in localStorage).
const BALANCE_REFRESH_MS = 60_000;            // 60s — ~1440 calls/day per active tab
const BALANCE_IDLE_TIMEOUT_MS = 5 * 60_000;   // pause polling after 5 min idle
const BALANCE_AUTOREFRESH_KEY = 'balanceAutoRefresh';
let balanceRefreshTimer = null;
let lastUserActivityTs = Date.now();

function isBalanceAutoRefreshOn() {
    try {
        const raw = localStorage.getItem(BALANCE_AUTOREFRESH_KEY);
        // default = on if nothing was ever stored
        return raw === null ? true : raw === 'on';
    } catch (_) {
        return true;
    }
}

function noteUserActivity() { lastUserActivityTs = Date.now(); }
['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach(evt => {
    document.addEventListener(evt, noteUserActivity, { passive: true });
});

function startBalanceAutoRefresh() {
    if (balanceRefreshTimer) clearInterval(balanceRefreshTimer);
    if (!isBalanceAutoRefreshOn()) return;
    balanceRefreshTimer = setInterval(() => {
        if (document.visibilityState !== 'visible') return;
        if (!isBybitEnabled()) return;
        if (Date.now() - lastUserActivityTs > BALANCE_IDLE_TIMEOUT_MS) return;
        loadBalance();
    }, BALANCE_REFRESH_MS);
}
function stopBalanceAutoRefresh() {
    if (balanceRefreshTimer) {
        clearInterval(balanceRefreshTimer);
        balanceRefreshTimer = null;
    }
}
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isBybitEnabled()) {
        noteUserActivity();
        if (isBalanceAutoRefreshOn()) loadBalance();
    }
});
if (balanceWidget) {
    balanceWidget.style.cursor = 'pointer';
    balanceWidget.addEventListener('click', () => {
        noteUserActivity();
        // Manual click always refreshes regardless of auto-refresh setting.
        if (isBybitEnabled()) loadBalance();
    });
}

(function setupBalanceRefreshToggle() {
    const btn = document.getElementById('balanceRefreshToggle');
    if (!btn) return;
    const apply = (on) => {
        btn.dataset.state = on ? 'on' : 'off';
        btn.title = on
            ? 'Авто-обновление баланса каждые 60с (клик — выключить)'
            : 'Авто-обновление выключено (клик — включить)';
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    };
    apply(isBalanceAutoRefreshOn());
    btn.addEventListener('click', () => {
        const next = !isBalanceAutoRefreshOn();
        try { localStorage.setItem(BALANCE_AUTOREFRESH_KEY, next ? 'on' : 'off'); }
        catch (_) { /* private mode — behave as in-memory only */ }
        apply(next);
        if (next) {
            noteUserActivity();
            startBalanceAutoRefresh();
            if (isBybitEnabled()) loadBalance();
        } else {
            stopBalanceAutoRefresh();
        }
    });
})();

startBalanceAutoRefresh();

let currentButton = null;
let currentTrade = null;
let portfolioPairs = [];

function getButtonPosition(btn) {
    const rect = btn.getBoundingClientRect();
    return {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height
    };
}

async function runAnalysis() {
    if (presetBtn.disabled) return;
    
    presetBtn.disabled = true;
    currentButton = presetBtn;
    const pos = getButtonPosition(presetBtn);
    
    document.getElementById('portfolioAnalysis').style.display = 'none';
    document.getElementById('bestTrade').style.display = 'none';
    document.getElementById('tradeActions').style.display = 'none';
    currentTrade = null;

    const executeBtnReset = document.getElementById('executeBtn');
    executeBtnReset.style.display = '';
    executeBtnReset.disabled = false;
    executeBtnReset.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg> Выставить';
    
    const loader = document.getElementById('portfolioLoader');
    loader.classList.add('active');
    
    const terminalLine = document.getElementById('terminalLine');
    const codeLines = [
      'initializing AI trading system...',
      'connecting to bybit API...',
      'fetching market data...',
      'calculating RSI indicators...',
      'analyzing MACD signals...',
      'computing VWAP levels...',
      'evaluating support/resistance...',
      'checking volume dynamics...',
      'generating trading signals...',
      'optimizing entry points...',
      'calculating risk parameters...',
      'done ✓'
    ];
    
    let lineIndex = 0;
    let charIndex = 0;
    let currentLine = '';
    
    const typeWriter = () => {
      if (lineIndex < codeLines.length) {
        const line = codeLines[lineIndex];
        if (charIndex < line.length) {
          currentLine += line[charIndex];
          terminalLine.textContent = currentLine + '_';
          charIndex++;
          setTimeout(typeWriter, Math.random() * 30 + 10);
        } else {
          currentLine += '\n';
          lineIndex++;
          charIndex = 0;
          setTimeout(typeWriter, 150);
        }
      } else {
        terminalLine.textContent = codeLines.join('\n');
      }
    };
    
    typeWriter();
    tbody.innerHTML = '';
    comments.textContent = '';
    comments.className = 'comments';
    statusValueEl.textContent = 'Анализ...';
    statusValueEl.className = 'status-value pending';
    
    pairEl.textContent = '--';
    directionEl.textContent = '--';
    entryPriceEl.textContent = '--';
    tpEl.textContent = '--';
    slEl.textContent = '--';
    rrEl.textContent = '--';
    confidenceEl.textContent = '--/10';
    reasonEl.textContent = '';
    positionSizeEl.textContent = '--';
    
    try {
        const sel = getSelectedPairs();
        const url = sel.length ? `/api/analyze?symbols=${encodeURIComponent(sel.join(','))}` : '/api/analyze';
        const r = await fetch(url);
        const d = await r.json();
        
        loader.classList.remove('show');
        
        const loaderEl = document.getElementById('portfolioLoader');
        loaderEl.classList.remove('active');
        
        if (!d.success) {
            comments.textContent = '❌ ' + d.error;
            comments.className = 'comments show error';
            presetBtn.disabled = false;
            return;
        }
        
        if (d.trade) {
            const t = d.trade;
            currentTrade = t;
            
            pairEl.textContent = t.pair || '--';
            directionEl.textContent = t.direction || '--';
            directionEl.dataset.dir = (t.direction || '').toUpperCase();
            entryPriceEl.textContent = t.entryPrice ? '$' + t.entryPrice.toLocaleString() : '--';
            tpEl.textContent = t.tp ? '$' + t.tp.toLocaleString() : '--';
            slEl.textContent = t.sl ? '$' + t.sl.toLocaleString() : '--';
            
            if (t.entryPrice && t.tp && t.sl) {
                const rr = (t.tp - t.entryPrice) / (t.entryPrice - t.sl);
                rrEl.textContent = rr.toFixed(1) + 'R';
            }
            
            confidenceEl.textContent = t.confidence ? t.confidence + '/10' : '--/10';
            reasonEl.textContent = t.reason || '';
            
            if (t.positionSize) {
                const coin = (t.pair || '').replace(/USDT$|USDC$|USD$/, '');
                positionSizeEl.textContent = t.positionSize.toFixed(4) + (coin ? ' ' + coin : '');
            }
            
if (t.executed) {
                statusValueEl.textContent = '✅ Ордер выставлен';
                statusValueEl.className = 'status-value success';
            } else if (t.orderError) {
                statusValueEl.textContent = '❌ ' + t.orderError;
                statusValueEl.className = 'status-value error';
            } else {
                statusValueEl.textContent = 'Готово к исполнению';
                statusValueEl.className = 'status-value ready';
            }
            
            const tradeActions = document.getElementById('tradeActions');
            tradeActions.style.display = 'flex';
            const usdtValue = t.positionSize && t.entryPrice ? (t.positionSize * t.entryPrice).toFixed(2) : '--';
            document.getElementById('positionInfo').textContent = usdtValue !== '--' ? '$' + usdtValue : '--';
            document.getElementById('priceInfo').textContent = t.entryPrice ? '$' + t.entryPrice.toLocaleString() : (t.orderType === 'market' ? 'Рыночная' : '--');
            
            document.getElementById('bestTrade').style.display = 'block';
            
            comments.textContent = d.trade.reason || 'Анализ завершен';
            comments.className = 'comments show';
        }
        
        results.classList.add('show');
        loadBalance();
        
    } catch (e) {
        loader.classList.remove('show');
        const loaderEl = document.getElementById('portfolioLoader');
        loaderEl.classList.remove('active');
        comments.textContent = '❌ ' + e.message;
        comments.className = 'comments show error';
    } finally {
        presetBtn.disabled = false;
    }
}

presetBtn.addEventListener('click', runAnalysis);

// Portfolio button – анализ 5 пар
const portfolioBtn = document.getElementById('portfolioBtn');
portfolioBtn.addEventListener('click', async () => {
    if (portfolioBtn.disabled) return;
    
    portfolioBtn.disabled = true;
    currentButton = portfolioBtn;
    
    document.getElementById('portfolioAnalysis').style.display = 'none';
    document.getElementById('bestTrade').style.display = 'none';
    document.getElementById('tradeActions').style.display = 'none';
    
    const loader = document.getElementById('portfolioLoader');
    loader.classList.add('active');
    
    const terminalLine = document.getElementById('terminalLine');
    const codeLines = [
        'analyzing market for 5 best pairs...',
        'fetching price data...',
        'calculating RSI, MACD, VWAP...',
        'evaluating risk/reward ratios...',
        'selecting optimal positions...',
        'optimizing allocation...',
        'generating trade signals...',
        'done ✓'
    ];
    
    let lineIndex = 0;
    let charIndex = 0;
    let currentLine = '';
    
    const typeWriter = () => {
        if (lineIndex < codeLines.length) {
            const line = codeLines[lineIndex];
            if (charIndex < line.length) {
                currentLine += line[charIndex];
                terminalLine.textContent = currentLine + '_';
                charIndex++;
                setTimeout(typeWriter, Math.random() * 30 + 10);
            } else {
                currentLine += '\n';
                lineIndex++;
                charIndex = 0;
                setTimeout(typeWriter, 150);
            }
        } else {
            terminalLine.textContent = codeLines.join('\n');
        }
    };
    
    typeWriter();
    
    try {
        const sel = getSelectedPairs();
        const r = await fetch('/api/portfolio', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sel.length ? { symbols: sel } : {})
        });
        const d = await r.json();
        
        const loaderEl = document.getElementById('portfolioLoader');
        loaderEl.classList.remove('active');
        currentButton = null;
        
        if (!d.success) {
            alert('Ошибка: ' + (d.error || 'неизвестно'));
            portfolioBtn.disabled = false;
            return;
        }
        
        // Показать результаты
        const tbody = document.getElementById('tbody');
        portfolioPairs = d.pairs;
        tbody.innerHTML = d.pairs.map((p, i) => `
            <tr class="${p.direction.toLowerCase()}">
                <td data-label="#" class="cell-num">${i + 1}</td>
                <td data-label="Пара" class="cell-pair"><strong>${p.pair}</strong></td>
                <td data-label="Направление" class="cell-dir"><span class="dir ${p.direction.toLowerCase()}"><span class="dot"></span>${p.direction}</span></td>
                <td data-label="Вход" class="cell-entry">$${p.entryPrice?.toFixed(2) || '-'}</td>
                <td data-label="TP" class="cell-tp">${p.tp ? '$' + p.tp.toFixed(2) : '-'}</td>
                <td data-label="SL" class="cell-sl">${p.sl ? '$' + p.sl.toFixed(2) : '-'}</td>
                <td data-label="Уверенность" class="cell-conf">${p.confidence != null ? p.confidence + '/10' : '--/10'}</td>
                <td data-label="Обоснование" class="cell-reason">${p.reason || '-'}</td>
                <td class="cell-action">
                    <button class="table-btn" onclick="executePairOrder(${i})">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M5 12h14M12 5l7 7-7 7"/>
                        </svg>
                        <span class="table-btn-label">Выставить</span>
                    </button>
                </td>
            </tr>
        `).join('');
        
        document.getElementById('results').style.display = 'block';
        loadBalance();
        
    } catch (e) {
        const loaderEl = document.getElementById('portfolioLoader');
        loaderEl.classList.remove('active');
        alert('Ошибка: ' + e.message);
    } finally {
        portfolioBtn.disabled = false;
    }
});

// NEW: Анализ текущего портфеля (процент закрытия)
const portfolioAnalyzeBtn = document.getElementById('portfolioAnalyzeBtn');
portfolioAnalyzeBtn.addEventListener('click', async () => {
  if (!isBybitEnabled()) {
    alert('Bybit-интеграция выключена. Включи переключатель "Bybit" в шапке, если у тебя настроен прокси.');
    return;
  }
  try {
    currentButton = portfolioAnalyzeBtn;
    const pos = getButtonPosition(portfolioAnalyzeBtn);
    
    document.getElementById('portfolioAnalysis').style.display = 'none';
    document.getElementById('bestTrade').style.display = 'none';
    document.getElementById('tradeActions').style.display = 'none';
    document.getElementById('loader').style.display = 'none';
    
    const loader = document.getElementById('portfolioLoader');
    loader.style.setProperty('--start-x', pos.x + 'px');
    loader.style.setProperty('--start-y', pos.y + 'px');
    loader.style.setProperty('--start-width', pos.width + 'px');
    loader.style.setProperty('--start-height', pos.height + 'px');
    loader.classList.add('expand-animation');
    
    setTimeout(() => {
        loader.classList.add('active');
    }, 300);
    
    const terminalLine = document.getElementById('terminalLine');
    const codeLines = [
      'import portfolio_analyzer v2.0...',
      'loading wallet data...',
      'connecting to bybit API...',
      'fetching open positions...',
      'calculating RSI indicators...',
      'analyzing MACD patterns...',
      'computing VWAP levels...',
      'fetching order history...',
      'processing technical analysis...',
      'calculating risk metrics...',
      'generating recommendations...',
      'done ✓'
    ];
    
    let lineIndex = 0;
    let charIndex = 0;
    let currentLine = '';
    
    const typeWriter = () => {
      if (lineIndex < codeLines.length) {
        const line = codeLines[lineIndex];
        if (charIndex < line.length) {
          currentLine += line[charIndex];
          terminalLine.textContent = currentLine + '_';
          charIndex++;
          setTimeout(typeWriter, Math.random() * 30 + 10);
        } else {
          currentLine += '\n';
          lineIndex++;
          charIndex = 0;
          setTimeout(typeWriter, 200);
        }
      } else {
        terminalLine.textContent = codeLines.join('\n');
      }
    };
    
    typeWriter();
    
    const r = await fetch('/api/portfolio/analyze', bybitFetchOptions({method: 'POST'}));
    const d = await r.json();
    
    const loaderEl = document.getElementById('portfolioLoader');
    loaderEl.classList.remove('active');
    document.getElementById('loader').style.display = 'none';
    currentButton = null;
    
    if (!d.success) {
      alert('Ошибка анализа: ' + (d.error || 'неизвестно'));
      return;
    }
    console.log('Portfolio analysis:', d);
    const a = d.analysis;
    if (!a) {
      alert('Нет данных анализа');
      return;
    }
    const tbody = document.getElementById('analysisBody');
    const b = d.balance || null;
    const fmt = (n) => Number.isFinite(n) ? `$${n.toFixed(2)}` : '--';
    const sign = (n) => Number.isFinite(n) && n !== 0 ? (n > 0 ? '+' : '') : '';
    let balanceRow = '';
    if (b) {
      // accountSummary.unrealisedPnl and the per-position futuresUnrealised
      // sum represent the SAME PnL (USDT-margined open positions), just
      // computed from different Bybit endpoints — never add them together.
      // Prefer the position-list sum because it matches the per-row PnL we
      // just rendered in the open-positions table.
      const livePnl = Number.isFinite(b.futuresUnrealised) && b.futuresUnrealised !== 0
        ? b.futuresUnrealised
        : (b.unrealisedPnl || 0);
      const ts = b.ts ? new Date(b.ts).toLocaleTimeString() : '';
      balanceRow = `
        <tr><td><strong>Активный баланс</strong></td>
            <td>
              <strong>${fmt(b.activeBalance)}</strong>
              <small style="opacity:.75">
                — wallet ${fmt(b.wallet)},
                доступно ${fmt(b.available)},
                спот-холдинги ${fmt(b.spotValue)},
                нереал. PnL ${sign(livePnl)}${fmt(livePnl)}
                ${b.futuresNotional > 0 ? `, фьюч. notional ${fmt(b.futuresNotional)}` : ''}
                ${ts ? ` · обн. ${ts}` : ''}
              </small>
            </td></tr>
      `;
    }
    tbody.innerHTML = `
      ${balanceRow}
      <tr><td><strong>Общее резюме</strong></td><td>${a.summary || '-'}</td></tr>
      <tr><td><strong>Сильные стороны</strong></td><td>${a.strengths || '-'}</td></tr>
      <tr><td><strong>Слабые стороны</strong></td><td>${a.weaknesses || '-'}</td></tr>
      <tr><td><strong>Рекомендации</strong></td><td>${a.suggestions || '-'}</td></tr>
      <tr><td><strong>Рекомендации по TP/SL</strong></td><td>${a.tpRecommendations || '-'}</td></tr>
    `;
    
    const positionsBody = document.getElementById('positionsBody');
    if (d.openPositions && d.openPositions.length > 0) {
      positionsBody.innerHTML = d.openPositions.map(p => {
        const isFutures = p.kind === 'futures';

        const symbolCell = isFutures
          ? `${p.symbol} <span class="pos-side pos-side-${p.side === 'SHORT' ? 'short' : 'long'}">${p.side}${p.leverage ? ' x' + p.leverage : ''}</span>`
          : p.symbol;

        let tpslCell = '-';
        if (p.tp != null && p.sl != null) {
          tpslCell = `TP $${p.tp.toFixed(2)} / SL $${p.sl.toFixed(2)}`;
        } else if (p.tp != null) {
          tpslCell = `TP $${p.tp.toFixed(2)}`;
        } else if (p.sl != null) {
          tpslCell = `SL $${p.sl.toFixed(2)}`;
        }

        let typeCell;
        if (isFutures) {
          typeCell = 'Фьючерс';
        } else {
          typeCell = p.tp ? 'TP (выше)' : (p.sl ? 'SL (ниже)' : 'Спот');
        }

        const chanceParts = [];
        if (p.tpChance != null) chanceParts.push(`TP ${p.tpChance}%`);
        if (p.slChance != null) chanceParts.push(`SL ${p.slChance}%`);
        const chanceCell = chanceParts.length ? chanceParts.join(' / ') : '-';

        let valueCell = `$${(p.value || 0).toFixed(2)}`;
        if (isFutures && Number.isFinite(p.unrealisedPnl)) {
          const sign = p.unrealisedPnl >= 0 ? '+' : '';
          const cls = p.unrealisedPnl >= 0 ? 'pnl-up' : 'pnl-down';
          valueCell += ` <small class="${cls}">${sign}$${p.unrealisedPnl.toFixed(2)}</small>`;
        }

        const qtyDisplay = Number.isFinite(p.qty) ? p.qty.toFixed(4) : (p.qty || '-');

        return `
        <tr>
          <td>${symbolCell}</td>
          <td>${qtyDisplay}</td>
          <td>$${p.avgPrice.toFixed(2)}</td>
          <td>$${p.currentPrice.toFixed(2)}</td>
          <td>${tpslCell}</td>
          <td>${typeCell}</td>
          <td>${chanceCell}</td>
          <td>${valueCell}</td>
        </tr>
      `}).join('');
    } else {
      positionsBody.innerHTML = '<tr><td colspan="8">Нет открытых позиций</td></tr>';
    }
    
    if (a.positions && a.positions.length > 0) {
      const tbody = document.getElementById('analysisBody');
      const existing = tbody.innerHTML;
      tbody.innerHTML = existing + `
        <tr><td colspan="2"><strong>📊 Рекомендации по TP/SL на основе индикаторов</strong></td></tr>
        ${a.positions.map(p => `
          <tr>
            <td>${p.symbol}</td>
            <td>TP: ${p.tp ? '$' + p.tp : '-'} | SL: ${p.sl ? '$' + p.sl : '-'} <br><small>${p.tpReason || ''}</small></td>
          </tr>
        `).join('')}
      `;
    }
    document.getElementById('portfolioAnalysis').style.display = 'block';
    document.getElementById('results').style.display = 'none';
    comments.classList.remove('show');
  } catch (e) {
    alert('Ошибка запроса: ' + e.message);
  }
});
document.addEventListener('keydown', function(e) {
    if (e.key !== 'Enter') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    runAnalysis();
});

loadBalance();
renderPairSelector();

async function executeTrade() {
    console.log('currentTrade:', currentTrade);
    if (!currentTrade || !currentTrade.pair || !currentTrade.direction) {
        alert('Нет данных о сделке. Запустите анализ.');
        return;
    }
    
    const btn = document.getElementById('executeBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Выставляю...';
    
    try {
        let qty;
        let price = currentTrade.entryPrice;
        const symbol = currentTrade.pair.replace('/', '');

        // Pull instrument-info first so qty rounding uses the correct step.
        // Best-effort — if it fails we fall back to toFixed(4) and rely on
        // backend validation. Cached, so cheap on second click.
        const instrument = isBybitEnabled() ? await getInstrumentInfo(symbol) : null;

        let bumpNotice = null;
        if (currentTrade.usdtAmount && price) {
            // chooseTradeQty handles the snap-down crossing the $5 floor:
            // if 12 DOGE × $0.4 = $4.80 < $5, it tries 13 DOGE = $5.20
            // and uses that if cap allows. Without explicit cap here we
            // pass undefined; the live cap re-check below catches anything
            // beyond (and re-runs chooseTradeQty with the strict cap).
            const choice = chooseTradeQty(currentTrade.usdtAmount, price, instrument);
            qty = choice.qty;
            if (choice.bumped) {
                console.log(`Qty bumped to next step to satisfy $5 notional floor: ${qty} (notional $${choice.usdt.toFixed(2)})`);
                bumpNotice = `Сумма поднята с $${currentTrade.usdtAmount.toFixed(2)} до $${choice.usdt.toFixed(2)} (минимум биржи $5).`;
                currentTrade.usdtAmount = choice.usdt;
            }
        } else if (currentTrade.positionSize) {
            qty = snapQtyToStep(currentTrade.positionSize, instrument);
        } else if (currentTrade.orderType === 'market') {
            const usd = currentTrade.usdtAmount || 10;
            // Without a known price for market orders we can't snap to step
            // ahead of time — backend re-snaps on placement using mark price.
            if (price) {
                const choice = chooseTradeQty(usd, price, instrument);
                qty = choice.qty;
                if (choice.bumped) {
                    console.log(`Market qty bumped to satisfy $5 floor: ${qty} (notional $${choice.usdt.toFixed(2)})`);
                    currentTrade.usdtAmount = choice.usdt;
                }
            } else {
                qty = parseFloat(usd.toFixed(4));
            }
        } else {
            alert('Укажите сумму в USDT');
            btn.disabled = false;
            return;
        }

        if (!qty || qty <= 0) {
            statusValueEl.textContent = '❌ Сумма слишком маленькая для этой пары. Увеличь сумму или возьми пару подешевле.';
            statusValueEl.className = 'status-value error';
            btn.disabled = false;
            btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg> Выставить';
            return;
        }

        // Pre-flight check qty/notional minimums so we fail fast with a clear
        // message instead of round-tripping to Bybit and getting back 10001.
        const preflight = validateOrderAgainstInstrument(qty, price, instrument);
        if (preflight) {
            statusValueEl.textContent = '❌ ' + preflight.message;
            statusValueEl.className = 'status-value error';
            btn.disabled = false;
            btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg> Выставить';
            return;
        }

        // Refuse if AI's TP is closer to entry than the round-trip taker fee
        // (0.11%) — hitting it would give a guaranteed net loss. Use the
        // actual entry price the order will be placed at (limit price for
        // limit orders; AI-recommended entry for market orders).
        const entryRef = price || currentTrade.entryPrice;
        const tpCheck = validateTpAgainstFees(entryRef, currentTrade.tp, currentTrade.direction);
        if (tpCheck) {
            statusValueEl.textContent = '❌ ' + tpCheck.message;
            statusValueEl.className = 'status-value error';
            btn.disabled = false;
            btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg> Выставить';
            return;
        }

        // Defence in depth: even if the cached usdtAmount was sized correctly
        // when AI recommended, the user may have opened other positions in the
        // meantime which ate into available margin. Re-check just before sending
        // so we never send an order Bybit will reject with 110007.
        //
        // IMPORTANT: only clamp the user's chosen size down to `live.cap` (the
        // free-margin ceiling). Don't clamp to `live.usdtAmount` — that's the
        // 10%-of-equity AI default, and a user who manually entered a smaller
        // OR larger number that still fits free margin should be honoured.
        if (price && currentTrade.usdtAmount && isBybitEnabled()) {
            try {
                const fr = await fetch('/api/balance', bybitFetchOptions());
                const fd = await fr.json();
                if (fd && fd.success) {
                    const live = planOrderUsdt(fd);
                    if (live.equity <= 0) {
                        statusValueEl.textContent = '❌ Bybit вернул нулевой баланс. Проверь, что прокси подключён к нужному счёту.';
                        statusValueEl.className = 'status-value error';
                        btn.disabled = false;
                        btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg> Выставить';
                        return;
                    }
                    if (live.cap <= 0) {
                        statusValueEl.textContent = `❌ Свободного маржинального баланса нет (free margin $${live.available.toFixed(2)})`;
                        statusValueEl.className = 'status-value error';
                        btn.disabled = false;
                        btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg> Выставить';
                        return;
                    }
                    if (live.cap + 0.01 < currentTrade.usdtAmount) {
                        // Use chooseTradeQty so reduction-then-snap can still
                        // satisfy the $5 floor by bumping to next step within
                        // the cap.
                        const reChoice = chooseTradeQty(live.cap, price, instrument, live.cap);
                        console.log(`Sizing reduced just before send: qty ${qty} -> ${reChoice.qty} (cap $${live.cap}, free margin $${live.available.toFixed(2)})`);
                        const reCheck = validateOrderAgainstInstrument(reChoice.qty, price, instrument);
                        if (reCheck) {
                            statusValueEl.textContent = '❌ ' + reCheck.message + ` (свободно $${live.cap.toFixed(2)})`;
                            statusValueEl.className = 'status-value error';
                            btn.disabled = false;
                            btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg> Выставить';
                            return;
                        }
                        qty = reChoice.qty;
                        currentTrade.usdtAmount = reChoice.usdt;
                    }
                }
            } catch (_) { /* network blip — fall through and let Bybit decide */ }
        }

        console.log('Calculated qty:', qty, 'price:', price);
        
const payload = {
            symbol: currentTrade.pair.replace('/', ''),
            side: currentTrade.direction === 'LONG' ? 'Buy' : 'Sell',
            qty: qty,
            price: price || null,
            tp: currentTrade.tp || null,
            sl: currentTrade.sl || null
        };
        console.log('Sending:', payload);
        
        const endpoint = currentTrade.orderType === 'market' ? '/api/execute-market' : '/api/execute';
        const r = await fetch(endpoint, bybitFetchOptions({
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        }));
        const d = await r.json();
        console.log('Response:', d);
        
        if (d.success) {
            statusValueEl.textContent = '✅ Ордер выставлен' + (bumpNotice ? ` (${bumpNotice})` : '');
            statusValueEl.className = 'status-value success';
            btn.style.display = 'none';
            loadBalance();
            alert('Ордер успешно выставлен!' + (bumpNotice ? ` ${bumpNotice}` : ''));
        } else {
            statusValueEl.textContent = '❌ ' + (d.error || 'Ошибка');
            statusValueEl.className = 'status-value error';
            btn.disabled = false;
            btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg> Выставить';
        }
    } catch (e) {
        statusValueEl.textContent = '❌ ' + e.message;
        statusValueEl.className = 'status-value error';
        btn.disabled = false;
        btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg> Выставить';
    }
}

function hideAllInputs() {
    const existingInput = document.querySelector('.manual-input-wrap');
    if (existingInput) {
        existingInput.remove();
    }
}

// Bybit minimum notional for most USDT-perp pairs ($5). Order under this is
// rejected by the exchange with a confusing retCode, so we filter client-side.
const BYBIT_MIN_NOTIONAL_USDT = 5;
// Slippage thresholds vs the AI's reference entry price (or last known mark).
// Beyond `WARN`, ask the user to confirm; beyond `BLOCK`, refuse — almost
// always a typo (extra zero, wrong decimal point) and would burn money.
const PRICE_DEVIATION_WARN_PCT = 5;
const PRICE_DEVIATION_BLOCK_PCT = 20;

function showManualInput() {
    hideAllInputs();

    const tradeActions = document.getElementById('tradeActions');

    const suggestedUsdt = (() => {
        if (Number.isFinite(currentTrade?.usdtAmount) && currentTrade.usdtAmount > 0) {
            return currentTrade.usdtAmount.toFixed(2);
        }
        if (Number.isFinite(currentTrade?.positionSize) && Number.isFinite(currentTrade?.entryPrice)) {
            return (currentTrade.positionSize * currentTrade.entryPrice).toFixed(2);
        }
        return '';
    })();
    const suggestedPrice = Number.isFinite(currentTrade?.entryPrice) && currentTrade.entryPrice > 0
        ? currentTrade.entryPrice
        : null;

    const wrap = document.createElement('div');
    wrap.className = 'manual-input-wrap manual-compact';
    wrap.innerHTML = `
        <div class="seg-toggle" id="orderTypeToggle" role="tablist" aria-label="Тип ордера">
            <button type="button" class="seg-btn is-active" data-type="limit" role="tab" aria-selected="true">Лимит</button>
            <button type="button" class="seg-btn" data-type="market" role="tab" aria-selected="false">Рыночный</button>
        </div>
        <div class="instrument-min-hint" id="instrumentMinHint" hidden></div>
        <div class="manual-grid">
            <div class="manual-input">
                <label for="manualQty">Сумма USDT <span class="required" aria-hidden="true">*</span></label>
                <div class="input-with-suggest">
                    <input type="number" id="manualQty" step="0.01" min="0" inputmode="decimal" aria-required="true" autocomplete="off" placeholder="мин $${BYBIT_MIN_NOTIONAL_USDT}">
                    ${suggestedUsdt ? `<button type="button" class="input-suggest" data-target="manualQty" data-value="${suggestedUsdt}" title="Подставить рекомендацию AI">$${suggestedUsdt}</button>` : ''}
                </div>
            </div>
            <div class="manual-input price-input-wrap" id="priceInputWrap">
                <label for="manualPrice">Лимит-цена <span class="required" aria-hidden="true">*</span></label>
                <div class="input-with-suggest">
                    <input type="number" id="manualPrice" step="0.0001" min="0" inputmode="decimal" aria-required="true" autocomplete="off" placeholder="USDT">
                    ${suggestedPrice ? `<button type="button" class="input-suggest" data-target="manualPrice" data-value="${suggestedPrice}" title="Подставить рекомендацию AI">$${suggestedPrice.toLocaleString()}</button>` : ''}
                </div>
            </div>
            <div class="market-price-chip" id="marketPriceChip" hidden>
                <span class="chip chip-market">Цена ордера: <strong>рыночная</strong></span>
            </div>
        </div>
        <button class="action-btn ai-btn" id="applyManualBtn" type="button">Применить</button>
    `;
    tradeActions.appendChild(wrap);

    wrap.querySelectorAll('.input-suggest').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = document.getElementById(btn.dataset.target);
            if (target) {
                target.value = btn.dataset.value;
                target.dispatchEvent(new Event('input', { bubbles: true }));
                target.focus();
            }
        });
    });

    document.getElementById('applyManualBtn').addEventListener('click', applyManualInput);

    const toggle = document.getElementById('orderTypeToggle');
    const priceWrap = document.getElementById('priceInputWrap');
    const marketChip = document.getElementById('marketPriceChip');
    const priceInput = document.getElementById('manualPrice');
    const setOrderType = (type) => {
        toggle.querySelectorAll('.seg-btn').forEach(b => {
            const active = b.dataset.type === type;
            b.classList.toggle('is-active', active);
            b.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        toggle.dataset.value = type;
        if (type === 'market') {
            priceWrap.hidden = true;
            marketChip.hidden = false;
            priceInput.removeAttribute('aria-required');
            clearFieldError(priceInput);
        } else {
            priceWrap.hidden = false;
            marketChip.hidden = true;
            priceInput.setAttribute('aria-required', 'true');
        }
    };
    toggle.addEventListener('click', (e) => {
        const btn = e.target.closest('.seg-btn');
        if (!btn) return;
        setOrderType(btn.dataset.type);
    });
    setOrderType('limit');

    // Async-load instrument-info so the user sees "минимум для BTCUSDT 0.001
    // (≈$95)" before they type a too-small amount and have it rejected.
    if (currentTrade?.pair) {
        const sym = currentTrade.pair.replace('/', '');
        getInstrumentInfo(sym).then(info => {
            if (!info) return;
            const hint = document.getElementById('instrumentMinHint');
            if (!hint) return;
            const refPrice = Number.isFinite(currentTrade?.entryPrice) && currentTrade.entryPrice > 0
                ? currentTrade.entryPrice : null;
            const minNotional = refPrice
                ? Math.max(info.minOrderQty * refPrice, info.minOrderAmt)
                : info.minOrderAmt;
            hint.textContent = `Минимум для ${info.symbol}: ${info.minOrderQty} (≈$${minNotional.toFixed(2)}) · шаг ${info.qtyStep}`;
            hint.hidden = false;
        });
    }
}

async function applyManualInput() {
    const qtyInput = document.getElementById('manualQty');
    const priceInput = document.getElementById('manualPrice');
    const orderType = document.getElementById('orderTypeToggle')?.dataset?.value || 'limit';

    const usdt = parseFloat(qtyInput.value);
    if (!Number.isFinite(usdt) || usdt <= 0) {
        markFieldError(qtyInput, 'Введи положительное число USDT');
        qtyInput.focus();
        return;
    }
    if (usdt < BYBIT_MIN_NOTIONAL_USDT) {
        markFieldError(qtyInput, `Меньше минимума Bybit ($${BYBIT_MIN_NOTIONAL_USDT}). Биржа отклонит ордер.`);
        qtyInput.focus();
        return;
    }
    // Per-symbol minNotional from Bybit's lotSizeFilter — usually $5 but a
    // few contracts have higher floors. If the cached info isn't available
    // yet (first render), the global $5 check above is a reasonable fallback.
    if (currentTrade?.pair) {
        const instr = await getInstrumentInfo(currentTrade.pair.replace('/', ''));
        if (instr && instr.minOrderAmt > BYBIT_MIN_NOTIONAL_USDT && usdt < instr.minOrderAmt) {
            markFieldError(qtyInput, `Меньше минимума ${instr.symbol} ($${instr.minOrderAmt}). Биржа отклонит ордер.`);
            qtyInput.focus();
            return;
        }
    }
    clearFieldError(qtyInput);

    let price = null;
    if (orderType === 'limit') {
        price = parseFloat(priceInput.value);
        if (!Number.isFinite(price) || price <= 0) {
            markFieldError(priceInput, 'Введи положительную цену');
            priceInput.focus();
            return;
        }

        const reference = Number.isFinite(currentTrade?.entryPrice) && currentTrade.entryPrice > 0
            ? currentTrade.entryPrice
            : null;
        if (reference) {
            const deviationPct = Math.abs(price - reference) / reference * 100;
            if (deviationPct > PRICE_DEVIATION_BLOCK_PCT) {
                markFieldError(
                    priceInput,
                    `Цена $${price} отличается от текущей ($${reference}) на ${deviationPct.toFixed(1)}% — похоже на опечатку. Поправь, пожалуйста.`
                );
                priceInput.focus();
                return;
            }
            if (deviationPct > PRICE_DEVIATION_WARN_PCT) {
                const ok = confirm(
                    `Цена $${price} отличается от текущей ($${reference}) на ${deviationPct.toFixed(1)}%. Точно ставим?`
                );
                if (!ok) return;
            }
        }
        clearFieldError(priceInput);
    }

    currentTrade.usdtAmount = usdt;
    currentTrade.orderType = orderType;
    currentTrade.entryPrice = orderType === 'market' ? null : price;

    document.getElementById('positionInfo').textContent = '$' + usdt.toFixed(2);
    document.getElementById('priceInfo').textContent = price ? '$' + price.toLocaleString() : 'Рыночная';

    hideAllInputs();
}

function markFieldError(input, message) {
    if (!input) return;
    input.setAttribute('aria-invalid', 'true');
    input.classList.add('input-error');
    const wrap = input.closest('.manual-input');
    if (wrap) {
        let msg = wrap.querySelector('.input-error-msg');
        if (!msg) {
            msg = document.createElement('small');
            msg.className = 'input-error-msg';
            msg.setAttribute('role', 'alert');
            wrap.appendChild(msg);
        }
        msg.textContent = message;
    }
}

function clearFieldError(input) {
    if (!input) return;
    input.removeAttribute('aria-invalid');
    input.classList.remove('input-error');
    const wrap = input.closest('.manual-input');
    if (wrap) {
        const msg = wrap.querySelector('.input-error-msg');
        if (msg) msg.remove();
    }
}

// "Free margin" on Bybit V5 UTA isn't a single field — we have to look at two:
//   - `totalAvailableBalance` (account-level USD across all coins, the real
//     "free balance for placing new orders" on UTA)
//   - per-USDT-coin `availableToWithdraw` (only what can be withdrawn off-
//     exchange — often 0 on UTA even when there's plenty for trading)
// We take the larger of the two so neither field's restrictiveness traps us
// into reporting "available 0" when Bybit itself would happily accept the
// order.
function freeMarginFromBalance(d) {
    const totalAvail   = parseFloat(d?.totalAvailableBalance) || 0;
    const usdtWithdraw = parseFloat(d?.available) || 0;
    return Math.max(totalAvail, usdtWithdraw);
}

// Returns the user's effective tradeable equity in USD/USDT terms.
// On UTA cross-margin a user can have $X in BTC/USDC/etc. and 0 USDT in
// `walletBalance`, yet still place USDT-perpetual orders backed by that
// cross-coin collateral. Using only USDT walletBalance here would size the
// order to 0 and block the trade entirely. We therefore prefer the largest
// equity field reported by Bybit:
//   - totalEquity         (UTA: USD across all coins, headline number)
//   - equity              (USDT-only equity incl. unrealised PnL)
//   - totalWalletBalance  (UTA: USD wallet across all coins, no PnL)
//   - wallet              (USDT walletBalance, classic accounts)
function effectiveEquityFromBalance(d) {
    const totalEquity        = parseFloat(d?.totalEquity) || 0;
    const usdtEquity         = parseFloat(d?.equity) || 0;
    const totalWalletBalance = parseFloat(d?.totalWalletBalance) || 0;
    const usdtWallet         = parseFloat(d?.wallet ?? d?.balance) || 0;
    return Math.max(totalEquity, usdtEquity, totalWalletBalance, usdtWallet);
}

// Compute order size in USDT:
//   1. ideal = 10% of effective equity ("risk slice") — the AI's recommended size
//   2. cap   = FREE_MARGIN_CAP_PCT of free margin — the absolute upper bound,
//              with a buffer for taker fees (0.055%×2), slippage between sizing
//              and fill, and minor collateral movement on UTA cross-margin.
// `usdtAmount` (= min(ideal, cap)) is the AI default. Manual flow should
// only respect `cap` — the user picking $6 with $39 free margin is fine
// even though ideal is $3.9; clamping their manual input down to the
// 10% slice is a UX bug, not a safety feature.
// 0.95 was too tight in practice — Bybit kept rejecting orders with
// `110007 ab not enough` when free margin was small (~$30-40), because the
// 5% cushion didn't cover combined fee + slippage + IM rounding. 0.85 leaves
// 15% headroom which empirically clears 110007 in the small-account case.
const FREE_MARGIN_CAP_PCT = 0.85;
function planOrderUsdt(d) {
    const equity    = effectiveEquityFromBalance(d);
    const available = freeMarginFromBalance(d);
    const ideal = equity * 0.1;
    // If the proxy returned neither availability field (older response shapes),
    // fall back to the equity-based slice so we don't accidentally size to 0.
    const cap   = available > 0 ? available * FREE_MARGIN_CAP_PCT : ideal;
    const usdt  = Math.max(0, Math.min(ideal, cap));
    return {
        usdtAmount: parseFloat(usdt.toFixed(2)),
        wasReduced: usdt + 0.01 < ideal,
        ideal: parseFloat(ideal.toFixed(2)),
        cap: parseFloat(cap.toFixed(2)),
        equity,
        available
    };
}

// Per-symbol instrument-info cache (qtyStep / minOrderQty / minOrderAmt).
// Populated lazily on first use; fetched from /api/instrument-info, which
// hits Bybit's /v5/market/instruments-info on the backend with an hourly cache.
const _instrumentCache = new Map();
async function getInstrumentInfo(symbol) {
    if (!symbol) return null;
    const sym = symbol.replace('/', '').toUpperCase();
    if (_instrumentCache.has(sym)) return _instrumentCache.get(sym);
    try {
        const r = await fetch(`/api/instrument-info?symbol=${encodeURIComponent(sym)}`, bybitFetchOptions());
        const d = await r.json();
        if (!d || !d.success) return null;
        const info = {
            symbol: sym,
            qtyStep: parseFloat(d.qtyStep) || 0,
            qtyDecimals: Number.isFinite(d.qtyDecimals) ? d.qtyDecimals : 4,
            minOrderQty: parseFloat(d.minOrderQty) || 0,
            minOrderAmt: parseFloat(d.minOrderAmt) || 5
        };
        _instrumentCache.set(sym, info);
        return info;
    } catch (_) { return null; }
}

function _stepDecimals(step) {
    if (!Number.isFinite(step) || step <= 0) return 0;
    if (step >= 1) return 0;
    const s = step.toString();
    const dot = s.indexOf('.');
    return dot === -1 ? 0 : (s.length - dot - 1);
}

// Round qty DOWN to the nearest qtyStep. Bybit rejects orders whose qty
// has more decimals than the contract supports (10001), so we cannot just
// `toFixed(4)` — the contract may use 0.001 step (BTC) where 0.0001 lands
// on a non-step value. Falls back to toFixed(4) only if step info missing.
function snapQtyToStep(qty, info) {
    if (!Number.isFinite(qty) || qty <= 0) return 0;
    if (!info || !(info.qtyStep > 0)) {
        return parseFloat(qty.toFixed(4));
    }
    const decimals = _stepDecimals(info.qtyStep);
    const scale = Math.pow(10, decimals);
    const stepInt = Math.round(info.qtyStep * scale);
    const qtyInt  = Math.floor(qty * scale);
    const rounded = (qtyInt - (qtyInt % stepInt)) / scale;
    return parseFloat(rounded.toFixed(decimals));
}

// Pick the qty that satisfies Bybit's lotSizeFilter (qtyStep) AND keeps
// notional ≥ Bybit's $5 floor (or info.minOrderAmt, whichever is stricter).
// Prefers the largest qty that fits in `usdt` budget; if snap-down drops
// below the dollar floor, bumps up by one step ONLY if (qty+step)*price
// stays within `cap` (free-margin ceiling). This is the fix for the
// "AI sized $5, snapped 12 DOGE → $4.80, Bybit 110094" case where rounding
// ate the dollar floor — instead of refusing, we use 13 DOGE = $5.20 if
// the user has the headroom.
function chooseTradeQty(usdt, price, info, cap) {
    if (!Number.isFinite(usdt) || usdt <= 0 || !Number.isFinite(price) || price <= 0) {
        return { qty: 0, usdt: 0, bumped: false };
    }
    const minNotional = (info && info.minOrderAmt > 0)
        ? Math.max(info.minOrderAmt, BYBIT_MIN_NOTIONAL_USDT)
        : BYBIT_MIN_NOTIONAL_USDT;

    const baseQty = snapQtyToStep(usdt / price, info);
    const baseNotional = baseQty * price;
    if (baseNotional >= minNotional) {
        return { qty: baseQty, usdt: baseNotional, bumped: false };
    }
    // Snap-down crossed the dollar floor. Try the next step up — but only
    // if the increase over the user's intent is small. For e.g. $5 DOGE
    // snapping 12 → 13 ($4.80 → $5.20) the bump is 4% — fine. For $5 BTC
    // where the next step is $95 (a 19x jump), silent auto-bump is wrong;
    // we let validation surface the QTY_BELOW_MIN error instead so the
    // user can pick a different pair or sum explicitly.
    const step = info && info.qtyStep > 0 ? info.qtyStep : 0;
    if (step > 0) {
        const decimals = _stepDecimals(step);
        const bumpedQty = parseFloat((baseQty + step).toFixed(decimals));
        const bumpedNotional = bumpedQty * price;
        const headroom = Number.isFinite(cap) && cap > 0 ? cap : usdt * 1.5;
        const maxAcceptableBump = usdt * 1.25; // ≤25% over user's intent
        if (bumpedNotional <= headroom + 0.01 && bumpedNotional <= maxAcceptableBump + 0.01) {
            return { qty: bumpedQty, usdt: bumpedNotional, bumped: true };
        }
    }
    // No step info, cap too tight, or bump too aggressive — caller will
    // surface NOTIONAL_BELOW_MIN / QTY_BELOW_MIN with the actual minimum.
    return { qty: baseQty, usdt: baseNotional, bumped: false };
}

// Bybit USDT-perp taker fee is 0.055% per side. A round-trip (entry taker +
// TP taker, since our TP fires as Market via tpOrderType:'Market') costs
// ~0.11% of notional. If the AI proposes a TP closer to entry than that,
// hitting it gives a guaranteed net loss after fees. User explicitly asked
// to refuse such orders rather than bumping the TP. Maker entries pay 0.02%
// + 0.055% taker exit = 0.075%, but we use the stricter 0.11% taker floor
// so the trade is profitable even if our limit entry crosses the spread.
const BYBIT_TAKER_FEE_PCT = 0.055;
const ROUND_TRIP_FEE_PCT  = BYBIT_TAKER_FEE_PCT * 2; // 0.11%

function validateTpAgainstFees(entry, tp, direction) {
    if (!entry || !tp) return null; // optional TP — nothing to validate
    if (direction !== 'LONG' && direction !== 'SHORT') return null;
    const profitPct = direction === 'LONG'
        ? (tp - entry) / entry * 100
        : (entry - tp) / entry * 100;
    if (profitPct <= ROUND_TRIP_FEE_PCT) {
        const profitStr = profitPct >= 0
            ? `+${profitPct.toFixed(3)}%`
            : `${profitPct.toFixed(3)}% (TP в неправильную сторону)`;
        return {
            code: 'TP_BELOW_FEE',
            message: `AI поставил TP $${tp} — это ${profitStr} от входа $${entry}, ` +
                     `а round-trip taker fee 0.11%. После комиссии — убыток. Ордер не выставляю.`
        };
    }
    return null;
}

// Returns null if (qty, price, info) make a valid order; otherwise an
// error object { code, message } we can show to the user. Centralises the
// "your $6 won't fit BTC's 0.001 step" check so we never call /api/execute
// for orders Bybit's lotSizeFilter would reject anyway.
function validateOrderAgainstInstrument(qty, price, info) {
    // Bybit's universal USDT-perp minimum is $5 notional (retCode 110094 if
    // violated). When per-symbol info is available, info.minOrderAmt may be
    // higher — we always use the stricter of the two. When info is unavailable
    // (proxy didn't whitelist /v5/market/instruments-info, network blip, etc.),
    // we still enforce the $5 floor so the order can't sneak past validation
    // and round-trip Bybit for a 110094.
    const minNotionalAmt = (info && info.minOrderAmt > 0)
        ? Math.max(info.minOrderAmt, BYBIT_MIN_NOTIONAL_USDT)
        : BYBIT_MIN_NOTIONAL_USDT;
    const symbolLabel = info?.symbol || 'USDT-perp';

    // Treat qty<=0 the same as qty<minOrderQty when we know the instrument:
    // both happen because the user's USDT divided by price snapped below the
    // contract's qtyStep. The actionable info is the same — show the actual
    // minimum lot and dollar floor instead of a vague "Количество получилось 0".
    if (info && (qty <= 0 || (info.minOrderQty > 0 && qty < info.minOrderQty))) {
        const minNotional = price && price > 0
            ? Math.max(info.minOrderQty * price, minNotionalAmt)
            : minNotionalAmt;
        return {
            code: 'QTY_BELOW_MIN',
            message: `Минимум для ${info.symbol} — ${info.minOrderQty} (≈$${minNotional.toFixed(2)}). Открой пару подешевле (например, DOGEUSDT/ADAUSDT) или увеличь сумму.`
        };
    }
    // Hard-floor notional check runs even when info is missing — Bybit's
    // universal $5 minimum applies to every USDT-perp contract regardless.
    // This is the check that catches the user's $5 → 12 DOGE × $0.4 = $4.80
    // case where snap-down rounding ate into the dollar floor.
    if (price && price > 0) {
        const notional = qty * price;
        if (notional < minNotionalAmt) {
            return {
                code: 'NOTIONAL_BELOW_MIN',
                message: `Ноционал ордера $${notional.toFixed(2)} меньше минимума ${symbolLabel} ($${minNotionalAmt}). После округления qty вниз до шага лота сумма получилась меньше биржевого минимума — увеличь USDT.`
            };
        }
    }
    return null;
}

async function useAIRecommendation() {
    if (!currentTrade) {
        alert('Нет данных о сделке');
        return;
    }
    
    hideAllInputs();
    
    try {
        const r = await fetch('/api/balance', bybitFetchOptions());
        const d = await r.json();

        console.log('Balance response:', d);

        if (!d || !d.success) {
            alert('Не удалось получить баланс' + (d?.error ? `: ${d.error}` : ''));
            return;
        }
        const plan = planOrderUsdt(d);
        if (plan.equity <= 0) {
            alert('Bybit вернул нулевой баланс по этому аккаунту. Проверь, что прокси подключён к нужному счёту.');
            return;
        }
        if (plan.usdtAmount <= 0) {
            alert(`Свободного маржинального баланса нет (free margin $${plan.available.toFixed(2)}). Закрой какие-нибудь позиции или пополни счёт.`);
            return;
        }
        currentTrade.usdtAmount = plan.usdtAmount;

        console.log('Updated trade:', currentTrade, 'plan:', plan);

        // Heads-up if AI's $X is below the symbol's min lot — saves the user
        // from clicking "Выставить" only to see the same error after a roundtrip.
        let belowMin = null;
        if (currentTrade.pair && currentTrade.entryPrice) {
            const instr = await getInstrumentInfo(currentTrade.pair.replace('/', ''));
            const sample = snapQtyToStep(plan.usdtAmount / currentTrade.entryPrice, instr);
            belowMin = validateOrderAgainstInstrument(sample, currentTrade.entryPrice, instr);
        }

        const note = plan.wasReduced
            ? ` (урезано c $${plan.ideal.toFixed(2)} — мало free margin)`
            : '';
        document.getElementById('positionInfo').textContent = '$' + plan.usdtAmount.toFixed(2) + note;
        document.getElementById('priceInfo').textContent = currentTrade.entryPrice ? '$' + currentTrade.entryPrice.toLocaleString() : '--';

        // Surface the min-lot problem prominently in the status row (shared
        // with "Готово к исполнению") and disable the execute button so the
        // user understands they can't trade *this* pair on this account size.
        const executeBtn = document.getElementById('executeBtn');
        if (belowMin) {
            statusValueEl.textContent = '⚠ ' + belowMin.message;
            statusValueEl.className = 'status-value error';
            if (executeBtn) executeBtn.disabled = true;
        } else {
            statusValueEl.textContent = 'Готово к исполнению';
            statusValueEl.className = 'status-value ready';
            if (executeBtn) executeBtn.disabled = false;
        }
    } catch (e) {
        alert('Ошибка получения баланса: ' + e.message);
    }
}

async function executePairOrder(index) {
    const pair = portfolioPairs[index];
    if (!pair) {
        alert('Данные о сделке не найдены');
        return;
    }
    if (pair.direction !== 'LONG' && pair.direction !== 'SHORT') {
        alert(`По ${pair.pair} AI не дал направления (${pair.direction || '—'}). Ордер не выставляю.`);
        return;
    }
    if (!pair.entryPrice || pair.entryPrice <= 0) {
        alert(`По ${pair.pair} нет валидной цены входа.`);
        return;
    }

    try {
        const r = await fetch('/api/balance', bybitFetchOptions());
        const d = await r.json();

        if (!d || !d.success) {
            alert(`По ${pair.pair}: не удалось получить баланс` + (d?.error ? `: ${d.error}` : ''));
            return;
        }
        const plan = planOrderUsdt(d);
        if (plan.equity <= 0) {
            alert(`По ${pair.pair}: Bybit вернул нулевой баланс по этому аккаунту. Проверь, что прокси подключён к нужному счёту.`);
            return;
        }
        if (plan.usdtAmount <= 0) {
            alert(`По ${pair.pair}: свободного маржинального баланса нет (free margin $${plan.available.toFixed(2)}). Закрой какие-нибудь позиции или пополни счёт.`);
            return;
        }
        const usdtAmount = plan.usdtAmount;
        if (plan.wasReduced) {
            console.log(`[${pair.pair}] sizing reduced from $${plan.ideal} to $${usdtAmount} (free margin $${plan.available.toFixed(2)})`);
        }

        const symbol = pair.pair.replace('/', '');
        const instrument = await getInstrumentInfo(symbol);
        // chooseTradeQty handles snap-down crossing the $5 floor by bumping
        // to next step within plan.cap (free-margin headroom).
        const choice = chooseTradeQty(usdtAmount, pair.entryPrice, instrument, plan.cap);
        const qty = choice.qty;
        if (choice.bumped) {
            console.log(`[${pair.pair}] qty bumped to satisfy $5 floor: ${qty} (notional $${choice.usdt.toFixed(2)})`);
        }
        const preflight = validateOrderAgainstInstrument(qty, pair.entryPrice, instrument);
        if (preflight) {
            alert(`По ${pair.pair}: ${preflight.message}`);
            return;
        }

        // Refuse if AI's TP can't cover the round-trip taker fee.
        const tpCheck = validateTpAgainstFees(pair.entryPrice, pair.tp, pair.direction);
        if (tpCheck) {
            alert(`По ${pair.pair}: ${tpCheck.message}`);
            return;
        }

        const r2 = await fetch('/api/execute', bybitFetchOptions({
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                symbol: pair.pair.replace('/', ''),
                side: pair.direction === 'LONG' ? 'Buy' : 'Sell',
                qty: qty,
                price: pair.entryPrice,
                tp: pair.tp,
                sl: pair.sl
            })
        }));
        const result = await r2.json();

        if (result.success) {
            alert(`Ордер ${pair.pair} выставлен!`);
            loadBalance();
        } else {
            alert('Ошибка: ' + (result.error || 'Неизвестная ошибка'));
        }
    } catch (e) {
        alert('Ошибка: ' + e.message);
    }
}
// ============================================================================
// Theme toggle + cursor-web decorative effect
// ----------------------------------------------------------------------------

(function setupThemeToggle() {
    const btn = document.getElementById('themeToggle');
    if (!btn) return;
    btn.addEventListener('click', function () {
        const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
        const next = current === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', next);
        try { localStorage.setItem('theme', next); } catch (e) { /* private mode */ }
    });
})();

(function setupCursorVFX() {
    const canvas = document.getElementById('cursorWeb');
    if (!canvas) return;

    // Skip on small / reduced-motion. CSS already hides the canvas there;
    // we still bail early so we don't burn CPU on the RAF loop. We
    // intentionally do NOT gate on (hover: hover)/(pointer: fine): some
    // real desktop browsers report those as false (remote-desktop / VM /
    // certain Linux WMs) and we'd rather show the effect there too.
    const wideEnough = window.matchMedia('(min-width: 720px)').matches;
    const noMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const isCoarse = window.matchMedia('(pointer: coarse)').matches;
    if (!wideEnough || noMotion || isCoarse) return;

    const ctx = canvas.getContext('2d');
    let dpr = Math.max(1, window.devicePixelRatio || 1);
    let W = 0, H = 0;

    function resize() {
        dpr = Math.max(1, window.devicePixelRatio || 1);
        W = window.innerWidth;
        H = window.innerHeight;
        canvas.width = Math.floor(W * dpr);
        canvas.height = Math.floor(H * dpr);
        canvas.style.width = W + 'px';
        canvas.style.height = H + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);

    // ---- Particle network --------------------------------------------------
    // A field of slowly-drifting points. Lines are drawn between any two
    // points (or between a point and the cursor) within LINK_DIST. The cursor
    // also gently attracts nearby particles so the network "leans" toward it.
    const PARTICLE_DENSITY = 0.00008;     // particles per px^2 of viewport
    const MIN_PARTICLES = 60;
    const MAX_PARTICLES = 140;
    const LINK_DIST = 140;
    const CURSOR_LINK_DIST = 200;
    const CURSOR_PULL = 35;               // soft attraction radius (no force outside)
    const CURSOR_FORCE = 0.06;
    const SPEED = 0.22;

    function buildParticles() {
        const n = Math.min(MAX_PARTICLES, Math.max(MIN_PARTICLES, Math.round(W * H * PARTICLE_DENSITY)));
        const arr = new Array(n);
        for (let i = 0; i < n; i++) {
            arr[i] = {
                x: Math.random() * W,
                y: Math.random() * H,
                vx: (Math.random() - 0.5) * SPEED,
                vy: (Math.random() - 0.5) * SPEED,
                r: 1 + Math.random() * 1.4,
                tw: Math.random() * Math.PI * 2, // twinkle phase
            };
        }
        return arr;
    }
    let particles = buildParticles();
    window.addEventListener('resize', () => { particles = buildParticles(); });

    let mx = -9999, my = -9999;
    let cursorActive = false;
    let lastMoveAt = 0;
    window.addEventListener('mousemove', (e) => {
        mx = e.clientX; my = e.clientY;
        cursorActive = true;
        lastMoveAt = performance.now();
    });
    document.addEventListener('mouseleave', () => { cursorActive = false; });
    document.addEventListener('mouseenter', () => { cursorActive = true; });

    // Cursor "comet" trail — recent positions, fade with age.
    const trail = [];
    const TRAIL_MAX = 18;

    let phase = 0;
    function tick() {
        phase += 0.016;
        const now = performance.now();

        // Live theme color so VFX rebrand on theme toggle without reload.
        const css = getComputedStyle(document.documentElement);
        const accent = (css.getPropertyValue('--accent') || '#fff').trim();
        const isDark = (document.documentElement.getAttribute('data-theme') || 'dark') !== 'light';

        ctx.clearRect(0, 0, W, H);

        // ---- Cursor spotlight (big soft halo behind everything) -----------
        if (cursorActive && (now - lastMoveAt) < 4000) {
            const halo = ctx.createRadialGradient(mx, my, 0, mx, my, 260);
            // White on dark theme, near-black on light theme — both add a
            // visible "pool of light" without breaking the B&W palette.
            const tint = isDark ? 'rgba(255,255,255,' : 'rgba(0,0,0,';
            halo.addColorStop(0, tint + (isDark ? '0.10' : '0.06') + ')');
            halo.addColorStop(0.4, tint + (isDark ? '0.04' : '0.02') + ')');
            halo.addColorStop(1, tint + '0)');
            ctx.fillStyle = halo;
            ctx.fillRect(mx - 280, my - 280, 560, 560);
        }

        // ---- Update particles ---------------------------------------------
        for (let i = 0; i < particles.length; i++) {
            const p = particles[i];
            // Soft attraction toward cursor when close.
            if (cursorActive) {
                const dx = mx - p.x, dy = my - p.y;
                const d2 = dx * dx + dy * dy;
                const r = CURSOR_PULL * 4;
                if (d2 < r * r) {
                    const d = Math.sqrt(d2) || 0.01;
                    const f = (1 - d / r) * CURSOR_FORCE;
                    p.vx += (dx / d) * f;
                    p.vy += (dy / d) * f;
                }
            }
            p.vx *= 0.985; p.vy *= 0.985;
            p.x += p.vx; p.y += p.vy;
            p.tw += 0.04;
            // Wrap around edges so the field is seamless.
            if (p.x < -10) p.x = W + 10;
            if (p.x > W + 10) p.x = -10;
            if (p.y < -10) p.y = H + 10;
            if (p.y > H + 10) p.y = -10;
        }

        // ---- Lines between nearby particles -------------------------------
        ctx.lineWidth = 0.7;
        for (let i = 0; i < particles.length; i++) {
            const a = particles[i];
            for (let j = i + 1; j < particles.length; j++) {
                const b = particles[j];
                const dx = a.x - b.x, dy = a.y - b.y;
                const d2 = dx * dx + dy * dy;
                if (d2 < LINK_DIST * LINK_DIST) {
                    const t = 1 - Math.sqrt(d2) / LINK_DIST;
                    ctx.globalAlpha = t * (isDark ? 0.32 : 0.22);
                    ctx.strokeStyle = accent;
                    ctx.beginPath();
                    ctx.moveTo(a.x, a.y);
                    ctx.lineTo(b.x, b.y);
                    ctx.stroke();
                }
            }
        }

        // ---- Lines from cursor to nearby particles ------------------------
        if (cursorActive) {
            for (let i = 0; i < particles.length; i++) {
                const p = particles[i];
                const dx = p.x - mx, dy = p.y - my;
                const d2 = dx * dx + dy * dy;
                if (d2 < CURSOR_LINK_DIST * CURSOR_LINK_DIST) {
                    const t = 1 - Math.sqrt(d2) / CURSOR_LINK_DIST;
                    ctx.globalAlpha = t * (isDark ? 0.55 : 0.38);
                    ctx.lineWidth = 0.9;
                    ctx.strokeStyle = accent;
                    ctx.beginPath();
                    ctx.moveTo(mx, my);
                    ctx.lineTo(p.x, p.y);
                    ctx.stroke();
                }
            }
        }

        // ---- Particle dots with twinkle -----------------------------------
        ctx.globalAlpha = 1;
        for (let i = 0; i < particles.length; i++) {
            const p = particles[i];
            const tw = 0.65 + Math.sin(p.tw) * 0.3;
            ctx.globalAlpha = (isDark ? 0.85 : 0.55) * tw;
            // Glow halo
            ctx.shadowColor = accent;
            ctx.shadowBlur = 8;
            ctx.fillStyle = accent;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.shadowBlur = 0;

        // ---- Cursor comet trail -------------------------------------------
        if (cursorActive) {
            // Push a sample of the current cursor position; throttle by frame.
            trail.push({ x: mx, y: my });
            if (trail.length > TRAIL_MAX) trail.shift();
            for (let i = 1; i < trail.length; i++) {
                const a = trail[i - 1];
                const b = trail[i];
                const t = i / trail.length;
                ctx.globalAlpha = t * (isDark ? 0.55 : 0.40);
                ctx.lineWidth = 1 + t * 1.6;
                ctx.shadowColor = accent;
                ctx.shadowBlur = 10 * t;
                ctx.strokeStyle = accent;
                ctx.beginPath();
                ctx.moveTo(a.x, a.y);
                ctx.lineTo(b.x, b.y);
                ctx.stroke();
            }
            ctx.shadowBlur = 0;
        } else if (trail.length) {
            trail.length = 0;
        }

        ctx.globalAlpha = 1;
        requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
})();
