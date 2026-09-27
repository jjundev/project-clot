// `detail` command: product details + per-color/size online stock + size chart.
import {
    UqError, apiUrl, colorLabel, fetchJson, kstTimestamp, parseProductRef, priceInfo, productUrl, requirePriceGroup, stripHtml,
} from './core.js';

// `productIds=` lookups only return group 00, so other groups are found by probing.
export const PRICE_GROUPS = ['00', '01', '02', '03'];
const STOCK_BUCKETS = { IN_STOCK: 'inStock', LOW_STOCK: 'lowStock' };

async function findPriceGroups(productId, only) {
    const found = await Promise.all((only ? [only] : PRICE_GROUPS).map(async priceGroup => {
        try {
            return { priceGroup, details: await fetchJson(apiUrl(`/products/${productId}/price-groups/${priceGroup}/details`)) };
        } catch (error) {
            if (error.code === 'NOT_FOUND') return null;
            throw error;
        }
    }));
    const groups = found.filter(Boolean);
    if (groups.length === 0) {
        throw new UqError('NOT_FOUND', `product ${productId} not found${only ? ` in price group ${only}` : ''}`);
    }
    return groups;
}

function measurementText(measurements = []) {
    const measurement = measurements.find(m => m.unit === 'cm') ?? measurements[0];
    return measurement ? `${measurement.value}${measurement.unit ?? ''}` : null;
}

// Labels such as "숄더 스트랩 길이<br>(최대)" carry markup; keep them on one line.
const label = text => stripHtml(text)?.replace(/\n/g, ' ') ?? String(text ?? '');

function sizeTable(rows) {
    if (!rows?.length) return null;
    return Object.fromEntries(rows.map(row => [
        label(row.name),
        Object.fromEntries((row.sizeParts ?? []).map(part => [label(part.name), measurementText(part.measurements)])),
    ]));
}

export function normalizeSizeChart(entry) {
    const garment = sizeTable(entry?.sizeChart);
    const body = sizeTable(entry?.bodyMeasurements);
    return garment || body ? { garment, body } : null;
}

async function fetchSizeChart(productId) {
    try {
        const result = await fetchJson(apiUrl('/products/size-charts', {
            productIdsWithColorCode: productId,
            includeBodyMeasurements: 'true',
        }));
        return normalizeSizeChart(Array.isArray(result) ? result[0] : null);
    } catch (error) {
        if (error.code === 'NOT_FOUND') return null;
        throw error;
    }
}

function variantRows(details, stockPayload, priceGroup) {
    const colors = details.colors ?? [];
    const sizes = details.sizes ?? [];
    const colorIndex = new Map(colors.map((color, i) => [color.displayCode, i]));
    const sizeIndex = new Map(sizes.map((size, i) => [size.displayCode, i]));
    const colorNames = new Map(colors.map(color => [color.displayCode, colorLabel(color)]));
    const sizeNames = new Map(sizes.map(size => [size.displayCode, size.name]));
    const lengthNames = new Map((details.plds ?? []).filter(p => p.display?.showFlag).map(p => [p.displayCode, p.name]));
    const rank = (index, key) => index.get(key) ?? Number.MAX_SAFE_INTEGER;

    return [...(stockPayload.l2s ?? [])]
        .sort((a, b) => rank(colorIndex, a.color.displayCode) - rank(colorIndex, b.color.displayCode)
            || rank(sizeIndex, a.size.displayCode) - rank(sizeIndex, b.size.displayCode)
            || String(a.pld?.displayCode).localeCompare(String(b.pld?.displayCode)))
        .map(l2 => {
            const stock = stockPayload.stocks?.[l2.l2Id];
            const sizeName = sizeNames.get(l2.size.displayCode) ?? l2.size.displayCode;
            const length = lengthNames.get(l2.pld?.displayCode);
            return {
                color: colorNames.get(l2.color.displayCode) ?? l2.color.displayCode,
                size: length ? `${sizeName} (${length})` : sizeName,
                l2Id: l2.l2Id,
                communicationCode: l2.communicationCode ?? null,
                status: stock?.statusCode ?? null,
                quantity: stock?.quantity ?? null,
                price: priceInfo(stockPayload.prices?.[l2.l2Id], priceGroup).price,
            };
        });
}

export function summarizeStock(variants) {
    const stock = {};
    for (const variant of variants) {
        stock[variant.color] ??= { inStock: [], lowStock: [], soldOut: [] };
        const bucket = Object.hasOwn(STOCK_BUCKETS, variant.status ?? '') ? STOCK_BUCKETS[variant.status] : 'soldOut';
        stock[variant.color][bucket].push(variant.size);
    }
    return stock;
}

export async function getProductDetail(ref, { priceGroup, raw = false } = {}) {
    const parsed = parseProductRef(ref);
    const only = priceGroup !== undefined ? requirePriceGroup(priceGroup) : parsed.priceGroup;
    const { productId } = parsed;

    const groups = await findPriceGroups(productId, only);
    const [stockPayloads, sizeChart] = await Promise.all([
        Promise.all(groups.map(group => fetchJson(apiUrl(`/products/${productId}/price-groups/${group.priceGroup}/l2s`, {
            withPrices: 'true',
            withStocks: 'true',
        })))),
        fetchSizeChart(productId),
    ]);

    const base = groups[0].details;
    const crumbs = base.breadcrumbs ?? {};
    const mainImages = base.images?.main ?? {};
    const representative = base.representative?.color?.displayCode;
    const rating = base.rating;

    return {
        productId,
        fetchedAt: kstTimestamp(),
        name: base.name,
        gender: base.genderCategory ?? null,
        category: ['gender', 'class', 'category', 'subcategory'].map(key => crumbs[key]?.locale).filter(Boolean).join(' > ') || null,
        rating: rating
            ? { average: rating.average, count: rating.count, fit: rating.fit ?? null, distribution: rating.rateCount ?? null }
            : null,
        priceGroups: groups.map((group, i) => {
            const variants = variantRows(group.details, stockPayloads[i], group.priceGroup);
            const stock = summarizeStock(variants);
            return {
                priceGroup: group.priceGroup,
                ...priceInfo(group.details.prices, group.priceGroup),
                // A cheaper group whose every size is sold out is not a price anyone can buy at.
                available: Object.values(stock).some(color => color.inStock.length + color.lowStock.length > 0),
                url: productUrl(productId, group.priceGroup),
                stock,
                ...(raw ? { variants } : {}),
            };
        }),
        sizeChart,
        material: stripHtml(base.composition),
        washing: stripHtml(base.washingInformation),
        care: stripHtml(base.careInstruction),
        notes: stripHtml(base.freeInformation),
        description: stripHtml(base.longDescription),
        origin: (base.countriesOfOrigin ?? []).map(country => country.code),
        manufacturingDate: base.manufacturingDate?.localizedDate || null,
        image: mainImages[representative]?.image ?? Object.values(mainImages)[0]?.image ?? null,
        url: productUrl(productId, groups[0].priceGroup),
    };
}
