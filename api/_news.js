// Shared crypto-news helpers for Vercel functions.
//
// Pulls fresh headlines from public crypto-news RSS feeds (no API key) so
// the AI prompt can factor in market sentiment and breaking events. The
// response is cached in-process for NEWS_TTL_MS to avoid hammering the
// upstreams on bursts of /api/analyze + /api/portfolio calls.
//
// Files in /api/ that start with `_` are NOT exposed as routes by Vercel.

// Multiple sources so a single feed going down doesn't kill the whole news
// section. Order = priority: top of the list is treated as more reliable
// when we dedupe titles.
const FEEDS = [
    { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', source: 'CoinDesk' },
    { url: 'https://cointelegraph.com/rss',                   source: 'Cointelegraph' },
    { url: 'https://decrypt.co/feed',                         source: 'Decrypt' }
];

const NEWS_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_HEADLINES = 12;
const MAX_AGE_HOURS = 36; // some feeds publish slowly on weekends
const FETCH_TIMEOUT_MS = 4000;

let cache = { expires: 0, items: [] };

// Symbols we want to highlight in headline tagging. Mirrors the supported
// trading pairs minus the USDT suffix.
const TRACKED_COINS = [
    'BTC', 'ETH', 'SOL', 'BNB', 'ADA',
    'DOGE', 'DOT', 'AVAX', 'LTC', 'LINK', 'MATIC'
];

// Common full-name → ticker hints so "Bitcoin breaks $100K" gets tagged BTC,
// not just headlines that literally say "BTC".
const COIN_NAME_HINTS = [
    [/\bbitcoin\b/i,   'BTC'],
    [/\bethereum\b/i,  'ETH'],
    [/\bsolana\b/i,    'SOL'],
    [/\bbinance\b/i,   'BNB'],
    [/\bcardano\b/i,   'ADA'],
    [/\bdogecoin\b/i,  'DOGE'],
    [/\bpolkadot\b/i,  'DOT'],
    [/\bavalanche\b/i, 'AVAX'],
    [/\blitecoin\b/i,  'LTC'],
    [/\bchainlink\b/i, 'LINK'],
    [/\bpolygon\b/i,   'MATIC']
];

// Macro keywords that move the whole market regardless of which alt the user
// is looking at — surface them first because they're high-signal context.
const MACRO_KEYWORDS = [
    'fed', 'fomc', 'cpi', 'inflation', 'rate cut', 'rate hike', 'powell',
    'sec ', 'etf', 'regulation', 'lawsuit',
    'hack', 'exploit', 'liquidation'
];

function tagsForHeadline(title) {
    const upper = (title || '').toUpperCase();
    const tags = new Set();
    for (const coin of TRACKED_COINS) {
        // Word boundary so "ADA" in "CANADA" doesn't match.
        const re = new RegExp(`\\b${coin}\\b`);
        if (re.test(upper)) tags.add(coin);
    }
    for (const [re, coin] of COIN_NAME_HINTS) {
        if (re.test(title)) tags.add(coin);
    }
    const lower = (title || '').toLowerCase();
    for (const kw of MACRO_KEYWORDS) {
        if (lower.includes(kw)) {
            tags.add('MACRO');
            break;
        }
    }
    return [...tags];
}

async function fetchText(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const r = await fetch(url, {
            signal: controller.signal,
            headers: {
                'Accept': 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
                // RSS hosts (CoinDesk in particular) reject default fetch UA
                // with a Cloudflare interstitial; supplying a browser UA gets
                // us the actual XML.
                'User-Agent': 'Mozilla/5.0 (compatible; CryptoAssistantBot/1.0)'
            }
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.text();
    } finally {
        clearTimeout(timer);
    }
}

function decodeEntities(str) {
    if (!str) return '';
    return String(str)
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
        .replace(/<[^>]+>/g, '') // strip any HTML left in titles
        .trim();
}

// Parse an RSS 2.0 feed into [{ title, publishedAt, source }]. Intentionally
// minimal — we don't need a full XML parser, just <item><title> and <pubDate>.
function parseRssFeed(xml, source) {
    if (!xml) return [];
    const items = [];
    const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRegex.exec(xml)) !== null) {
        const block = m[1];
        const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const pubMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
        if (!titleMatch) continue;
        const title = decodeEntities(titleMatch[1]);
        if (!title) continue;
        const pubRaw = pubMatch ? pubMatch[1].trim() : '';
        const pubMs = pubRaw ? Date.parse(pubRaw) : NaN;
        const publishedAt = Number.isFinite(pubMs) ? Math.floor(pubMs / 1000) : null;
        items.push({ title, publishedAt, source });
    }
    return items;
}

async function fetchFeed(feed) {
    try {
        const xml = await fetchText(feed.url, FETCH_TIMEOUT_MS);
        return parseRssFeed(xml, feed.source);
    } catch (e) {
        console.error(`news feed ${feed.source} failed:`, e.message);
        return [];
    }
}

// Returns up to MAX_HEADLINES fresh headlines aggregated from FEEDS. Never
// throws — the caller should treat an empty array as "no news available,
// skip this section".
async function fetchLatestNews() {
    const now = Date.now();
    if (cache.expires > now && cache.items.length) {
        return cache.items;
    }

    const lists = await Promise.all(FEEDS.map(fetchFeed));
    const merged = [].concat(...lists);

    const cutoff = Math.floor((now - MAX_AGE_HOURS * 60 * 60 * 1000) / 1000);

    // Dedupe by lowercased title (different sources rewrite the same story)
    // and drop anything older than MAX_AGE_HOURS.
    const seen = new Set();
    const fresh = [];
    for (const it of merged) {
        if (!it.title) continue;
        if (Number.isFinite(it.publishedAt) && it.publishedAt < cutoff) continue;
        const key = it.title.toLowerCase().slice(0, 80);
        if (seen.has(key)) continue;
        seen.add(key);
        fresh.push({
            title: it.title,
            source: it.source,
            publishedAt: it.publishedAt,
            tags: tagsForHeadline(it.title)
        });
    }

    // Newest first; items without a publish date sink to the bottom.
    fresh.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
    const items = fresh.slice(0, MAX_HEADLINES);

    if (items.length) {
        cache = { expires: now + NEWS_TTL_MS, items };
    } else {
        // Don't poison the cache with an empty result — let the next call
        // retry the upstreams. But still soft-cache for a few seconds so a
        // burst of /api/* calls doesn't all hammer the feeds at once.
        cache = { expires: now + 10_000, items: [] };
    }
    return items;
}

function relativeAge(publishedAt, nowSec = Math.floor(Date.now() / 1000)) {
    if (!Number.isFinite(publishedAt)) return '';
    const ageSec = nowSec - publishedAt;
    if (ageSec < 60) return `${ageSec}с назад`;
    const mins = Math.round(ageSec / 60);
    if (mins < 60) return `${mins}м назад`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}ч назад`;
    const days = Math.round(hrs / 24);
    return `${days}д назад`;
}

// Render the headlines as a compact, AI-friendly block. Symbols-of-interest
// (e.g. ['BTCUSDT', 'ETHUSDT']) are used to mark coin-specific items with
// a "★" so the AI knows to prioritise them.
function formatNewsBlock(items, focusSymbols = []) {
    if (!items || items.length === 0) return '';

    const focusCoins = new Set(
        focusSymbols
            .map(s => String(s || '').toUpperCase().replace(/USDT$|USDC$|USD$/, ''))
            .filter(Boolean)
    );

    const nowSec = Math.floor(Date.now() / 1000);
    const lines = items.map(it => {
        const tags = (it.tags && it.tags.length) ? `[${it.tags.join(',')}] ` : '';
        const focus = it.tags && it.tags.some(t => focusCoins.has(t)) ? '★ ' : '';
        const age = relativeAge(it.publishedAt, nowSec);
        const ageStr = age ? ` (${age})` : '';
        const source = it.source ? ` — ${it.source}` : '';
        return `- ${focus}${tags}${it.title}${source}${ageStr}`;
    });

    return lines.join('\n');
}

// Provide the AI with the current UTC date and a short list of macro/crypto
// event types it should sanity-check from its own training data. We can't
// reliably fetch a free, key-less economic calendar, so this just nudges
// the model to recall scheduled events near the current date instead of
// inventing them.
function formatUpcomingHints(nowDate = new Date()) {
    const iso = nowDate.toISOString().slice(0, 10);
    const dow = nowDate.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
    return (
        `Сегодня ${iso} (${dow}, UTC). Учти известные тебе ближайшие (в пределах 7 дней) ` +
        `макро- и крипто-события: заседания FOMC/ECB, релизы CPI/PPI/NFP, ` +
        `дедлайны SEC по ETF, разблокировки крупных токенов, плановые хардфорки/апгрейды. ` +
        `Если данных о конкретных датах ты не помнишь — явно скажи "событий не идентифицировано" ` +
        `вместо выдумок.`
    );
}

module.exports = {
    fetchLatestNews,
    formatNewsBlock,
    formatUpcomingHints
};
