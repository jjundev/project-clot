import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ok, stubFetch, restoreFetch } from './helpers.mjs';
import { getReviews } from '../lib/reviews.js';

afterEach(restoreFetch);

const review = {
    rate: 5,
    title: '이거나오는날만 기다렸어요',
    comment: '따듯해요\n2사이즈 업하세요\n',
    purchasedSize: '3XL',
    purchasedColorName: '08 DARK GRAY',
    fit: 3,
    heightRange: '181 ~ 185cm',
    weightRange: '',
    gender: '남성',
    location: '-',
    name: '-',
    helpfulCount: 2,
    createDate: 1789535198,
};

const rating = { average: 4.7, count: 996, fit: 3.15, rateCount: { one: 27, two: 8, three: 17, four: 89, five: 855 } };
const payload = reviews => ok({ reviews, rating, pagination: { total: 996, offset: 0, count: reviews.length } });

test('reviews requests the product review endpoint with defaults', async () => {
    const calls = stubFetch(() => payload([review]));
    await getReviews('https://www.uniqlo.com/kr/ko/products/E450195-000/01');
    const url = calls[0].url;
    assert.equal(url.pathname, '/kr/api/commerce/v5/ko/products/E450195-000/reviews');
    assert.equal(url.searchParams.get('limit'), '10');
    assert.equal(url.searchParams.get('offset'), '0');
    assert.equal(url.searchParams.get('sort'), 'submission_time');
});

test('reviews maps sort=rating to the API value', async () => {
    const calls = stubFetch(() => payload([review]));
    await getReviews('E450195-000', { sort: 'rating', limit: '5', offset: '10' });
    assert.equal(calls[0].url.searchParams.get('sort'), 'rating');
    assert.equal(calls[0].url.searchParams.get('limit'), '5');
    assert.equal(calls[0].url.searchParams.get('offset'), '10');
});

test('reviews normalizes rows and meta', async () => {
    stubFetch(() => payload([review]));
    const out = await getReviews('E450195-000');
    const { fetchedAt, ...meta } = out.meta;
    assert.match(fetchedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/);
    assert.deepEqual(meta, {
        productId: 'E450195-000',
        total: 996,
        offset: 0,
        count: 1,
        rating: { average: 4.7, count: 996, fit: 3.15, distribution: { one: 27, two: 8, three: 17, four: 89, five: 855 } },
    });
    assert.deepEqual(out.items[0], {
        rate: 5,
        title: '이거나오는날만 기다렸어요',
        comment: '따듯해요\n2사이즈 업하세요',
        purchasedSize: '3XL',
        purchasedColor: '08 DARK GRAY',
        fit: 3,
        height: '181 ~ 185cm',
        weight: null,
        gender: '남성',
        helpfulCount: 2,
        date: '2026-09-16',
    });
});

test('reviews with no rows is EMPTY', async () => {
    stubFetch(() => payload([]));
    await assert.rejects(getReviews('E450195-000'), { code: 'EMPTY' });
});

test('reviews validates arguments', async () => {
    stubFetch(() => payload([review]));
    await assert.rejects(getReviews('E450195-000', { sort: 'helpful' }), { code: 'ARG' });
    await assert.rejects(getReviews('E450195-000', { limit: '51' }), { code: 'ARG' });
    // The API answers HTTP 400 above 25 per page.
    await assert.rejects(getReviews('E450195-000', { limit: '26' }), { code: 'ARG' });
    assert.equal((await getReviews('E450195-000', { limit: '25' })).items.length, 1);
    await assert.rejects(getReviews('nope'), { code: 'ARG' });
});

test('reviews treats the unset gender marker as blank', async () => {
    stubFetch(() => payload([{ ...review, gender: '선택하지않음' }]));
    const out = await getReviews('E450195-000');
    assert.equal(out.items[0].gender, null);
});
