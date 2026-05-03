// Cloudflare Worker - Bybit API Proxy with authentication
// Deploy: wrangler deploy

export default {
  async fetch(request) {
    const url = new URL(request.url);
    
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Use POST /bybit with { endpoint, method, params }' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    const BYBIT_API_KEY = globalThis.BYBIT_API_KEY;
    const BYBIT_API_SECRET = globalThis.BYBIT_API_SECRET;
    const TESTNET = globalThis.TESTNET === 'true';
    
    if (!BYBIT_API_KEY || !BYBIT_API_SECRET) {
      return new Response(JSON.stringify({ error: 'API keys not configured in Worker environment' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    try {
      const body = await request.json();
      const { endpoint, method = 'GET', params = {} } = body;
      
      if (!endpoint) {
        return new Response(JSON.stringify({ error: 'Missing endpoint' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      
      const baseUrl = TESTNET ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
      const timestamp = Date.now().toString();
      const recvWindow = '5000';
      
      let paramStr = '';
      let bodyStr = '';
      
      if (method === 'GET') {
        const sortedKeys = Object.keys(params).sort();
        paramStr = sortedKeys.map(key => `${key}=${params[key]}`).join('&');
      } else {
        bodyStr = JSON.stringify(params);
      }
      
      const signaturePayload = timestamp + BYBIT_API_KEY + recvWindow + (method === 'GET' ? paramStr : bodyStr);
      const signature = await hmacSha256(BYBIT_API_SECRET, signaturePayload);
      
      const queryString = paramStr ? '?' + paramStr : '';
      const bybitUrl = baseUrl + endpoint + queryString;
      
      const headers = {
        'X-BAPI-API-KEY': BYBIT_API_KEY,
        'X-BAPI-SIGN': signature,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': recvWindow,
        'Content-Type': 'application/json',
      };
      
      const fetchOptions = {
        method,
        headers,
      };
      
      if (method !== 'GET' && bodyStr) {
        fetchOptions.body = bodyStr;
      }
      
      const response = await fetch(bybitUrl, fetchOptions);
      const data = await response.text();
      
      return new Response(data, {
        status: response.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
      
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
};

async function hmacSha256(secret, message) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(message);
  
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign('HMAC', key, messageData);
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
