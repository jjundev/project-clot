import './setup-env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseOrderOptionAndSize, extractSizeToken } from '/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/order-parser.js';

describe('Musinsa Order Option & Size Parser', () => {
  test('extracts size, option, and qty from prefixed single line', () => {
    const lines = ['배송완료', '포터리', '컴포트 셔츠 (SAX BLUE)', '[옵션] SAX BLUE / 3 / 1개', '118,000원'];
    const result = parseOrderOptionAndSize(lines);
    assert.deepEqual(result, {
      size: '3',
      option: 'SAX BLUE / 3',
      qty: '1개',
    });
  });

  test('extracts shoe size and color when formatted with colon', () => {
    const lines = ['구매확정', '아디다스', '가젤 인도어', '옵션 : BLUE / 270 / 1개', '139,000원'];
    const result = parseOrderOptionAndSize(lines);
    assert.deepEqual(result, {
      size: '270',
      option: 'BLUE / 270',
      qty: '1개',
    });
  });

  test('extracts clothing standard size when option and qty are on separate lines', () => {
    const lines = ['배송완료', '무신사 스탠다드', '릴렉스드 티셔츠', '화이트 / XL', '1개', '19,900원'];
    const result = parseOrderOptionAndSize(lines);
    assert.deepEqual(result, {
      size: 'XL',
      option: '화이트 / XL',
      qty: '1개',
    });
  });

  test('extracts waist size from pants option', () => {
    const lines = ['배송완료', '브랜디드', '와이드 데님', '블랙 / 32', '1개', '69,000원'];
    const result = parseOrderOptionAndSize(lines);
    assert.deepEqual(result, {
      size: '32',
      option: '블랙 / 32',
      qty: '1개',
    });
  });

  test('falls back gracefully when only quantity is present', () => {
    const lines = ['주문완료', '브랜드', '단일 옵션 상품', '1개', '15,000원'];
    const result = parseOrderOptionAndSize(lines);
    assert.deepEqual(result, {
      size: '-',
      option: '-',
      qty: '1개',
    });
  });

  test('extracts option and standalone qty when prefixed option has no embedded qty', () => {
    const lines = ['배송완료', '브랜드', '상품명', '[옵션] 블랙 / L', '2개', '39,000원'];
    const result = parseOrderOptionAndSize(lines);
    assert.deepEqual(result, {
      size: 'L',
      option: '블랙 / L',
      qty: '2개',
    });
  });
});

describe('extractSizeToken', () => {
  test('extracts standard clothing sizes', () => {
    assert.equal(extractSizeToken('블랙 / L'), 'L');
    assert.equal(extractSizeToken('화이트 / XXL'), 'XXL');
    assert.equal(extractSizeToken('네이비 / FREE'), 'FREE');
    assert.equal(extractSizeToken('ONE SIZE'), 'ONE SIZE');
  });

  test('extracts shoe sizes in mm', () => {
    assert.equal(extractSizeToken('BLUE / 270'), '270');
    assert.equal(extractSizeToken('265mm'), '265');
  });

  test('extracts numeric pants and brand sizing', () => {
    assert.equal(extractSizeToken('블랙 / 32'), '32');
    assert.equal(extractSizeToken('3'), '3');
    assert.equal(extractSizeToken('GRAY / 1'), '1');
  });

  test('returns fallback - for empty or unmatched options', () => {
    assert.equal(extractSizeToken(''), '-');
    assert.equal(extractSizeToken('-'), '-');
    assert.equal(extractSizeToken(null), '-');
  });
});
