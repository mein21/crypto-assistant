// Deno Deploy port of worker.js / proxy/server.js — same JSON contract:
//   POST /bybit
//     Authorization: Bearer <WORKER_AUTH_TOKEN>
//     { "endpoint": "/v5/...", "method": "GET" | "POST", "params": { ... } }
// Required env vars (set via `deployctl deploy --env-file` or Deno Deploy dashboard):
//   BYBIT_API_KEY, BYBIT_API_SECRET, WORKER_AUTH_TOKEN
// Optional:
//   TESTNET = "true" | "false" (default "false")

const TESTNET = Deno.env.get("TESTNET") === "true";
const BYBIT_API_KEY = Deno.env.get("BYBIT_API_KEY") ?? "";
const BYBIT_API_SECRET = Deno.env.get("BYBIT_API_SECRET") ?? "";
const WORKER_AUTH_TOKEN = Deno.env.get("WORKER_AUTH_TOKEN") ?? "";

const BYBIT_HOSTS = TESTNET
  ? ["https://api-testnet.bybit.com"]
  : ["https://api.bybit.com", "https://api.bytick.com", "https://api.bybitglobal.com"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function handleBybit(req: Request): Promise<Response> {
  if (WORKER_AUTH_TOKEN) {
    const auth = req.headers.get("Authorization") ?? "";
    const presented = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (presented !== WORKER_AUTH_TOKEN) {
      return new Response(
        JSON.stringify({ error: "Unauthorized: invalid or missing Bearer token" }),
        { status: 401, headers: { ...CORS, "Content-Type": "application/json" } },
      );
    }
  }

  if (!BYBIT_API_KEY || !BYBIT_API_SECRET) {
    return new Response(
      JSON.stringify({ error: "BYBIT_API_KEY / BYBIT_API_SECRET not set in Deno Deploy env." }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }

  let body: { endpoint?: string; method?: string; params?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const { endpoint, method = "GET", params = {} } = body;
  if (!endpoint || typeof endpoint !== "string") {
    return new Response(JSON.stringify({ error: "Missing required field: endpoint" }), {
      status: 400,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const timestamp = Date.now().toString();
  const recvWindow = "5000";

  let paramStr = "";
  let bodyStr = "";
  if (method === "GET") {
    const sortedKeys = Object.keys(params).sort();
    paramStr = sortedKeys.map((k) => `${k}=${(params as Record<string, unknown>)[k]}`).join("&");
  } else {
    bodyStr = JSON.stringify(params);
  }

  const signaturePayload =
    timestamp + BYBIT_API_KEY + recvWindow + (method === "GET" ? paramStr : bodyStr);
  const signature = await hmacSha256Hex(BYBIT_API_SECRET, signaturePayload);
  const queryString = paramStr ? "?" + paramStr : "";

  const headers: HeadersInit = {
    "X-BAPI-API-KEY": BYBIT_API_KEY,
    "X-BAPI-SIGN": signature,
    "X-BAPI-TIMESTAMP": timestamp,
    "X-BAPI-RECV-WINDOW": recvWindow,
    "Content-Type": "application/json",
  };

  let lastStatus = 502;
  let lastBody = "";
  for (const baseUrl of BYBIT_HOSTS) {
    try {
      const r = await fetch(baseUrl + endpoint + queryString, {
        method,
        headers,
        body: method === "GET" ? undefined : bodyStr,
      });
      const text = await r.text();
      if (r.status >= 500 || (r.status === 403 && /CloudFront|country/i.test(text))) {
        lastStatus = r.status;
        lastBody = text;
        continue;
      }
      return new Response(text, {
        status: r.status,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    } catch (e) {
      lastStatus = 502;
      lastBody = e instanceof Error ? e.message : String(e);
    }
  }
  return new Response(lastBody || JSON.stringify({ error: "All Bybit hosts failed" }), {
    status: lastStatus,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/health") {
    const region = Deno.env.get("DENO_REGION") ?? "unknown";
    return new Response(JSON.stringify({ ok: true, region }), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  if (req.method === "POST" && url.pathname === "/bybit") {
    return await handleBybit(req);
  }

  return new Response(
    JSON.stringify({
      error: `Not found: ${req.method} ${url.pathname}. Use POST /bybit or GET /health.`,
    }),
    { status: 404, headers: { ...CORS, "Content-Type": "application/json" } },
  );
});
