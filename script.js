// Crypto Strategy AI - Auto Trading Client
const API_URL = '';

const presetBtn = document.getElementById('analyzeBtn');
const tbody = document.getElementById('tbody');
const comments = document.getElementById('comments');
const loader = document.getElementById('loader');
const results = document.getElementById('results');

const balanceEl = document.getElementById('balance');
const balanceWidget = document.getElementById('balanceWidget');
const bybitToggle = document.getElementById('bybitEnabled');
const bybitConfig = document.getElementById('bybitConfig');
const bybitWorkerUrlInput = document.getElementById('bybitWorkerUrl');
const bybitWorkerTokenInput = document.getElementById('bybitWorkerToken');
const bybitConfigStatus = document.getElementById('bybitConfigStatus');

const BYBIT_PREF_KEY = 'bybitIntegrationEnabled';
const BYBIT_WORKER_URL_KEY = 'bybitWorkerUrl';
const BYBIT_WORKER_TOKEN_KEY = 'bybitWorkerToken';

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
function getBybitWorkerToken() {
    // Same alphabet/length envelope as the Vercel-side sanitizer (api/_bybit.js).
    // Anything outside it gets dropped — we'd rather send nothing than a header
    // value that fetch() can't serialize.
    const raw = (localStorage.getItem(BYBIT_WORKER_TOKEN_KEY) || '').trim();
    if (!raw || raw.length > 256) return '';
    if (!/^[A-Za-z0-9._\-]+$/.test(raw)) return '';
    return raw;
}
function bybitFetchOptions(extra = {}) {
    const url = getBybitWorkerUrl();
    const token = getBybitWorkerToken();
    const headers = { ...(extra.headers || {}) };
    if (url) headers['X-Worker-Url'] = url;
    if (token) headers['X-Worker-Token'] = token;
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
if (bybitWorkerTokenInput) {
    bybitWorkerTokenInput.value = localStorage.getItem(BYBIT_WORKER_TOKEN_KEY) || '';
    const saveToken = () => {
        const raw = bybitWorkerTokenInput.value.trim();
        // Token alphabet matches the server-side sanitizer in api/_bybit.js.
        // Reject silently with a status hint so the user can fix it; we still
        // store the cleaned value so a refresh shows the same state.
        if (raw && (raw.length > 256 || !/^[A-Za-z0-9._\-]+$/.test(raw))) {
            setBybitStatus('Токен должен быть из A-Z, a-z, 0-9, точек, дефисов или подчёркиваний.', 'err');
            return;
        }
        localStorage.setItem(BYBIT_WORKER_TOKEN_KEY, raw);
        bybitWorkerTokenInput.value = raw;
        // If a URL is already saved, re-ping with the new token in scope so
        // the user sees confirmation that auth now works (or still doesn't).
        if (getBybitWorkerUrl()) pingBybitWorker();
    };
    bybitWorkerTokenInput.addEventListener('change', saveToken);
    bybitWorkerTokenInput.addEventListener('blur', saveToken);
    bybitWorkerTokenInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); bybitWorkerTokenInput.blur(); }
    });
}
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
        const r = await fetch('/api/balance', bybitFetchOptions());
        const d = await r.json();
        if (d.success) {
            animateNumber(balanceEl, d.balance, { decimals: 2 });
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
        const r = await fetch('/api/analyze');
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
        const r = await fetch('/api/portfolio', {method: 'POST'});
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
    tbody.innerHTML = `
      <tr><td><strong>Общее резюме</strong></td><td>${a.summary || '-'}</td></tr>
      <tr><td><strong>Сильные стороны</strong></td><td>${a.strengths || '-'}</td></tr>
      <tr><td><strong>Слабые стороны</strong></td><td>${a.weaknesses || '-'}</td></tr>
      <tr><td><strong>Рекомендации</strong></td><td>${a.suggestions || '-'}</td></tr>
      <tr><td><strong>Рекомендации по TP/SL</strong></td><td>${a.tpRecommendations || '-'}</td></tr>
    `;
    
    const positionsBody = document.getElementById('positionsBody');
    if (d.openPositions && d.openPositions.length > 0) {
      positionsBody.innerHTML = d.openPositions.map(p => {
        const price = p.tp || p.sl || '-';
        const type = p.tp ? 'TP (выше)' : (p.sl ? 'SL (ниже)' : '-');
        const chance = p.tpChance !== null ? p.tpChance + '%' : (p.slChance !== null ? p.slChance + '%' : '-');
        return `
        <tr>
          <td>${p.symbol}</td>
          <td>${p.qty.toFixed(4)}</td>
          <td>$${p.avgPrice.toFixed(2)}</td>
          <td>$${p.currentPrice.toFixed(2)}</td>
          <td>${price !== '-' ? '$' + price.toFixed(2) : '-'}</td>
          <td>${type}</td>
          <td>${chance}</td>
          <td>$${p.value.toFixed(2)}</td>
        </tr>
      `}).join('');
    } else {
      positionsBody.innerHTML = '<tr><td colspan="8">Нет открытых позиций > $1</td></tr>';
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
        
        if (currentTrade.usdtAmount && price) {
            qty = parseFloat((currentTrade.usdtAmount / price).toFixed(4));
        } else if (currentTrade.positionSize) {
            qty = currentTrade.positionSize;
        } else if (currentTrade.orderType === 'market') {
            qty = parseFloat((currentTrade.usdtAmount || 10).toFixed(4));
        } else {
            alert('Укажите сумму в USDT');
            btn.disabled = false;
            return;
        }
        
        if (!qty || qty <= 0) {
            alert('Неверное количество');
            btn.disabled = false;
            return;
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
            statusValueEl.textContent = '✅ Ордер выставлен';
            statusValueEl.className = 'status-value success';
            btn.style.display = 'none';
            loadBalance();
            alert('Ордер успешно выставлен!');
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

function showManualInput() {
    hideAllInputs();
    
    const tradeActions = document.getElementById('tradeActions');
    
    const wrap = document.createElement('div');
    wrap.className = 'manual-input-wrap';
    wrap.innerHTML = `
        <div class="manual-input">
            <label>Тип ордера</label>
            <select id="orderType" class="order-type-select">
                <option value="limit">Лимитный</option>
                <option value="market">Рыночный</option>
            </select>
        </div>
        <div class="manual-input">
            <label>USDT</label>
            <input type="number" id="manualQty" step="1" placeholder="${currentTrade?.usdtAmount?.toFixed(2) || currentTrade?.positionSize ? (currentTrade.positionSize * currentTrade.entryPrice).toFixed(2) : ''}">
        </div>
        <div class="manual-input price-input-wrap">
            <label>Цена входа</label>
            <input type="number" id="manualPrice" step="0.01" placeholder="${currentTrade?.entryPrice || ''}">
        </div>
        <button class="action-btn ai-btn" onclick="applyManualInput()">Применить</button>
    `;
    tradeActions.appendChild(wrap);
    
    document.getElementById('orderType').addEventListener('change', function() {
        const priceInput = document.getElementById('manualPrice');
        if (this.value === 'market') {
            priceInput.disabled = true;
            priceInput.placeholder = 'Рыночная';
        } else {
            priceInput.disabled = false;
            priceInput.placeholder = currentTrade?.entryPrice || '';
        }
    });
}

function applyManualInput() {
    const usdt = parseFloat(document.getElementById('manualQty').value);
    const price = parseFloat(document.getElementById('manualPrice').value);
    const orderType = document.getElementById('orderType').value;
    
    if (!usdt) {
        alert('Введите сумму в USDT');
        return;
    }
    
    if (orderType === 'limit' && !price) {
        alert('Введите цену для лимитного ордера');
        return;
    }
    
    currentTrade.usdtAmount = usdt;
    currentTrade.orderType = orderType;
    currentTrade.entryPrice = orderType === 'market' ? null : price;
    
    document.getElementById('positionInfo').textContent = '$' + usdt.toFixed(2);
    document.getElementById('priceInfo').textContent = price ? '$' + price.toLocaleString() : 'Рыночная';
    
    hideAllInputs();
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
        
        if (d.balance) {
            const balance = parseFloat(d.balance);
            const usdtAmount = parseFloat((balance * 0.1).toFixed(2));
            
            currentTrade.usdtAmount = usdtAmount;
            
            console.log('Updated trade:', currentTrade);
            
            document.getElementById('positionInfo').textContent = '$' + usdtAmount.toFixed(2);
            document.getElementById('priceInfo').textContent = currentTrade.entryPrice ? '$' + currentTrade.entryPrice.toLocaleString() : '--';
        } else {
            alert('Не удалось получить баланс');
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
        
        if (d.balance) {
            const balance = parseFloat(d.balance);
            const usdtAmount = parseFloat((balance * 0.1).toFixed(2));
            
            const qty = parseFloat((usdtAmount / pair.entryPrice).toFixed(4));
            
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
