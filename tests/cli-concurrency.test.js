import './setup-env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseConcurrency } from '../src/cli.js';

describe('CLI Concurrency Parser', () => {
  test('returns default 3 when undefined or null', () => {
    assert.equal(parseConcurrency(undefined), 3);
    assert.equal(parseConcurrency(null), 3);
  });

  test('clamps inputs strictly between 1 and 5 to prevent rate-limiting abuse', () => {
    assert.equal(parseConcurrency(10), 5);
    assert.equal(parseConcurrency(50), 5);
    assert.equal(parseConcurrency(0), 1);
    assert.equal(parseConcurrency(-5), 1);
    assert.equal(parseConcurrency(3), 3);
    assert.equal(parseConcurrency('4'), 4);
  });

  test('guards against boolean flags and NaN strings', () => {
    assert.equal(parseConcurrency(true), 3);
    assert.equal(parseConcurrency('fast'), 3);
    assert.equal(parseConcurrency(''), 3);
  });
});

