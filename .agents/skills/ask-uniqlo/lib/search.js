// `search` command: keyword search over UNIQLO KR products.
import { UqError, apiUrl, colorLabel, fetchJson, kstTimestamp, priceInfo, productUrl, requireBoundedInteger } from './core.js';

export const GENDER_PATHS = { women: '57892', men: '57893', kids: '57894', baby: '57925' };
export const SORT_CODES = { recommended: '1', 'price-asc': '2', 'price-desc': '3', rating: '4', new: '5' };

function pick(table, value, label) {
    if (value === undefined) return undefined;
    if (!Object.hasOwn(table, value)) {
        throw new UqError('ARG', `${label} must be one of: ${Object.keys(table).join(', ')}`);
    }
    return table[value];
}

export function brandOf(name) {
    return /^GU(?![A-Za-z])/.test(name ?? '') ? 'GU' : 'UNIQLO';
}

export function normalizeSearchItem(item) {
    const price = priceInfo(item.prices, item.priceGroup, item.representative?.flags?.priceFlags);
    // Search never returns the pre-markdown price; don't pass the current one off as it.
    if (price.markdownSince && !item.prices?.isDualPrice) price.originalPrice = null;
    return {
        productId: item.productId,
        priceGroup: item.priceGroup,
        name: item.name,
        brand: brandOf(item.name),
        gender: item.genderCategory ?? null,
        ...price,
        rating: item.rating ? { average: item.rating.average, count: item.rating.count } : null,
        colors: (item.colors ?? []).map(colorLabel),
        sizes: (item.sizes ?? []).map(size => size.name),
        url: productUrl(item.productId, item.priceGroup),
    };
}

export async function searchProducts(query, { limit, offset, gender, sort, sale = false, includeGu = false } = {}) {
    const q = String(query ?? '').trim();
    if (!q) throw new UqError('ARG', 'search query must not be empty');
    const size = requireBoundedInteger(limit, 20, 1, 100, 'limit');
    const start = requireBoundedInteger(offset, 0, 0, 10000, 'offset');
    const path = pick(GENDER_PATHS, gender, 'gender');
    const sortCode = pick(SORT_CODES, sort, 'sort');

    const result = await fetchJson(apiUrl('/products', {
        q, limit: size, offset: start, sort: sortCode, path, flagCodes: sale ? 'discount' : undefined,
    }));
    const all = (result.items ?? []).map(normalizeSearchItem);
    const items = all.filter(item => (includeGu || item.brand !== 'GU') && (!sale || item.discounted));
    const total = result.pagination?.total ?? all.length;

    if (items.length === 0) {
        let message = `no results for "${q}"`;
        if (all.length > 0) {
            message += ` on this page (${all.length} hidden by filters`;
            if (total > start + all.length) message += `; try --offset ${start + size}`;
            if (!includeGu) message += '; or --include-gu';
            message += ')';
        }
        throw new UqError('EMPTY', message);
    }
    return { meta: { query: q, fetchedAt: kstTimestamp(), total, offset: start, count: items.length, hidden: all.length - items.length }, items };
}
