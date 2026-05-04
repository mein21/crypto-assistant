// Cloudflare Worker - Bybit API proxy with HMAC signing.
// Secrets (set via `wrangler secret put ...`):
//   - BYBIT_API_KEY         (required)
//   - BYBIT_API_SECRET      (required)
//   - WORKER_AUTH_TOKEN     (optional but recommended; if set, callers must send
//                            `Authorization: Bearer <token>`)
// Vars (set in wrangler.toml):
//   - TESTNET = "true" | "false"
//
// API:
//   POST /bybit  with JSON { endpoint: "/v5/...", method: "GET"|"POST", params: {...} }
//   GET  /health -> { ok: true }

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return jsonResponse({ ok: true });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Use POST /bybit with { endpoint, method, params }' }, 400);
    }

    const expectedToken = env.WORKER_AUTH_TOKEN;
    if (expectedToken) {
      const authHeader = request.headers.get('Authorization') || '';
      const presented = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      if (presented !== expectedToken) {
        return jsonResponse({ error: 'Unauthorized: invalid or missing Bearer token' }, 401);
      }
    }

    const apiKey = env.BYBIT_API_KEY;
    const apiSecret = env.BYBIT_API_SECRET;
    const testnet = env.TESTNET === 'true';

    if (!apiKey || !apiSecret) {
      return jsonResponse({ error: 'BYBIT_API_KEY / BYBIT_API_SECRET не установлены в Worker. Используй `wrangler secret put`.' }, 500);
    }

    let body;
    try { body = await request.json(); }
    catch (_) { return jsonResponse({ error: 'Body must be JSON' }, 400); }

    const { endpoint, method = 'GET', params = {} } = body || {};
    if (!endpoint || typeof endpoint !== 'string') {
      return jsonResponse({ error: 'Missing required field: endpoint' }, 400);
    }

    const baseHosts = testnet
      ? ['https://api-testnet.bybit.com']
      : ['https://api.bybit.com', 'https://api.bytick.com', 'https://api.bybitglobal.com'];
    const timestamp = Date.now().toString();
    const recvWindow = '5000';

    let paramStr = '';
    let bodyStr = '';
    if (method === 'GET') {
      const sortedKeys = Object.keys(params).sort();
      paramStr = sortedKeys.map(k => `${k}=${params[k]}`).join('&');
    } else {
      bodyStr = JSON.stringify(params);
    }

    const signaturePayload = timestamp + apiKey + recvWindow + (method === 'GET' ? paramStr : bodyStr);
    const signature = await hmacSha256(apiSecret, signaturePayload);

    const queryString = paramStr ? '?' + paramStr : '';

    const headers = {
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-SIGN': signature,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': recvWindow,
      'Content-Type': 'application/json',
    };

    const fetchOptions = { method, headers };
    if (method !== 'GET' && bodyStr) fetchOptions.body = bodyStr;

    let lastResponse = null;
    let lastBody = '';
    for (const baseUrl of baseHosts) {
      try {
        const r = await fetch(baseUrl + endpoint + queryString, fetchOptions);
        const text = await r.text();
        if (r.status >= 500 || (r.status === 403 && /CloudFront|country/i.test(text))) {
          lastResponse = r;
          lastBody = text;
          continue;
        }
        return new Response(text, {
          status: r.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (e) {
        lastBody = e.message || String(e);
      }
    }
    if (lastResponse) {
      return new Response(lastBody, {
        status: lastResponse.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    return jsonResponse({ error: lastBody || 'All Bybit hosts failed' }, 502);
  }
};

async function hmacSha256(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
