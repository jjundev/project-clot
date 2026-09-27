// Shared test helpers: a fetch stub and canned API responses. Importing this module
// also zeroes the request pacing so tests run instantly.
import { timing } from '../lib/core.js';

const realFetch = globalThis.fetch;
timing.gapMs = 0;
timing.retryDelayMs = 0;

export function ok(result) {
    return new Response(JSON.stringify({ status: 'ok', result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
}

export function httpStatus(status, body = { status: 'nok' }) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// handler(url: URL, init) returns a Response (or throws to simulate a network error).
export function stubFetch(handler) {
    const calls = [];
    globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        calls.push({ url, init });
        return handler(url, init);
    };
    return calls;
}

export function restoreFetch() {
    globalThis.fetch = realFetch;
}
