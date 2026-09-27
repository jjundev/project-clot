import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ok, httpStatus, stubFetch, restoreFetch } from './helpers.mjs';
import {
    API_BASE, USER_AGENT, apiUrl, fetchJson, stripHtml, parseProductRef, requirePriceGroup,
    requireBoundedInteger, limitedOffer, markdownSince, priceInfo, colorLabel, productUrl, kstTimestamp,
} from '../lib/core.js';

afterEach(restoreFetch);

test('apiUrl appends httpFailure and skips empty params', () => {
    const url = new URL(apiUrl('/products', { q: '후리스', limit: 5, sort: undefined, path: '' }));
    assert.equal(url.origin + url.pathname, `${API_BASE}/products`);
    assert.equal(url.searchParams.get('q'), '후리스');
    assert.equal(url.searchParams.get('limit'), '5');
    assert.equal(url.searchParams.has('sort'), false);
    assert.equal(url.searchParams.has('path'), false);
    assert.equal(url.searchParams.get('httpFailure'), 'true');
});

test('fetchJson sends a browser User-Agent and returns result', async () => {
    const calls = stubFetch(() => ok({ items: [1] }));
    assert.deepEqual(await fetchJson(apiUrl('/products')), { items: [1] });
    assert.equal(calls[0].init.headers['User-Agent'], USER_AGENT);
    assert.equal(calls[0].init.headers.Accept, 'application/json');
});

test('fetchJson maps 404 to NOT_FOUND and 403 to BLOCKED', async () => {
    stubFetch(() => httpStatus(404));
    await assert.rejects(fetchJson(apiUrl('/x')), { code: 'NOT_FOUND' });
    stubFetch(() => httpStatus(403));
    await assert.rejects(fetchJson(apiUrl('/x')), { code: 'BLOCKED' });
});

test('fetchJson treats status "nok" in a 200 body as BLOCKED', async () => {
    stubFetch(() => httpStatus(200, { status: 'nok', error: { code: 0 } }));
    await assert.rejects(fetchJson(apiUrl('/x')), { code: 'BLOCKED' });
});

test('fetchJson rejects a non-JSON body as BLOCKED', async () => {
    stubFetch(() => new Response('<html>denied</html>', { status: 200 }));
    await assert.rejects(fetchJson(apiUrl('/x')), { code: 'BLOCKED' });
});

test('fetchJson retries once on 5xx', async () => {
    const calls = stubFetch(() => (calls.length === 1 ? httpStatus(503) : ok('second')));
    assert.equal(await fetchJson(apiUrl('/x')), 'second');
    assert.equal(calls.length, 2);
});

test('fetchJson retries a network error once, then reports NETWORK', async () => {
    const calls = stubFetch(() => {
        throw new TypeError('fetch failed');
    });
    await assert.rejects(fetchJson(apiUrl('/x')), { code: 'NETWORK' });
    assert.equal(calls.length, 2);
});

test('stripHtml turns <br> into newlines, drops tags, decodes entities', () => {
    assert.equal(stripHtml('- A<br>- B &amp; C<br/><b>D</b>&#39;s'), "- A\n- B & C\nD's");
    assert.equal(stripHtml('<br>'), null);
    assert.equal(stripHtml(''), null);
    assert.equal(stripHtml(undefined), null);
});

test('parseProductRef accepts ids, bare numbers, and product URLs', () => {
    assert.deepEqual(parseProductRef('E450195-000'), { productId: 'E450195-000', priceGroup: null });
    assert.deepEqual(parseProductRef('450195'), { productId: 'E450195-000', priceGroup: null });
    assert.deepEqual(parseProductRef('e450195'), { productId: 'E450195-000', priceGroup: null });
    assert.deepEqual(
        parseProductRef('https://www.uniqlo.com/kr/ko/products/E482279-000/01?colorDisplayCode=09&sizeDisplayCode=004'),
        { productId: 'E482279-000', priceGroup: '01' },
    );
});

test('parseProductRef rejects malformed ids', () => {
    for (const bad of ['', 'abc', '45019', 'E4501951', undefined]) {
        assert.throws(() => parseProductRef(bad), { code: 'ARG' }, String(bad));
    }
});

test('requirePriceGroup accepts two digits only', () => {
    assert.equal(requirePriceGroup('01'), '01');
    assert.throws(() => requirePriceGroup('1'), { code: 'ARG' });
    assert.throws(() => requirePriceGroup('ab'), { code: 'ARG' });
});

test('requireBoundedInteger applies default and bounds', () => {
    assert.equal(requireBoundedInteger(undefined, 20, 1, 100, 'limit'), 20);
    assert.equal(requireBoundedInteger('7', 20, 1, 100, 'limit'), 7);
    assert.throws(() => requireBoundedInteger('0', 20, 1, 100, 'limit'), { code: 'ARG' });
    assert.throws(() => requireBoundedInteger('2.5', 20, 1, 100, 'limit'), { code: 'ARG' });
});

test('priceInfo marks real promos and non-00 price groups as discounted', () => {
    const base = value => ({ base: { value }, promo: null });
    const info = (price, originalPrice, discounted, markdownSince = null) => ({ price, originalPrice, discounted, markdownSince, limitedOffer: null });
    assert.deepEqual(priceInfo(base(39900), '00'), info(39900, 39900, false));
    assert.deepEqual(priceInfo({ base: { value: 49900 }, promo: { value: 49900 } }, '00'), info(49900, 49900, false));
    assert.deepEqual(priceInfo({ base: { value: 49900 }, promo: { value: 39900 } }, '00'), info(39900, 49900, true));
    assert.deepEqual(priceInfo(base(29900), '01'), info(29900, 29900, true));
    assert.deepEqual(priceInfo(undefined, '00'), info(null, null, false));
});

const markdownFlag = startDate => ({
    code: 'discount',
    name: `${startDate}부터 가격인하`,
    nameWording: { substitutions: { flagName: '가격인하', startDate } },
});

test('markdownSince reads the start date of the discount price flag', () => {
    assert.equal(markdownSince([{ code: 'colorSizeLimitedPrice' }, markdownFlag('2026/08/27')]), '2026/08/27');
    assert.equal(markdownSince([{ code: 'discount', name: '2026/09/22부터 가격인하' }]), '2026/09/22');
    assert.equal(markdownSince([{ code: 'colorSizeLimitedPrice' }]), null);
    assert.equal(markdownSince(undefined), null);
});

test('priceInfo treats a markdown flag as discounted even when base equals promo', () => {
    const flags = [markdownFlag('2026/08/27')];
    assert.deepEqual(
        priceInfo({ base: { value: 29900 }, promo: { value: 29900 }, isDualPrice: false }, '00', flags),
        { price: 29900, originalPrice: 29900, discounted: true, markdownSince: '2026/08/27', limitedOffer: null },
    );
    assert.deepEqual(
        priceInfo({ base: { value: 39900 }, promo: { value: 29900 }, isDualPrice: true }, '00', flags),
        { price: 29900, originalPrice: 39900, discounted: true, markdownSince: '2026/08/27', limitedOffer: null },
    );
});

const limitedFlag = {
    code: 'limitedOffer',
    name: '',
    nameWording: { substitutions: { flagName: '기간한정가격', startDate: '2026/09/24', date: '2026/10/01' } },
};

test('limitedOffer reads the period of a limited-time price flag', () => {
    assert.deepEqual(limitedOffer([limitedFlag]), { from: '2026/09/24', until: '2026/10/01' });
    assert.equal(limitedOffer([markdownFlag('2026/08/27')]), null);
    assert.equal(limitedOffer(undefined), null);
});

test('priceInfo treats a limited-time price as discounted', () => {
    assert.deepEqual(
        priceInfo({ base: { value: 14900 }, promo: { value: 14900 }, isDualPrice: false }, '00', [limitedFlag]),
        { price: 14900, originalPrice: 14900, discounted: true, markdownSince: null, limitedOffer: { from: '2026/09/24', until: '2026/10/01' } },
    );
});

test('colorLabel and productUrl', () => {
    assert.equal(colorLabel({ displayCode: '09', name: 'BLACK' }), '09 BLACK');
    assert.equal(productUrl('E450195-000', '01'), 'https://www.uniqlo.com/kr/ko/products/E450195-000/01');
    assert.equal(productUrl('E450195-000'), 'https://www.uniqlo.com/kr/ko/products/E450195-000/00');
});

test('kstTimestamp formats an instant in Korea time', () => {
    assert.equal(kstTimestamp(new Date('2026-09-28T00:30:05Z')), '2026-09-28T09:30:05+09:00');
    assert.equal(kstTimestamp(new Date('2026-09-27T15:00:00Z')), '2026-09-28T00:00:00+09:00');
});
