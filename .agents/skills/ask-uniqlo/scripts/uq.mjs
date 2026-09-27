#!/usr/bin/env node
// Standalone UNIQLO KR reader for the ask-uniqlo skill. Needs only Node 18+ (built-in fetch).
//   node uq.mjs search <검색어...> [--limit N] [--offset N] [--gender G] [--sort S] [--sale] [--include-gu]
//   node uq.mjs detail <productId|URL> [--pg 00] [--raw]
//   node uq.mjs reviews <productId|URL> [--limit N] [--offset N] [--sort new|rating]
// Prints JSON on stdout. On failure prints {"error":{code,message}} on stderr.
import { main } from '../lib/cli.js';

process.exitCode = await main();
