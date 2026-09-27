import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ok, stubFetch, restoreFetch } from './helpers.mjs';
import { brandOf, searchProducts } from '../lib/search.js';

afterEach(restoreFetch);

function item(overrides = {}) {
    return {
        productId: 'E450195-000',
        priceGroup: '00',
        name: '후리스풀집재킷',
        genderCategory: 'UNISEX',
        prices: { base: { value: 39900 }, promo: null },
        rating: { average: 4.7, count: 996 },
        colors: [{ displayCode: '09', name: 'BLACK' }, { displayCode: '69', name: 'NAVY' }],
        sizes: [{ name: 'S' }, { name: 'M' }],
        ...overrides,
    };
}

const page = (items, total = items.length) => ok({ items, pagination: { total, offset: 0, count: items.length } });

test('search builds the query URL from options', async () => {
    const calls = stubFetch(() => page([item()]));
    await searchProducts('후리스', { limit: '10', offset: '20', gender: 'men', sort: 'price-asc' });
    const url = calls[0].url;
    assert.equal(url.pathname, '/kr/api/commerce/v5/ko/products');
    assert.equal(url.searchParams.get('q'), '후리스');
    assert.equal(url.searchParams.get('limit'), '10');
    assert.equal(url.searchParams.get('offset'), '20');
    assert.equal(url.searchParams.get('path'), '57893');
    assert.equal(url.searchParams.get('sort'), '2');
});

test('search omits sort and path by default and uses limit 20', async () => {
    const calls = stubFetch(() => page([item()]));
    await searchProducts('후리스');
    assert.equal(calls[0].url.searchParams.has('sort'), false);
    assert.equal(calls[0].url.searchParams.has('path'), false);
    assert.equal(calls[0].url.searchParams.get('limit'), '20');
});

test('search normalizes items and reports meta', async () => {
    stubFetch(() => page([item()], 36));
    const out = await searchProducts('후리스');
    const { fetchedAt, ...meta } = out.meta;
    assert.match(fetchedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/);
    assert.deepEqual(meta, { query: '후리스', total: 36, offset: 0, count: 1, hidden: 0 });
    assert.deepEqual(out.items[0], {
        productId: 'E450195-000',
        priceGroup: '00',
        name: '후리스풀집재킷',
        brand: 'UNIQLO',
        gender: 'UNISEX',
        price: 39900,
        originalPrice: 39900,
        discounted: false,
        markdownSince: null,
        limitedOffer: null,
        rating: { average: 4.7, count: 996 },
        colors: ['09 BLACK', '69 NAVY'],
        sizes: ['S', 'M'],
        url: 'https://www.uniqlo.com/kr/ko/products/E450195-000/00',
    });
});

test('search hides GU items unless includeGu', async () => {
    const items = [item(), item({ productId: 'E491807-000', name: 'GU 3D배럴레그진' })];
    stubFetch(() => page(items));
    const hidden = await searchProducts('진');
    assert.deepEqual(hidden.items.map(i => i.productId), ['E450195-000']);
    assert.equal(hidden.meta.hidden, 1);
    const shown = await searchProducts('진', { includeGu: true });
    assert.deepEqual(shown.items.map(i => i.brand), ['UNIQLO', 'GU']);
});

test('search sale keeps only discounted rows', async () => {
    const items = [
        item(),
        item({ productId: 'E1', prices: { base: { value: 49900 }, promo: { value: 49900 } } }),
        item({ productId: 'E2', prices: { base: { value: 49900 }, promo: { value: 29900 } } }),
        item({ productId: 'E3', priceGroup: '01' }),
    ];
    stubFetch(() => page(items));
    const out = await searchProducts('진', { sale: true });
    assert.deepEqual(out.items.map(i => i.productId), ['E2', 'E3']);
});

test('search sale asks the API for markdown and limited-time products', async () => {
    const calls = stubFetch(() => page([item({ priceGroup: '01' })]));
    await searchProducts('셔츠', { sale: true });
    assert.equal(calls[0].url.searchParams.get('flagCodes'), 'discount,limitedOffer');
    await searchProducts('셔츠');
    assert.equal(calls[1].url.searchParams.has('flagCodes'), false);
});

test('search marks marked-down rows and hides the unknown original price', async () => {
    const flags = { priceFlags: [{ code: 'discount', name: '2026/08/27부터 가격인하', nameWording: { substitutions: { startDate: '2026/08/27' } } }] };
    stubFetch(() => page([item({
        prices: { base: { value: 29900 }, promo: { value: 29900 }, isDualPrice: false },
        representative: { flags },
    })]));
    const [row] = (await searchProducts('니트')).items;
    assert.deepEqual(
        [row.price, row.originalPrice, row.discounted, row.markdownSince],
        [29900, null, true, '2026/08/27'],
    );
});

test('search hides the unknown original price of a limited-time price too', async () => {
    const flags = { priceFlags: [{ code: 'limitedOffer', nameWording: { substitutions: { startDate: '2026/09/24', date: '2026/10/01' } } }] };
    stubFetch(() => page([item({ prices: { base: { value: 14900 }, promo: { value: 14900 } }, representative: { flags } })]));
    const [row] = (await searchProducts('크루넥T')).items;
    assert.deepEqual([row.originalPrice, row.discounted, row.limitedOffer], [null, true, { from: '2026/09/24', until: '2026/10/01' }]);
});

test('search with zero API results is EMPTY', async () => {
    stubFetch(() => page([]));
    await assert.rejects(searchProducts('zzqx'), { code: 'EMPTY' });
});

test('search where filters hide the whole page is EMPTY and says what to try', async () => {
    stubFetch(() => page([item({ name: 'GU 스웨트' })], 50));
    await assert.rejects(
        searchProducts('스웨트'),
        err => err.code === 'EMPTY' && /1 hidden by filters/.test(err.message) && /--offset 20/.test(err.message),
    );
});

test('search validates arguments', async () => {
    stubFetch(() => page([item()]));
    await assert.rejects(searchProducts('  '), { code: 'ARG' });
    await assert.rejects(searchProducts('x', { gender: 'unisex' }), { code: 'ARG' });
    await assert.rejects(searchProducts('x', { gender: 'toString' }), { code: 'ARG' });
    await assert.rejects(searchProducts('x', { sort: 'cheap' }), { code: 'ARG' });
    await assert.rejects(searchProducts('x', { limit: '101' }), { code: 'ARG' });
});

test('brandOf detects GU names with or without a space after GU', () => {
    assert.equal(brandOf('GU데님와이드카고팬츠'), 'GU');
    assert.equal(brandOf('GU 3D배럴레그진'), 'GU');
    assert.equal(brandOf('GUARD후리스재킷'), 'UNIQLO');
    assert.equal(brandOf('후리스풀집재킷'), 'UNIQLO');
});
