# Cloudflare Worker Proxy for Bybit API

## Problem
Vercel cannot access Bybit API from some regions due to geo-restrictions. Cloudflare Worker acts as a proxy with API keys stored securely on Cloudflare's edge.

## Setup

### 1. Install Wrangler CLI
```bash
cd /home/mein/crypto-assistant
npm install
```

### 2. Login to Cloudflare
```bash
npx wrangler login
```

### 3. Add API Keys as Secrets
```bash
npx wrangler secret put BYBIT_API_KEY
npx wrangler secret put BYBIT_API_SECRET
```

When prompted, enter your Bybit API key and secret.

### 4. Deploy Worker
```bash
npx wrangler deploy worker.js
```

After deployment, you'll get a URL like:
`https://crypto-assistant-bybit-proxy.your-subdomain.workers.dev`

### 5. Configure Vercel
Add `WORKER_URL` environment variable in Vercel:

```bash
vercel env add WORKER_URL
```

Or in Vercel dashboard: Settings → Environment Variables → Add `WORKER_URL` with your worker URL.

### 6. Update .env.local (for local development)
```bash
echo "WORKER_URL=https://crypto-assistant-bybit-proxy.your-subdomain.workers.dev" >> .env.local
```

## How it Works
1. Your Vercel app sends requests to Cloudflare Worker (no API keys needed)
2. Worker adds API keys and signs the request
3. Worker forwards request to Bybit API
4. Response is returned to your app

## Testing
Test the worker directly:
```bash
curl -X POST https://your-worker-url.workers.dev/bybit \
  -H "Content-Type: application/json" \
  -d '{"endpoint": "/v5/account/wallet-balance", "method": "GET", "params": {"accountType": "UNIFIED"}}'
```

## Files
- `worker.js` - Cloudflare Worker code
- `wrangler.toml` - Worker configuration
- `bybit-client.js` - Updated to use worker proxy
- `.env.example` - Added WORKER_URL variable
