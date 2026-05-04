// Crypto Strategy AI - Auto Trading Client
const API_URL = '';

const presetBtn = document.getElementById('analyzeBtn');
const tbody = document.getElementById('tbody');
const comments = document.getElementById('comments');
const loader = document.getElementById('loader');
const results = document.getElementById('results');

const balanceEl = document.getElementById('balance');
const balanceWidget = document.getElementById('balanceWidget');
const autoTradeCheckbox = document.getElementById('autoTrade');
const bybitToggle = document.getElementById('bybitEnabled');
const bybitConfig = document.getElementById('bybitConfig');
const bybitWorkerUrlInput = document.getElementById('bybitWorkerUrl');
const bybitConfigStatus = document.getElementById('bybitConfigStatus');

const BYBIT_PREF_KEY = 'bybitIntegrationEnabled';
const BYBIT_WORKER_URL_KEY = 'bybitWorkerUrl';

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
        return;
    }
    setBybitStatus('Проверяю прокси…', '');
    try {
        const r = await fetch(`${url}/health`, { method: 'GET', mode: 'cors' });
        if (r.ok) setBybitStatus('Прокси отвечает ✓', 'ok');
        else setBybitStatus(`Прокси вернул HTTP ${r.status}`, 'err');
    } catch (e) {
        setBybitStatus(`Прокси недоступен: ${e.message}`, 'err');
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
        pingBybitWorker().then(() => { if (isBybitEnabled()) loadBalance(); });
    };
    bybitWorkerUrlInput.addEventListener('change', save);
    bybitWorkerUrlInput.addEventListener('blur', save);
    bybitWorkerUrlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); bybitWorkerUrlInput.blur(); }
    });
}
if (bybitToggle) {
    bybitToggle.addEventListener('change', () => {
        localStorage.setItem(BYBIT_PREF_KEY, bybitToggle.checked ? '1' : '0');
        applyBybitVisibility();
        if (bybitToggle.checked) {
            pingBybitWorker().then(() => loadBalance());
        } else {
            balanceEl.textContent = '--';
        }
    });
}
applyBybitVisibility();
if (isBybitEnabled() && getBybitWorkerUrl()) {
    pingBybitWorker();
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
            balanceEl.textContent = d.balance.toFixed(2);
        } else {
            balanceEl.textContent = '--';
            if (d.error && bybitConfigStatus) setBybitStatus(d.error, 'err');
        }
    } catch (e) {
        console.error('Balance error:', e);
        balanceEl.textContent = '--';
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
    document.getElementById('executeBtn').style.display = 'none';
    currentTrade = null;
    
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
                const coin = t.pair ? t.pair.split('/')[0] : '';
                positionSizeEl.textContent = t.positionSize.toFixed(4) + ' ' + coin;
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
                <td>${i + 1}</td>
                <td><strong>${p.pair}</strong></td>
                <td><span class="dir ${p.direction.toLowerCase()}"><span class="dot"></span>${p.direction}</span></td>
                <td>$${p.entryPrice?.toFixed(2) || '-'}</td>
                <td>${p.tp ? '$' + p.tp.toFixed(2) : '-'}</td>
                <td>${p.sl ? '$' + p.sl.toFixed(2) : '-'}</td>
                <td>${p.confidence}%</td>
                <td>${p.reason || '-'}</td>
                <td>
                    <button class="table-btn" onclick="executePairOrder(${i})">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M5 12h14M12 5l7 7-7 7"/>
                        </svg>
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
document.addEventListener('keydown', function(e) { if (e.key === 'Enter') runAnalysis(); });

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
            
            document.getElementById('positionInfo').textContent = '$' + usdtAmount;
            document.getElementById('priceInfo').textContent = '$' + currentTrade.entryPrice.toLocaleString();
        } else {
            alert('Не удалось получить баланс');
        }
    } catch (e) {
        alert('Ошибка получения баланса: ' + e.message);
    }
}

function showExecuteButton() {
    // Execute button is now always visible in tradeActions
}

async function executePairOrder(index) {
    const pair = portfolioPairs[index];
    if (!pair) {
        alert('Данные о сделке не найдены');
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