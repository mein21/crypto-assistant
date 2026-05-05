// One-command launcher for the Bybit proxy + a public Cloudflare tunnel.
//
// First run (interactive — пишет ключи в proxy/.env):
//   cd proxy && npm install && node launch.mjs
//
// Background mode (после первого запуска, можно закрывать терминал):
//   nohup node launch.mjs > launcher.log 2>&1 &
//
// Auto-start on login/boot (Linux, systemd):
//   node launch.mjs --install-service     # ставит systemd --user unit и стартует его
//   node launch.mjs --uninstall-service   # снимает unit
//
// Behaviour:
//   1. Loads BYBIT_API_KEY / BYBIT_API_SECRET / WORKER_AUTH_TOKEN from
//      proxy/.env or process.env. If missing and stdin is a TTY — asks
//      interactively and persists them to proxy/.env. If missing and stdin
//      is not a TTY (e.g. nohup / & / detached) — exits with a clear hint
//      so the launcher does not silently hang.
//   2. Auto-downloads the cloudflared binary on first run.
//   3. Starts the Express server on localhost:8080 (proxy/server.js).
//   4. Spawns cloudflared с --protocol http2 (а не QUIC) — на сетях, где
//      режут UDP 7844 (домашние роутеры, корп-Wi-Fi, антивирусы), QUIC-туннель
//      «origin unregistered from Argo Tunnel» отваливается через минуту.
//   5. Парсит stdout cloudflared, печатает публичный URL и пишет его в
//      proxy/tunnel-url.txt — UI читает оттуда без необходимости копаться в логе.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = resolve(HERE, ".env");
const SERVER_FILE = resolve(HERE, "server.js");
const URL_FILE = resolve(HERE, "tunnel-url.txt");
const LAUNCH_FILE = resolve(HERE, "launch.mjs");
const LOG_FILE = resolve(HERE, "launcher.log");
const PORT = 8080;
const DEFAULT_WORKER_AUTH_TOKEN =
  "2dca78d44cf3e74559d5ac4c0aa4b8e90e5f4aa0d900a2ad0f16a23a78f4ef74";

const SERVICE_NAME = "crypto-assistant-proxy";
const SERVICE_UNIT_DIR = resolve(homedir(), ".config/systemd/user");
const SERVICE_UNIT_FILE = resolve(SERVICE_UNIT_DIR, `${SERVICE_NAME}.service`);

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

const args = process.argv.slice(2);
const mode = args.includes("--install-service")
  ? "install"
  : args.includes("--uninstall-service")
  ? "uninstall"
  : "run";

const dotenvVars = loadDotEnv(ENV_FILE);
const env = { ...dotenvVars, ...process.env };
const stdinIsTTY = Boolean(process.stdin.isTTY);
const keysMissing = !env.BYBIT_API_KEY || !env.BYBIT_API_SECRET;

if (mode === "uninstall") {
  await uninstallSystemdService();
  process.exit(0);
}

if (mode !== "install" && keysMissing && !stdinIsTTY) {
  console.error(
    "\nНе нашёл BYBIT_API_KEY / BYBIT_API_SECRET в proxy/.env, а stdin не интерактивный\n" +
    "(скорее всего ты запустил через nohup / `&` / в фоне / systemd).\n\n" +
    "Запусти один раз вручную, чтобы ввести ключи:\n" +
    "    cd proxy && node launch.mjs\n" +
    "После того как ключи сохранятся в proxy/.env, можно фоном:\n" +
    "    nohup node launch.mjs > launcher.log 2>&1 &\n" +
    "или одной командой поставить как systemd-юнит:\n" +
    "    node launch.mjs --install-service\n"
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

if (mode === "install") {
  await installSystemdService();
  process.exit(0);
}

let cloudflared;
try {
  cloudflared = await import("cloudflared");
} catch (e) {
  console.error('Нужно сначала установить зависимости. Запусти "npm install" в папке proxy.');
  process.exit(1);
}

const { install, bin } = cloudflared;

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
  try { tunnel?.kill(); } catch {/* ignore */}
  process.exit(1);
});

await new Promise((r) => setTimeout(r, 1500));

console.log("Открываю публичный Cloudflare tunnel (--protocol http2, обход QUIC)...");
const tunnelArgs = [
  "tunnel",
  "--no-autoupdate",
  "--protocol", "http2",
  "--url", `http://localhost:${PORT}`,
];
const tunnel = spawn(bin, tunnelArgs, {
  cwd: HERE,
  stdio: ["ignore", "pipe", "pipe"],
});

const urlRe = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
let urlPrinted = false;
const onCfChunk = (buf) => {
  const text = buf.toString();
  process.stdout.write(text);
  if (urlPrinted) return;
  const m = text.match(urlRe);
  if (m) {
    urlPrinted = true;
    onUrl(m[0]);
  }
};
tunnel.stdout.on("data", onCfChunk);
tunnel.stderr.on("data", onCfChunk);

tunnel.on("exit", (code) => {
  console.error(`cloudflared закрылся (код ${code}).`);
  try { server.kill(); } catch {/* ignore */}
  process.exit(code ?? 1);
});

function onUrl(url) {
  console.log("\n========================================");
  console.log(" ПУБЛИЧНЫЙ URL (вставь в поле «URL прокси» в UI):");
  console.log(" " + url);
  console.log("========================================\n");
  try { writeFileSync(URL_FILE, url + "\n"); } catch {/* best-effort */}
  if (stdinIsTTY) {
    console.log("Можно оставить это окно работать (Ctrl+C — остановить).");
    console.log("Чтобы запустить в фоне (и закрыть терминал) в следующий раз:");
    console.log("    nohup node launch.mjs > launcher.log 2>&1 &");
    console.log("Чтобы launcher запускался при включении компа автоматически:");
    console.log("    node launch.mjs --install-service");
    console.log("URL также сохранён в proxy/tunnel-url.txt.");
  } else {
    console.log("Запущено в фоне. URL сохранён в proxy/tunnel-url.txt.");
    console.log("Остановить: pkill -f 'node .*launch.mjs'");
  }
}

const cleanup = () => {
  try { tunnel.kill(); } catch {/* ignore */}
  try { server.kill(); } catch {/* ignore */}
  process.exit(0);
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

// ---------------------------------------------------------------------------
// systemd --user service helpers
// ---------------------------------------------------------------------------

function buildSystemdUnit() {
  const node = process.execPath;
  return `[Unit]
Description=Crypto Assistant Bybit proxy + Cloudflare tunnel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${HERE}
ExecStart=${node} ${LAUNCH_FILE}
Restart=on-failure
RestartSec=5
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}

[Install]
WantedBy=default.target
`;
}

function runSystemctl(...sysArgs) {
  const r = spawnSync("systemctl", sysArgs, { stdio: "inherit" });
  return r.status === 0;
}

async function installSystemdService() {
  if (process.platform !== "linux") {
    console.error(
      `--install-service пока поддерживает только Linux + systemd (у тебя platform=${process.platform}).`,
    );
    process.exit(1);
  }
  mkdirSync(SERVICE_UNIT_DIR, { recursive: true });
  writeFileSync(SERVICE_UNIT_FILE, buildSystemdUnit());
  console.log(`Записал systemd-юнит: ${SERVICE_UNIT_FILE}`);

  console.log("Перечитываю systemd...");
  if (!runSystemctl("--user", "daemon-reload")) {
    console.error("systemctl --user daemon-reload упал — посмотри сообщение выше.");
    process.exit(1);
  }
  console.log(`Включаю и стартую ${SERVICE_NAME}...`);
  if (!runSystemctl("--user", "enable", "--now", SERVICE_NAME)) {
    console.error(`systemctl --user enable --now ${SERVICE_NAME} упал.`);
    process.exit(1);
  }

  console.log("\nГотово. Чтобы launcher переживал logout/выключение:");
  console.log(`    sudo loginctl enable-linger ${process.env.USER ?? "$USER"}`);
  console.log("\nКоманды на каждый день:");
  console.log(`    systemctl --user status ${SERVICE_NAME}    # статус`);
  console.log(`    systemctl --user restart ${SERVICE_NAME}   # перезапустить (новый URL)`);
  console.log(`    cat ${URL_FILE}    # свежий публичный URL`);
  console.log(`    tail -f ${LOG_FILE}    # лог`);
  console.log("\nПодожди ~10 секунд и смотри URL:");
  console.log(`    cat ${URL_FILE}`);
}

async function uninstallSystemdService() {
  if (process.platform !== "linux") {
    console.error(`--uninstall-service пока только для Linux + systemd.`);
    process.exit(1);
  }
  console.log(`Останавливаю и снимаю ${SERVICE_NAME}...`);
  spawnSync("systemctl", ["--user", "disable", "--now", SERVICE_NAME], { stdio: "inherit" });
  if (existsSync(SERVICE_UNIT_FILE)) {
    spawnSync("rm", ["-f", SERVICE_UNIT_FILE], { stdio: "inherit" });
    console.log(`Удалил ${SERVICE_UNIT_FILE}`);
  }
  spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  console.log("Готово.");
}
