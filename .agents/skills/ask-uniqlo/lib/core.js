// Shared HTTP + parsing helpers for the ask-uniqlo CLI. Needs only Node 18+ (built-in fetch).

export const API_BASE = 'https://www.uniqlo.com/kr/api/commerce/v5/ko';
export const SITE_BASE = 'https://www.uniqlo.com/kr/ko';
export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

// Mutable so tests can drop the delays to zero.
export const timing = { gapMs: 300, retryDelayMs: 1000, timeoutMs: 10000 };

export class UqError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'UqError';
        this.code = code; // ARG | EMPTY | NOT_FOUND | BLOCKED | NETWORK
    }
}

// ---------- validation ----------

export function requireBoundedInteger(value, defaultValue, minimum, maximum, label) {
    const number = Number(value ?? defaultValue);
    if (!Number.isInteger(number)) throw new UqError('ARG', `${label} must be an integer`);
    if (number < minimum || number > maximum) {
        throw new UqError('ARG', `${label} must be between ${minimum} and ${maximum}`);
    }
    return number;
}

export function requirePriceGroup(value) {
    const priceGroup = String(value ?? '');
    if (!/^\d{2}$/.test(priceGroup)) throw new UqError('ARG', 'price group must be two digits, e.g. 00');
    return priceGroup;
}

const PRODUCT_ID = /(?<![0-9A-Za-z])E?(\d{6})(?:-(\d{3}))?(?!\d)/i;
const URL_PRICE_GROUP = /\/products\/E\d{6}-\d{3}\/(\d{2})(?!\d)/i;

export function parseProductRef(input) {
    const text = String(input ?? '').trim();
    const match = text.match(PRODUCT_ID);
    if (!match) {
        throw new UqError('ARG', 'product must look like E450195-000, 450195, or a uniqlo.com/kr product URL');
    }
    return {
        productId: `E${match[1]}-${match[2] ?? '000'}`,
        priceGroup: text.match(URL_PRICE_GROUP)?.[1] ?? null,
    };
}

// ---------- formatting ----------

// Lookup time in Korea time, e.g. 2026-09-28T09:30:05+09:00, so reports never guess it.
export function kstTimestamp(now = new Date()) {
    return `${new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 19)}+09:00`;
}

export function productUrl(productId, priceGroup = '00') {
    return `${SITE_BASE}/products/${productId}/${priceGroup}`;
}

export function colorLabel(color) {
    return `${color.displayCode} ${color.name}`;
}

// Start date ("2026/08/27") of a "가격인하" markdown, from a product's priceFlags.
export function markdownSince(priceFlags) {
    const flag = (priceFlags ?? []).find(f => f.code === 'discount');
    if (!flag) return null;
    return flag.nameWording?.substitutions?.startDate ?? flag.name?.match(/\d{4}\/\d{2}\/\d{2}/)?.[0] ?? null;
}

// Period of a "기간한정가격" limited-time price, from a product's priceFlags.
export function limitedOffer(priceFlags) {
    const words = (priceFlags ?? []).find(f => f.code === 'limitedOffer')?.nameWording?.substitutions;
    return words ? { from: words.startDate ?? null, until: words.date ?? null } : null;
}

// `base` is the pre-markdown price only when the request asked for it (l2s with
// includePreviousPrice); elsewhere a marked-down item reports base === promo.
export function priceInfo(prices, priceGroup, priceFlags) {
    const originalPrice = prices?.base?.value ?? null;
    const promo = prices?.promo?.value ?? null;
    const promoLower = promo !== null && originalPrice !== null && promo < originalPrice;
    const since = markdownSince(priceFlags);
    const offer = limitedOffer(priceFlags);
    return {
        price: promoLower ? promo : originalPrice,
        originalPrice,
        discounted: promoLower || priceGroup !== '00' || since !== null || offer !== null,
        markdownSince: since,
        limitedOffer: offer,
    };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function stripHtml(value) {
    if (value === undefined || value === null) return null;
    const text = String(value)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name) => {
            if (name[0] === '#') {
                const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
                return String.fromCodePoint(code);
            }
            return ENTITIES[name.toLowerCase()] ?? entity;
        })
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .join('\n');
    return text || null;
}

// ---------- HTTP ----------

export function apiUrl(pathname, params = {}) {
    const url = new URL(API_BASE + pathname);
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    url.searchParams.set('httpFailure', 'true');
    return url.toString();
}

const sleep = ms => (ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve());

// Spaces request starts timing.gapMs apart, even when callers run in parallel.
let nextSlotAt = 0;
async function waitForSlot() {
    const now = Date.now();
    const at = Math.max(now, nextSlotAt);
    nextSlotAt = at + timing.gapMs;
    await sleep(at - now);
}

export async function fetchJson(url) {
    for (let attempt = 0; ; attempt++) {
        await waitForSlot();
        let response;
        try {
            response = await globalThis.fetch(url, {
                headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', 'Accept-Language': 'ko-KR,ko;q=0.9' },
                signal: AbortSignal.timeout(timing.timeoutMs),
            });
        } catch (error) {
            if (attempt === 0) {
                await sleep(timing.retryDelayMs);
                continue;
            }
            throw new UqError('NETWORK', `request failed: ${error.message} (${url})`);
        }
        if (response.status >= 500 && attempt === 0) {
            await sleep(timing.retryDelayMs);
            continue;
        }
        if (response.status === 404) throw new UqError('NOT_FOUND', `not found: ${url}`);
        if (response.status === 403) throw new UqError('BLOCKED', `blocked (HTTP 403): ${url}`);
        if (!response.ok) {
            throw new UqError(response.status >= 500 ? 'NETWORK' : 'BLOCKED', `HTTP ${response.status}: ${url}`);
        }
        let body;
        try {
            body = await response.json();
        } catch {
            throw new UqError('BLOCKED', `non-JSON response: ${url}`);
        }
        if (body?.status !== 'ok') throw new UqError('BLOCKED', `API returned status=${body?.status}: ${url}`);
        return body.result;
    }
}
