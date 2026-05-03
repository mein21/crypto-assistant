// Bybit API Client - V5 SPOT & FUTURES Trading
// Supports Cloudflare Worker Proxy (recommended for Vercel) or direct API calls
const crypto = require('crypto');

class BybitClient {
    constructor(apiKey, apiSecret, testnet = false) {
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.testnet = testnet;
        this.baseUrl = testnet 
            ? 'https://api-testnet.bybit.com' 
            : 'https://api.bybit.com';
        // Use worker proxy if WORKER_URL is set (recommended for Vercel)
        this.workerUrl = process.env.WORKER_URL || '';
    }

    async request(method, endpoint, params = {}) {
        // Use Cloudflare Worker proxy if configured
        if (this.workerUrl) {
            return this.requestViaWorker(method, endpoint, params);
        }
        // Fallback to direct API calls (requires API keys)
        return this.requestDirect(method, endpoint, params);
    }

    async requestViaWorker(method, endpoint, params = {}) {
        try {
            const response = await fetch(this.workerUrl + '/bybit', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    endpoint,
                    method,
                    params
                })
            });
            
            const data = await response.json();
            
            if (data.retCode !== 0 && data.retCode !== undefined) {
                throw new Error(`${data.retCode}: ${data.retMsg}`);
            }
            return data;
        } catch (e) {
            console.error('Bybit Worker error:', e.message);
            throw e;
        }
    }

    async requestDirect(method, endpoint, params = {}) {
        const timestamp = Date.now().toString();
        const recvWindow = '5000';
        
        let paramStr = '';
        let body = '';
        
        if (method === 'GET') {
            const sortedKeys = Object.keys(params).sort();
            paramStr = sortedKeys.map(key => `${key}=${params[key]}`).join('&');
            if (paramStr) paramStr = '?' + paramStr;
        } else {
            body = JSON.stringify(params);
        }
        
        const signaturePayload = timestamp + this.apiKey + recvWindow + (method === 'GET' ? paramStr.replace('?', '') : body);
        const signature = crypto.createHmac('sha256', this.apiSecret).update(signaturePayload).digest('hex');
        
        const url = `${this.baseUrl}${endpoint}${paramStr}`;
        
        const options = {
            method,
            headers: {
                'X-BAPI-API-KEY': this.apiKey,
                'X-BAPI-SIGN': signature,
                'X-BAPI-TIMESTAMP': timestamp,
                'X-BAPI-RECV-WINDOW': recvWindow,
                'Content-Type': 'application/json'
            }
        };
        
        if (method !== 'GET' && body) options.body = body;
        
        try {
            const response = await fetch(url, options);
            const data = await response.json();
            
            if (data.retCode !== 0 && data.retCode !== undefined) {
                throw new Error(`${data.retCode}: ${data.retMsg}`);
            }
            return data;
        } catch (e) {
            console.error('Bybit error:', e.message);
            throw e;
        }
    }

    // === SPOT Trading ===
    async getUSDTBalance() {
        try {
            const data = await this.request('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
            const coins = data.result?.list?.[0]?.coin || [];
            const usdt = coins.find(c => c.coin === 'USDT');
            return usdt ? parseFloat(usdt.walletBalance) : 0;
        } catch (e) { 
            console.error('Balance error:', e.message);
            return 0; 
        }
    }

    async getAllCoins() {
        try {
            const data = await this.request('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
            const coins = data.result?.list?.[0]?.coin || [];
            const result = {};
            for (const c of coins) {
                const available = parseFloat(c.availableToWithdraw) || 0;
                const wallet = parseFloat(c.walletBalance) || 0;
                const equity = parseFloat(c.equity) || 0;
                const qty = available > 0 ? available : (wallet > 0 ? wallet : equity);
                if (qty > 0) {
                    result[c.coin] = qty;
                }
            }
            return result;
        } catch (e) { return {}; }
    }

    async placeSpotOrder(symbol, side, orderType, qty, price = null, tp = null, sl = null) {
        const params = {
            category: 'spot',
            symbol: symbol,
            side: side,
            orderType: orderType,
            qty: String(qty)
        };
        
        if (price && orderType === 'Limit') {
            params.price = String(price);
            params.timeInForce = 'GTC';
        }
        
        if (tp || sl) {
            params.orderFilter = 'tpslOrder';
            if (tp) params.takeProfit = String(tp);
            if (sl) params.stopLoss = String(sl);
        }
        
        return this.request('POST', '/v5/order/create', params);
    }

    async placeSpotLimitOrder(symbol, side, qty, price) {
        return this.placeSpotOrder(symbol, side, 'Limit', qty, price);
    }

    async placeLimitOrder(symbol, side, qty, price) {
        return this.placeSpotLimitOrder(symbol, side, qty, price);
    }

    // === FUTURES Trading (USDT derivatives) ===
    async getFuturesBalance() {
        try {
            const data = await this.request('GET', '/v5/position/closed-pnl', {
                category: 'linear',
                symbol: 'BTCUSDT'
            });
            return data.result?.list || [];
        } catch (e) { return []; }
    }

    async placeFuturesOrder(symbol, side, qty, price = null, tp = null, sl = null) {
        const params = {
            category: 'linear',
            symbol: symbol,
            side: side,
            orderType: price ? 'Limit' : 'Market',
            qty: String(qty),
            timeInForce: 'GTC'
        };
        
        if (price) params.price = String(price);
        
        if (tp) {
            params.takeProfit = {
                triggerPrice: String(tp),
                triggerBy: 'LastPrice'
            };
        }
        
        if (sl) {
            params.stopLoss = {
                triggerPrice: String(sl),
                triggerBy: 'LastPrice'
            };
        }
        
        return this.request('POST', '/v5/order/create', params);
    }

    async placeLongFutures(symbol, qty, price = null, tp = null, sl = null) {
        return this.placeFuturesOrder(symbol, 'Buy', qty, price, tp, sl);
    }

    async placeShortFutures(symbol, qty, price = null, tp = null, sl = null) {
        return this.placeFuturesOrder(symbol, 'Sell', qty, price, tp, sl);
    }

    async getOpenOrders(category = 'spot') {
        return this.request('GET', '/v5/order/realtime', { category, openOnly: 1 });
    }

    async cancelOrder(orderId, symbol, category = 'spot') {
        return this.request('POST', '/v5/order/cancel', {
            category,
            symbol,
            orderId
        });
    }

    async getAllPrices() {
        const data = await this.request('GET', '/v5/market/tickers', { category: 'spot' });
        const prices = {};
        for (const t of data.result?.list || []) {
            if (t.symbol.endsWith('USDT')) {
                prices[t.symbol] = parseFloat(t.lastPrice);
            }
        }
        return prices;
    }

    async getPositionHistory() {
        try {
            const data = await this.request('GET', '/v5/position/closed-pnl', {
                category: 'spot',
                limit: 100
            });
            return data.result?.list || [];
        } catch (e) { return []; }
    }

    async getOrderHistory() {
        try {
            const data = await this.request('GET', '/v5/order/history', {
                category: 'spot',
                limit: 100
            });
            return data.result?.list || [];
        } catch (e) { return []; }
    }
}

module.exports = { BybitClient };
