# Local Bybit proxy + Cloudflare tunnel

Этот прокси работает у тебя на компе и через **Cloudflare Tunnel** даёт публичный URL вида `https://random-name.trycloudflare.com`. Vercel ходит на этот URL, прокси подписывает запросы твоим Bybit-API-ключом и переотправляет их на Bybit. Вызовы идут с твоего домашнего IP, который Bybit не блокирует.

## Зачем это нужно

Cloudflare Workers и Fly.io обходят гео-блок Bybit плохо (либо 403 от CloudFront, либо просят кредитку). На твоём компьютере проблем нет — Bybit доверяет твоему IP. Минус: пока компьютер выключен, баланс/торговля не работают.

## Быстрый старт (3 команды)

Нужен Node.js 20+. Если нет — скачай с https://nodejs.org и установи, default настройки.

В папке проекта:

```bash
cd proxy
npm install
node launch.mjs
```

Скрипт:
1. Спросит `BYBIT_API_KEY` и `BYBIT_API_SECRET` (вставляешь и Enter; сохраняются в `proxy/.env`, в следующий раз не спросит).
2. Скачает `cloudflared` (одноразово, ~25 МБ).
3. Запустит локальный сервер и публичный туннель.
4. Напечатает в терминал публичный URL вроде:

   ```
    ПУБЛИЧНЫЙ URL (пришли его Devin'у):
    https://random-words.trycloudflare.com
   ```

5. Скопируй URL и вставь его в поле «URL прокси» в самом приложении (включи тумблер Bybit). URL также сохранится в `proxy/tunnel-url.txt`.

Окно с туннелем не закрывай. Закрыл — баланс отвалится. Перезапустишь — URL поменяется (нужно вставить новый).

## Автостарт при включении компьютера (Linux · systemd)

Чтобы launcher сам поднимался после перезагрузки и тебе не нужно было открывать терминал:

```bash
cd proxy
npm install              # первый раз
node launch.mjs --install-service
```

Это:
1. Спросит BYBIT_API_KEY/SECRET (если их ещё нет в `.env`).
2. Запишет systemd unit-файл в `~/.config/systemd/user/crypto-assistant-proxy.service`.
3. Сделает `systemctl --user daemon-reload && systemctl --user enable --now crypto-assistant-proxy`.

После этого лаунчер живёт в фоне и стартует при логине. Чтобы он переживал и logout (включить «linger»), один раз сделай:

```bash
sudo loginctl enable-linger "$USER"
```

Полезные команды:

```bash
cat proxy/tunnel-url.txt                      # свежий публичный URL
systemctl --user status crypto-assistant-proxy
systemctl --user restart crypto-assistant-proxy   # перезапуск (новый URL!)
tail -f proxy/launcher.log                    # лог
node launch.mjs --uninstall-service           # снять юнит
```

## Фоновый режим без systemd (можно закрывать терминал, но не переживает ребут)

После первого запуска ключи сохраняются в `proxy/.env`, и launcher уже не задаёт вопросов. Поэтому его можно поднять в фоне через `nohup`:

```bash
cd proxy
nohup node launch.mjs > launcher.log 2>&1 &
cat tunnel-url.txt        # выйдет через ~10с
```

После этого можно закрывать терминал — Cloudflare-туннель и Express-прокси переживут logout. Но после ребута нужно будет запускать вручную опять.

Если запустить через `nohup`, не имея ключей в `proxy/.env`, launcher не повиснет в темноте — он сразу выйдет с подсказкой запустить один раз вручную.

## Почему `--protocol http2`

Cloudflare quick-tunnel по умолчанию пытается ходить по QUIC (UDP 7844). На многих сетях (домашние роутеры, корп-Wi-Fi, отельный, антивирусы) UDP режется — туннель всё-таки регистрируется, но через пару секунд origin отваливается, и Vercel/UI получает HTTP 530 «origin has been unregistered from Argo Tunnel». Поэтому launcher сразу запускает cloudflared с `--protocol http2` (TCP 443) — это работает везде, где вообще работает HTTPS-трафик.

## Если `systemctl --user` ругается «Failed to connect to user scope bus»

Раньше можно было увидеть `Failed to connect to user scope bus via local transport: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined` — это бывает, когда терминал стартует не из графической сессии (SSH, голый zsh, и т.п.) и переменные `XDG_RUNTIME_DIR` / `DBUS_SESSION_BUS_ADDRESS` не наследуются. Сейчас launcher для своих `systemctl --user`-вызовов сам подставляет эти переменные из `/run/user/<uid>`, поэтому отдельно их экспортить не нужно.

Если же при `--install-service` видишь ошибку `Не нахожу /run/user/<uid>` — значит у твоего пользователя сейчас вообще нет user-systemd-сессии. Включи linger (один раз), и она появится навсегда:

```bash
sudo loginctl enable-linger "$USER"
sudo systemctl start user@$(id -u).service
```

## Где взять Bybit-ключ и секрет

https://www.bybit.com → Account → API → API Management → создай ключ или скопируй существующий. Нужны права на чтение баланса/ордеров. Для торговли — на спот/фьючерсы.

## Остановить прокси

- Интерактивный режим: `Ctrl+C` в окне с запущенным `node launch.mjs`.
- `nohup`/`&`: `pkill -f 'node .*launch.mjs'` (заодно завершит `server.js` и `cloudflared` — лаунчер убирает за собой по SIGTERM).
- systemd: `systemctl --user stop crypto-assistant-proxy` или полностью снять через `node launch.mjs --uninstall-service`.

## Альтернативные сценарии (для будущего)

- **Cloudflare Workers** — `../worker.js`. Уже задеплоен в твой аккаунт, но Bybit бьёт 403 на outbound IP Cloudflare edge.
- **Fly.io** — `Dockerfile` и `fly.toml` в этой же папке. Требует кредитку при первом запуске.
- **Deno Deploy** — `../deno-proxy/`. Бесплатно, но требует ручной настройки entrypoint в их UI.
