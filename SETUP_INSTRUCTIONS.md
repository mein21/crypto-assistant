# Настройка Cloudflare Worker как прокси для Bybit API

## Проблема
Vercel не может работать с API ключами Bybit из-за местоположения (гео-ограничения). Cloudflare Worker решает эту проблему, так как работает на глобальной сети Cloudflare.

## Быстрый старт

### 1. Деплой Cloudflare Worker

```bash
cd /home/mein/crypto-assistant

# Логин в Cloudflare (откроется браузер)
npx wrangler login

# Добавьте API ключи Bybit как секреты
npx wrangler secret put BYBIT_API_KEY
# Введите ваш API ключ

npx wrangler secret put BYBIT_API_SECRET
# Введите ваш API секрет

# Деплой воркера
npx wrangler deploy worker.js
```

После деплоя вы получите URL вида:
`https://crypto-assistant-bybit-proxy.your-account.workers.dev`

### 2. Настройка переменных окружения

Обновите `.env` файл (создайте если нет):
```bash
echo "WORKER_URL=https://crypto-assistant-bybit-proxy.your-account.workers.dev" >> .env
```

Для Vercel добавьте переменную `WORKER_URL` в настройках проекта:
- Dashboard Vercel → Settings → Environment Variables
- Add: `WORKER_URL` = `https://crypto-assistant-bybit-proxy.your-account.workers.dev`

### 3. Проверка

Тест воркера:
```bash
curl -X POST https://your-worker-url.workers.dev/bybit \
  -H "Content-Type: application/json" \
  -d '{"endpoint": "/v5/account/wallet-balance", "method": "GET", "params": {"accountType": "UNIFIED"}}'
```

Запуск локально:
```bash
npm start
```

## Как это работает

1. **Воркер** (`worker.js`) хранит API ключи в секретах Cloudflare
2. **Приложение** отправляет запросы на воркер без ключей
3. **Воркер** добавляет ключи, подписывает запрос и отправляет в Bybit
4. **Bybit** отвечает воркеру, воркер возвращает ответ приложению

## Файлы

- `worker.js` - код Cloudflare Worker
- `wrangler.toml` - конфигурация воркера
- `bybit-client.js` - обновлен для работы через воркер
- `package.json` - добавлен wrangler

## Примечание

После деплоя воркера обновите `WORKER_URL` в файле `.env.example` и `.env.local` для локальной разработки.
