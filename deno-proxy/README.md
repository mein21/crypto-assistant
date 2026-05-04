# Bybit proxy on Deno Deploy

Same JSON contract as `../worker.js` and `../proxy/server.js`:

```
POST /bybit
Authorization: Bearer <WORKER_AUTH_TOKEN>
{ "endpoint": "/v5/...", "method": "GET" | "POST", "params": { ... } }
```

This variant runs on Deno Deploy. No credit card required to sign up.

## Why a third proxy?

`worker.js` (Cloudflare Workers) is geo-blocked by Bybit's CloudFront on the outbound IP. Fly.io (`proxy/server.js`) and Koyeb both require a credit card. Deno Deploy is free without a card and runs in many regions, so it's the most accessible option.

If Bybit also blocks Deno Deploy's outbound IPs, fall back to `proxy/` on Fly.io / a self-hosted VPS / Cloudflare Tunnel from your own machine.

## Deploy

```bash
# 1. install deployctl
deno install -A -gf jsr:@deno/deployctl

# 2. authenticate with a token from https://dash.deno.com/account#access-tokens
export DENO_DEPLOY_TOKEN=<paste from dashboard>

# 3. set env vars (one-time, persisted on Deno Deploy)
export BYBIT_API_KEY=<your Bybit API key>
export BYBIT_API_SECRET=<your Bybit secret>
export WORKER_AUTH_TOKEN=<openssl rand -hex 32>

# 4. deploy
deployctl deploy \
  --project=crypto-assistant-bybit-proxy \
  --entrypoint=main.ts \
  --prod \
  --env=BYBIT_API_KEY \
  --env=BYBIT_API_SECRET \
  --env=WORKER_AUTH_TOKEN
```

After deploy you'll get a URL like `https://crypto-assistant-bybit-proxy.deno.dev`. Set that as `WORKER_URL` in Vercel (and use the same `WORKER_AUTH_TOKEN` value).

## Smoke test

```bash
curl -s https://crypto-assistant-bybit-proxy.deno.dev/health
# {"ok":true,"region":"<region>"}

curl -s -X POST https://crypto-assistant-bybit-proxy.deno.dev/bybit \
  -H "Authorization: Bearer $WORKER_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"endpoint":"/v5/account/wallet-balance","method":"GET","params":{"accountType":"UNIFIED"}}'
```

If `/bybit` returns a Bybit JSON (not a 403 CloudFront page), you're good.
