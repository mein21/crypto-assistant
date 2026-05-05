// One-command launcher for the Bybit proxy + a public Cloudflare tunnel.
//
// First run (interactive — пишет ключи в proxy/.env):
//   cd proxy && npm install && node launch.mjs
//
// Background mode (после первого запуска, можно закрывать терминал):
//   nohup node launch.mjs > launcher.log 2>&1 &
//
// Behaviour:
//   1. Loads BYBIT_API_KEY / BYBIT_API_SECRET / WORKER_AUTH_TOKEN from
//      proxy/.env or process.env. If missing and stdin is a TTY — asks
//      interactively and persists them to proxy/.env. If missing and stdin
//      is not a TTY (e.g. nohup / & / detached) — exits with a clear hint
//      so the launcher does not silently hang.
//   2. Auto-downloads the cloudflared binary on first run.
//   3. Starts the Express server on localhost:8080 (proxy/server.js).
//   4. Opens a Cloudflare quick tunnel and prints the resulting public URL,
//      then writes it to proxy/tunnel-url.txt so a parallel `tail -f` /
//      script can read it without parsing stdout.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = resolve(HERE, ".env");
const SERVER_FILE = resolve(HERE, "server.js");
const PORT = 8080;
const DEFAULT_WORKER_AUTH_TOKEN =
  "2dca78d44cf3e74559d5ac4c0aa4b8e90e5f4aa0d900a2ad0f16a23a78f4ef74";

function loadDotEnv(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function saveDotEnv(file, vars) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
    { mode: 0o600 },
  );
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a.trim()); }));
}

const dotenvVars = loadDotEnv(ENV_FILE);
const env = { ...dotenvVars, ...process.env };
const stdinIsTTY = Boolean(process.stdin.isTTY);
const keysMissing = !env.BYBIT_API_KEY || !env.BYBIT_API_SECRET;

if (keysMissing && !stdinIsTTY) {
  console.error(
    "\nНе нашёл BYBIT_API_KEY / BYBIT_API_SECRET в proxy/.env, а stdin не интерактивный\n" +
    "(скорее всего ты запустил через nohup / `&` / в фоне).\n\n" +
    "Запусти один раз вручную, чтобы ввести ключи:\n" +
    "    cd proxy && node launch.mjs\n" +
    "После того как ключи сохранятся в proxy/.env, можно фоном:\n" +
    "    nohup node launch.mjs > launcher.log 2>&1 &\n"
  );
  process.exit(1);
}

if (!env.BYBIT_API_KEY) {
  env.BYBIT_API_KEY = await ask("BYBIT_API_KEY (вставь и Enter): ");
}
if (!env.BYBIT_API_SECRET) {
  env.BYBIT_API_SECRET = await ask("BYBIT_API_SECRET (вставь и Enter): ");
}
if (!env.WORKER_AUTH_TOKEN) {
  env.WORKER_AUTH_TOKEN = DEFAULT_WORKER_AUTH_TOKEN;
}

if (!env.BYBIT_API_KEY || !env.BYBIT_API_SECRET) {
  console.error("Нужны BYBIT_API_KEY и BYBIT_API_SECRET. Запусти ещё раз и введи их.");
  process.exit(1);
}

saveDotEnv(ENV_FILE, {
  BYBIT_API_KEY: env.BYBIT_API_KEY,
  BYBIT_API_SECRET: env.BYBIT_API_SECRET,
  WORKER_AUTH_TOKEN: env.WORKER_AUTH_TOKEN,
});
console.log(`Сохранил BYBIT_API_KEY/SECRET и WORKER_AUTH_TOKEN в ${ENV_FILE} (на будущее).`);

let cloudflared;
try {
  cloudflared = await import("cloudflared");
} catch (e) {
  console.error('Нужно сначала установить зависимости. Запусти "npm install" в папке proxy.');
  process.exit(1);
}

const { Tunnel, install, bin } = cloudflared;

if (!existsSync(bin)) {
  console.log("Качаю cloudflared (одноразово, ~25 MB)...");
  await install(bin);
  console.log("Готово.");
}

console.log(`Стартую прокси-сервер на http://localhost:${PORT} ...`);
const server = spawn(process.execPath, [SERVER_FILE], {
  cwd: HERE,
  env: {
    ...process.env,
    BYBIT_API_KEY: env.BYBIT_API_KEY,
    BYBIT_API_SECRET: env.BYBIT_API_SECRET,
    WORKER_AUTH_TOKEN: env.WORKER_AUTH_TOKEN,
    PORT: String(PORT),
  },
  stdio: "inherit",
});

server.on("exit", (code) => {
  console.error(`Прокси-сервер упал, код ${code}. Останавливаюсь.`);
  process.exit(1);
});

await new Promise((r) => setTimeout(r, 1500));

console.log("Открываю публичный Cloudflare tunnel...");
const tunnel = Tunnel.quick(`http://localhost:${PORT}`);

const URL_FILE = resolve(HERE, "tunnel-url.txt");
tunnel.once("url", (url) => {
  console.log("\n========================================");
  console.log(" ПУБЛИЧНЫЙ URL (вставь в поле «URL прокси» в UI):");
  console.log(" " + url);
  console.log("========================================\n");
  try { writeFileSync(URL_FILE, url + "\n"); } catch {/* best-effort */}
  if (stdinIsTTY) {
    console.log("Можно оставить это окно работать (Ctrl+C — остановить).");
    console.log("Чтобы запустить в фоне (и закрыть терминал) в следующий раз:");
    console.log("    nohup node launch.mjs > launcher.log 2>&1 &");
    console.log("URL также сохранён в proxy/tunnel-url.txt.");
  } else {
    console.log("Запущено в фоне. URL сохранён в proxy/tunnel-url.txt.");
    console.log("Остановить: pkill -f 'node .*launch.mjs'");
  }
});

tunnel.once("connected", (conn) => {
  console.log("Tunnel connection established:", conn?.location ?? "?");
});

tunnel.once("error", (err) => {
  console.error("Ошибка туннеля:", err);
  server.kill();
  process.exit(1);
});

tunnel.once("exit", (code) => {
  console.error(`Туннель закрылся (код ${code}).`);
  server.kill();
  process.exit(1);
});

const cleanup = () => {
  try { tunnel.stop(); } catch {/* ignore */}
  try { server.kill(); } catch {/* ignore */}
  process.exit(0);
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
