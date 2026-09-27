// `reviews` command: customer reviews for one product (not tied to a price group).
import { UqError, apiUrl, fetchJson, parseProductRef, requireBoundedInteger } from './core.js';

// Only the sort values the API was observed to accept; others return status "nok".
export const REVIEW_SORTS = { new: 'submission_time', rating: 'rating' };

const blank = value => (value === undefined || value === null || String(value).trim() === '' || value === '-' ? null : value);

export function normalizeReview(review) {
    return {
        rate: review.rate ?? null,
        title: blank(review.title),
        comment: blank(review.comment?.trim()),
        purchasedSize: blank(review.purchasedSize),
        purchasedColor: blank(review.purchasedColorName),
        fit: review.fit ?? null,
        height: blank(review.heightRange),
        weight: blank(review.weightRange),
        gender: blank(review.gender),
        helpfulCount: review.helpfulCount ?? 0,
        date: review.createDate ? new Date(review.createDate * 1000).toISOString().slice(0, 10) : null,
    };
}

export async function getReviews(ref, { limit, offset, sort = 'new' } = {}) {
    const { productId } = parseProductRef(ref);
    const size = requireBoundedInteger(limit, 10, 1, 50, 'limit');
    const start = requireBoundedInteger(offset, 0, 0, 100000, 'offset');
    if (!Object.hasOwn(REVIEW_SORTS, sort)) {
        throw new UqError('ARG', `sort must be one of: ${Object.keys(REVIEW_SORTS).join(', ')}`);
    }

    const result = await fetchJson(apiUrl(`/products/${productId}/reviews`, { limit: size, offset: start, sort: REVIEW_SORTS[sort] }));
    const items = (result.reviews ?? []).map(normalizeReview);
    if (items.length === 0) throw new UqError('EMPTY', `no reviews for ${productId}${start ? ` at offset ${start}` : ''}`);

    const rating = result.rating;
    return {
        meta: {
            productId,
            total: result.pagination?.total ?? items.length,
            offset: start,
            count: items.length,
            rating: rating
                ? { average: rating.average, count: rating.count, fit: rating.fit ?? null, distribution: rating.rateCount ?? null }
                : null,
        },
        items,
    };
}
