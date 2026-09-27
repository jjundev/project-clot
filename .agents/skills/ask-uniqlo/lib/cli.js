// Argument parsing and error → exit-code mapping for scripts/uq.mjs.
import { parseArgs } from 'node:util';
import { UqError } from './core.js';
import { searchProducts } from './search.js';
import { getProductDetail } from './detail.js';
import { getReviews } from './reviews.js';

export const EXIT_CODES = { ARG: 2, EMPTY: 3, NOT_FOUND: 4, BLOCKED: 5, NETWORK: 1 };

export const USAGE = `usage:
  uq.mjs search <검색어...> [--limit <1-100>] [--offset <n>] [--gender men|women|kids|baby]
                           [--sort recommended|price-asc|price-desc|rating|new] [--sale] [--include-gu]
  uq.mjs detail <productId|URL> [--pg <00-03>] [--raw]
  uq.mjs reviews <productId|URL> [--limit <1-50>] [--offset <n>] [--sort new|rating]`;

const COMMANDS = {
    search: {
        options: {
            limit: { type: 'string' },
            offset: { type: 'string' },
            gender: { type: 'string' },
            sort: { type: 'string' },
            sale: { type: 'boolean' },
            'include-gu': { type: 'boolean' },
        },
        arity: [1, Infinity],
        run: (positionals, values) => searchProducts(positionals.join(' '), {
            limit: values.limit,
            offset: values.offset,
            gender: values.gender,
            sort: values.sort,
            sale: values.sale,
            includeGu: values['include-gu'],
        }),
    },
    detail: {
        options: { pg: { type: 'string' }, raw: { type: 'boolean' } },
        arity: [1, 1],
        run: ([ref], values) => getProductDetail(ref, { priceGroup: values.pg, raw: values.raw }),
    },
    reviews: {
        options: { limit: { type: 'string' }, offset: { type: 'string' }, sort: { type: 'string' } },
        arity: [1, 1],
        run: ([ref], values) => getReviews(ref, { limit: values.limit, offset: values.offset, sort: values.sort }),
    },
};

export async function run([command, ...args] = []) {
    if (!Object.hasOwn(COMMANDS, command ?? '')) {
        throw new UqError('ARG', `unknown command: ${command ?? '(none)'}\n${USAGE}`);
    }
    const spec = COMMANDS[command];
    let parsed;
    try {
        parsed = parseArgs({ args, options: spec.options, allowPositionals: true, strict: true });
    } catch (error) {
        throw new UqError('ARG', `${error.message}\n${USAGE}`);
    }
    const { values, positionals } = parsed;
    const [minimum, maximum] = spec.arity;
    if (positionals.length < minimum || positionals.length > maximum) {
        throw new UqError('ARG', `${command}: wrong number of arguments\n${USAGE}`);
    }
    return spec.run(positionals, values);
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
    try {
        const output = await run(argv);
        stdout.write(`${JSON.stringify(output, null, 2)}\n`);
        return 0;
    } catch (error) {
        const code = error instanceof UqError ? error.code : 'INTERNAL';
        stderr.write(`${JSON.stringify({ error: { code, message: error.message } })}\n`);
        return EXIT_CODES[code] ?? 1;
    }
}
