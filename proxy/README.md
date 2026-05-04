# Bybit proxy on Fly.io

Same logic as `../worker.js`, but runs on Fly.io instead of Cloudflare Workers, because Cloudflare's outbound IPs are blocked by Bybit's CloudFront with `403 Forbidden for your country`.

## Why two proxies?

Both files implement the same JSON contract:

```
POST /bybit
Authorization: Bearer <WORKER_AUTH_TOKEN>
{ "endpoint": "/v5/...", "method": "GET" | "POST", "params": { ... } }
```

`worker.js` is faster and free, but only works if Bybit isn't blocking the Cloudflare edge near you. `proxy/server.js` runs on a Fly.io machine in a region you control (default `sin` = Singapore).

The Vercel functions (`api/balance.js`, `api/portfolio/analyze.js`, ...) call whatever URL is in the `WORKER_URL` env var — point it at whichever proxy works for you.

## First-time deploy

```bash
cd proxy
fly auth login                              # opens browser
fly launch --no-deploy                      # creates the Fly app + reads fly.toml
fly secrets set BYBIT_API_KEY=...           # paste your Bybit key
fly secrets set BYBIT_API_SECRET=...        # paste your Bybit secret
fly secrets set WORKER_AUTH_TOKEN="$(openssl rand -hex 32)"
fly deploy
```

After deploy, `fly status` will print the public URL, e.g. `https://crypto-assistant-bybit-proxy-fly.fly.dev`.

## Re-point Vercel

In Vercel → project `dd` → Settings → Environment Variables:
- `WORKER_URL` → set to the Fly URL from above.
- `WORKER_AUTH_TOKEN` → use the same value you set with `fly secrets set`.

Then redeploy from Vercel Dashboard.

## Smoke test

```bash
curl -s https://crypto-assistant-bybit-proxy-fly.fly.dev/health
# {"ok":true,"region":"sin"}

curl -s -X POST https://crypto-assistant-bybit-proxy-fly.fly.dev/bybit \
  -H "Authorization: Bearer $WORKER_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"endpoint":"/v5/account/wallet-balance","method":"GET","params":{"accountType":"UNIFIED"}}'
```

If `/health` returns `region: "sin"` and `/bybit` returns a Bybit JSON (not a 403 CloudFront page), you're good.

## Region change

Singapore is the default. Frankfurt (`fra`), Tokyo (`hnd`), Sydney (`syd`), Mumbai (`bom`) are also fine. Edit `primary_region` in `fly.toml`, then `fly deploy`.

## Costs

Fly.io free tier covers a single `shared-cpu-1x@256mb` machine that auto-stops when idle. This proxy fits comfortably inside that. Cold start is ~1s.
