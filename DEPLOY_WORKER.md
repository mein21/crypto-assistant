# Cloudflare Worker proxy for Bybit private API

The Vercel functions in this repo cannot talk to Bybit's private API directly:
1. Vercel edges are partially geo-blocked by Bybit, and
2. Bybit secrets must never live in the browser or in a public Vercel function bundle.

So the Worker (`worker.js`) is a thin proxy: it accepts a JSON description of a Bybit request, signs it with the Bybit secret it owns, forwards it, and returns the response.

## 1. Install Wrangler CLI

```bash
cd /path/to/crypto-assistant
npm install
```

## 2. Login to Cloudflare

```bash
npx wrangler login
```

## 3. Add secrets to the Worker

```bash
npx wrangler secret put BYBIT_API_KEY
npx wrangler secret put BYBIT_API_SECRET
npx wrangler secret put WORKER_AUTH_TOKEN   # any random string, e.g. `openssl rand -hex 32`
```

`WORKER_AUTH_TOKEN` is **strongly recommended** — without it, anyone who learns the worker URL can place orders on your Bybit account.

## 4. Deploy

```bash
npx wrangler deploy
```

Wrangler prints the URL, something like:
```
https://crypto-assistant-bybit-proxy.<your-subdomain>.workers.dev
```

## 5. Add the same values to Vercel

In Vercel → project `dd` → Settings → Environment Variables:

| Name                 | Value                                                       | Environments              |
|----------------------|-------------------------------------------------------------|---------------------------|
| `WORKER_URL`         | the URL printed by `wrangler deploy`                        | Production, Preview, Dev  |
| `WORKER_AUTH_TOKEN`  | the same random string you saved as a Worker secret         | Production, Preview, Dev  |
| `OPENROUTER_API_KEY` | your OpenRouter key                                         | Production, Preview, Dev  |

Then **Redeploy** the project (Deployments → … → Redeploy, uncheck "Use existing Build Cache").

## 6. How requests flow

```
Browser → Vercel /api/balance (and friends)
       → POST https://<worker-url>/bybit
         Authorization: Bearer <WORKER_AUTH_TOKEN>
         { endpoint: "/v5/account/wallet-balance", method: "GET", params: {...} }
       → Worker signs with BYBIT_API_SECRET
       → Bybit
       → Worker returns body verbatim
       → Vercel function parses, returns JSON to browser.
```

## 7. Smoke test

```bash
curl -s https://<worker-url>/health
# {"ok":true}

curl -s -X POST https://<worker-url>/bybit \
  -H "Authorization: Bearer $WORKER_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"endpoint":"/v5/account/wallet-balance","method":"GET","params":{"accountType":"UNIFIED"}}'
```

If `WORKER_AUTH_TOKEN` is set on the Worker but missing from the request, the Worker replies with `401 Unauthorized`.

## Files

- `worker.js`        – Cloudflare Worker source
- `wrangler.toml`    – Worker configuration
- `api/_bybit.js`    – Vercel-side helper that talks to the Worker
- `api/balance.js`, `api/pending.js`, `api/execute.js`, `api/execute-market.js`,
  `api/portfolio/analyze.js`, `api/portfolio/close.js` – Vercel routes that use the helper.
