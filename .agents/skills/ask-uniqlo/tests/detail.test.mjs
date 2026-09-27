import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ok, httpStatus, stubFetch, restoreFetch } from './helpers.mjs';
import { getProductDetail } from '../lib/detail.js';

afterEach(restoreFetch);

const details = {
    productId: 'E450195-000',
    name: '후리스풀집재킷',
    genderCategory: 'UNISEX',
    breadcrumbs: {
        gender: { locale: 'MEN' },
        class: { locale: '아우터' },
        category: { locale: '파카 & 블루종' },
        subcategory: { locale: '후리스' },
    },
    rating: { average: 4.7, count: 996, fit: 3.15, rateCount: { one: 27, two: 8, three: 17, four: 89, five: 855 } },
    prices: { base: { value: 39900 }, promo: null },
    colors: [{ displayCode: '09', name: 'BLACK' }, { displayCode: '69', name: 'NAVY' }],
    sizes: [{ displayCode: '003', name: 'S' }, { displayCode: '004', name: 'M' }, { displayCode: '005', name: 'L' }],
    plds: [{ displayCode: '000', name: '-', display: { showFlag: false } }],
    composition: '몸판: 100% 폴리에스터<br>',
    washingInformation: '세탁기 가능, 드라이클리닝 불가능',
    careInstruction: '- 단독세탁<br>- 세탁망 사용',
    freeInformation: '- XS는 온라인 전용입니다.',
    longDescription: '<br>',
    countriesOfOrigin: [{ code: 'CN' }, { code: 'VN' }],
    manufacturingDate: { localizedDate: '2024. 01' },
    representative: { color: { displayCode: '69' } },
    images: { main: { '09': { image: 'https://img/09.jpg' }, '69': { image: 'https://img/69.jpg' } } },
};

function l2(l2Id, color, size, pld = '000') {
    return {
        l2Id,
        color: { displayCode: color },
        size: { displayCode: size },
        pld: { displayCode: pld },
        communicationCode: `450195-${color}-${size}-${pld}`,
    };
}

const stockPayload = {
    // deliberately out of order; a4 has no stock entry
    l2s: [l2('a3', '69', '005'), l2('a1', '09', '004'), l2('a0', '09', '003'), l2('a2', '09', '005'), l2('a4', '69', '003')],
    stocks: {
        a0: { statusCode: 'IN_STOCK', quantity: 11 },
        a1: { statusCode: 'LOW_STOCK', quantity: 3 },
        a2: { statusCode: 'STOCK_OUT', quantity: 0 },
        a3: { statusCode: 'IN_STOCK', quantity: 8 },
    },
    prices: {
        a0: { base: { value: 39900 }, promo: null },
        a1: { base: { value: 39900 }, promo: null },
        a2: { base: { value: 39900 }, promo: null },
        a3: { base: { value: 39900 }, promo: { value: 29900 } },
    },
};

const sizeCharts = [{
    productId: 'E450195-000',
    sizeChart: [{
        name: 'M',
        sizeParts: [
            { name: '전체 길이', measurements: [{ value: '67.5', unit: 'cm' }, { value: '26 1/2', unit: 'inch' }] },
            { name: '가슴너비', measurements: [{ value: '56', unit: 'cm' }] },
        ],
    }],
    bodyMeasurements: [{ name: 'M', sizeParts: [{ name: '가슴', measurements: [{ value: '88-96', unit: 'cm' }] }] }],
}];

// groups: { '00': detailsPayload, ... }; charts: () => Response
function router({ groups = { '00': details }, stock = stockPayload, charts = () => ok(sizeCharts) } = {}) {
    return url => {
        const group = url.pathname.match(/price-groups\/(\d{2})\/details$/)?.[1];
        if (group) return groups[group] ? ok(groups[group]) : httpStatus(404);
        if (url.pathname.endsWith('/l2s')) return ok(stock);
        if (url.pathname.endsWith('/products/size-charts')) return charts();
        throw new Error(`unexpected request ${url}`);
    };
}

test('detail asks l2s for previous prices', async () => {
    const calls = stubFetch(router());
    await getProductDetail('E450195-000', { priceGroup: '00' });
    const l2sCall = calls.find(c => c.url.pathname.endsWith('/l2s'));
    assert.equal(l2sCall.url.searchParams.get('includePreviousPrice'), 'true');
});

test('detail reports the pre-markdown price and start date of a marked-down group', async () => {
    // Real shape for E481004-000/00: details carry only the current price, l2s carry the previous one.
    const markedDown = {
        ...details,
        prices: { base: { value: 29900 }, promo: { value: 29900 }, isDualPrice: false },
        representative: {
            color: { displayCode: '69' },
            flags: { priceFlags: [{ code: 'discount', name: '2026/08/27부터 가격인하', nameWording: { substitutions: { startDate: '2026/08/27' } } }] },
        },
    };
    const dual = { base: { value: 39900 }, promo: { value: 29900 }, isDualPrice: true };
    const stock = { ...stockPayload, prices: Object.fromEntries(stockPayload.l2s.map(row => [row.l2Id, dual])) };
    stubFetch(router({ groups: { '00': markedDown }, stock }));
    const [group] = (await getProductDetail('E481004-000', { priceGroup: '00' })).priceGroups;
    assert.deepEqual(
        [group.price, group.originalPrice, group.discounted, group.markdownSince],
        [29900, 39900, true, '2026/08/27'],
    );
});

const detailCalls = calls => calls.filter(c => c.url.pathname.endsWith('/details')).map(c => c.url.pathname.match(/groups\/(\d\d)/)[1]);

test('detail returns the merged product for one price group', async () => {
    stubFetch(router());
    const { fetchedAt, ...out } = await getProductDetail('E450195-000');
    assert.match(fetchedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/);
    assert.deepEqual(out, {
        productId: 'E450195-000',
        name: '후리스풀집재킷',
        gender: 'UNISEX',
        category: 'MEN > 아우터 > 파카 & 블루종 > 후리스',
        rating: { average: 4.7, count: 996, fit: 3.15, distribution: { one: 27, two: 8, three: 17, four: 89, five: 855 } },
        priceGroups: [{
            priceGroup: '00',
            price: 39900,
            originalPrice: 39900,
            discounted: false,
            markdownSince: null,
            limitedOffer: null,
            available: true,
            url: 'https://www.uniqlo.com/kr/ko/products/E450195-000/00',
            stock: {
                '09 BLACK': { inStock: ['S'], lowStock: ['M'], soldOut: ['L'] },
                '69 NAVY': { inStock: ['L'], lowStock: [], soldOut: ['S'] },
            },
        }],
        sizeChart: {
            garment: { M: { '전체 길이': '67.5cm', 가슴너비: '56cm' } },
            body: { M: { 가슴: '88-96cm' } },
        },
        material: '몸판: 100% 폴리에스터',
        washing: '세탁기 가능, 드라이클리닝 불가능',
        care: '- 단독세탁\n- 세탁망 사용',
        notes: '- XS는 온라인 전용입니다.',
        description: null,
        origin: ['CN', 'VN'],
        manufacturingDate: '2024. 01',
        image: 'https://img/69.jpg',
        url: 'https://www.uniqlo.com/kr/ko/products/E450195-000/00',
    });
});

test('detail probes price groups 00-03 and returns every one that exists', async () => {
    const reduced = { ...details, prices: { base: { value: 29900 }, promo: null } };
    const calls = stubFetch(router({ groups: { '00': details, '01': reduced } }));
    const out = await getProductDetail('450195');
    assert.deepEqual(detailCalls(calls).sort(), ['00', '01', '02', '03']);
    assert.deepEqual(out.priceGroups.map(g => [g.priceGroup, g.price, g.discounted]), [['00', 39900, false], ['01', 29900, true]]);
    assert.equal(calls.filter(c => c.url.pathname.endsWith('/l2s')).length, 2);
    assert.equal(calls.filter(c => c.url.pathname.endsWith('/size-charts')).length, 1);
});

test('detail with priceGroup only asks for that group', async () => {
    const calls = stubFetch(router({ groups: { '00': details, '01': details } }));
    const out = await getProductDetail('E450195-000', { priceGroup: '01' });
    assert.deepEqual(detailCalls(calls), ['01']);
    assert.deepEqual(out.priceGroups.map(g => g.priceGroup), ['01']);
    assert.equal(out.url, 'https://www.uniqlo.com/kr/ko/products/E450195-000/01');
});

test('detail uses the price group from a product URL', async () => {
    const calls = stubFetch(router());
    await getProductDetail('https://www.uniqlo.com/kr/ko/products/E450195-000/00?colorDisplayCode=09');
    assert.deepEqual(detailCalls(calls), ['00']);
});

test('detail is NOT_FOUND when no price group exists', async () => {
    stubFetch(router({ groups: {} }));
    await assert.rejects(getProductDetail('E999999-000'), { code: 'NOT_FOUND' });
});

test('detail propagates a blocked probe instead of treating it as missing', async () => {
    stubFetch(url => (url.pathname.includes('/price-groups/02/') ? httpStatus(403) : router()(url)));
    await assert.rejects(getProductDetail('E450195-000'), { code: 'BLOCKED' });
});

test('detail rejects a malformed price group', async () => {
    stubFetch(router());
    await assert.rejects(getProductDetail('E450195-000', { priceGroup: '1' }), { code: 'ARG' });
});

test('detail labels visible length variants so sizes do not collide', async () => {
    const withLengths = {
        ...details,
        colors: [{ displayCode: '09', name: 'BLACK' }],
        plds: [{ displayCode: '076', name: '76cm', display: { showFlag: true } }, { displayCode: '079', name: '79cm', display: { showFlag: true } }],
    };
    const stock = {
        l2s: [l2('b1', '09', '004', '079'), l2('b0', '09', '004', '076')],
        stocks: { b0: { statusCode: 'IN_STOCK', quantity: 9 }, b1: { statusCode: 'STOCK_OUT', quantity: 0 } },
        prices: {},
    };
    stubFetch(router({ groups: { '00': withLengths }, stock }));
    const out = await getProductDetail('E450195-000', { priceGroup: '00' });
    assert.deepEqual(out.priceGroups[0].stock, { '09 BLACK': { inStock: ['M (76cm)'], lowStock: [], soldOut: ['M (79cm)'] } });
});

test('detail sizeChart is null when the API has no chart or 404s', async () => {
    stubFetch(router({ charts: () => ok([{ productId: 'E450195-000', imageUrl: '', colorCode: '' }]) }));
    assert.equal((await getProductDetail('E450195-000', { priceGroup: '00' })).sizeChart, null);
    stubFetch(router({ charts: () => httpStatus(404) }));
    assert.equal((await getProductDetail('E450195-000', { priceGroup: '00' })).sizeChart, null);
});

test('detail keeps unit-less measurements such as bag capacity', async () => {
    const bag = [{ sizeChart: [{ name: 'FREE', sizeParts: [
        { name: '용량', measurements: [{ value: '22L', unit: '' }] },
        { name: '높이', measurements: [{ value: '19', unit: 'inch' }, { value: '48', unit: 'cm' }] },
    ] }] }];
    stubFetch(router({ charts: () => ok(bag) }));
    const out = await getProductDetail('E450195-000', { priceGroup: '00' });
    assert.deepEqual(out.sizeChart, { garment: { FREE: { 용량: '22L', 높이: '48cm' } }, body: null });
});

test('detail raw adds ordered per-variant rows', async () => {
    stubFetch(router());
    const plain = await getProductDetail('E450195-000', { priceGroup: '00' });
    assert.equal('variants' in plain.priceGroups[0], false);
    const out = await getProductDetail('E450195-000', { priceGroup: '00', raw: true });
    const { variants } = out.priceGroups[0];
    assert.deepEqual(variants.map(v => v.l2Id), ['a0', 'a1', 'a2', 'a4', 'a3']);
    assert.deepEqual(variants[0], {
        color: '09 BLACK', size: 'S', l2Id: 'a0', communicationCode: '450195-09-003-000',
        status: 'IN_STOCK', quantity: 11, price: 39900, originalPrice: 39900,
    });
    assert.deepEqual(variants[3], {
        color: '69 NAVY', size: 'S', l2Id: 'a4', communicationCode: '450195-69-003-000',
        status: null, quantity: null, price: null, originalPrice: null,
    });
    assert.deepEqual([variants[4].price, variants[4].originalPrice], [29900, 39900]);
});

test('detail marks a price group with nothing in stock as unavailable', async () => {
    const soldOut = {
        ...stockPayload,
        stocks: Object.fromEntries(stockPayload.l2s.map(row => [row.l2Id, { statusCode: 'STOCK_OUT', quantity: 0 }])),
    };
    stubFetch(url => (url.pathname.includes('/price-groups/01/l2s') ? ok(soldOut) : router({ groups: { '00': details, '01': details } })(url)));
    const out = await getProductDetail('E450195-000');
    assert.deepEqual(out.priceGroups.map(g => [g.priceGroup, g.available]), [['00', true], ['01', false]]);
});

test('detail strips <br> from size chart labels', async () => {
    const bag = [{ sizeChart: [{ name: 'FREE', sizeParts: [
        { name: '숄더 스트랩 길이<br>(최대)', measurements: [{ value: '120', unit: 'cm' }] },
    ] }] }];
    stubFetch(router({ charts: () => ok(bag) }));
    const out = await getProductDetail('E450195-000', { priceGroup: '00' });
    assert.deepEqual(out.sizeChart.garment, { FREE: { '숄더 스트랩 길이 (최대)': '120cm' } });
});
