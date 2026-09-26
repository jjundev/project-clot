import './setup-env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildFilterQueryParams } from '/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/filters.js';

describe('Musinsa Search URL Parameter Construction', () => {
  test('constructs search URL with standardSize, shoeSizeOption, and measurement', () => {
    const query = '셔츠';
    const options = {
      page: 1,
      size: 'M,L',
      measure: '기장:70-75,가슴:55-60',
    };

    const filterParams = buildFilterQueryParams(options);
    let url = `https://www.musinsa.com/search/musinsa/goods?q=${encodeURIComponent(query)}&page=1&sortCode=POPULAR&gf=A&isUsed=false`;
    if (filterParams.standardSize) url += `&standardSize=${encodeURIComponent(filterParams.standardSize)}`;
    if (filterParams.shoeSizeOption) url += `&shoeSizeOption=${encodeURIComponent(filterParams.shoeSizeOption)}`;
    if (filterParams.measurement) url += `&measurement=${encodeURIComponent(filterParams.measurement)}`;

    assert.ok(url.includes('standardSize=M%2CL'));
    assert.ok(url.includes('measurement=%EC%B4%9D%EC%9E%A5%5E70%5E75%2C%EA%B0%80%EC%8A%B4%EB%8B%A8%EB%A9%B4%5E55%5E60'));
  });

  test('constructs search URL with shoe size', () => {
    const query = '스니커즈';
    const options = {
      page: 1,
      'shoe-size': '270',
    };

    const filterParams = buildFilterQueryParams(options);
    let url = `https://www.musinsa.com/search/musinsa/goods?q=${encodeURIComponent(query)}&page=1&sortCode=POPULAR&gf=A&isUsed=false`;
    if (filterParams.standardSize) url += `&standardSize=${encodeURIComponent(filterParams.standardSize)}`;
    if (filterParams.shoeSizeOption) url += `&shoeSizeOption=${encodeURIComponent(filterParams.shoeSizeOption)}`;
    if (filterParams.measurement) url += `&measurement=${encodeURIComponent(filterParams.measurement)}`;

    assert.ok(url.includes('shoeSizeOption=270'));
  });

  test('constructs search URL with numeric size routing to shoeSizeOption', () => {
    const query = '신발';
    const options = {
      page: 1,
      size: '265',
    };

    const filterParams = buildFilterQueryParams(options);
    let url = `https://www.musinsa.com/search/musinsa/goods?q=${encodeURIComponent(query)}&page=1&sortCode=POPULAR&gf=A&isUsed=false`;
    if (filterParams.standardSize) url += `&standardSize=${encodeURIComponent(filterParams.standardSize)}`;
    if (filterParams.shoeSizeOption) url += `&shoeSizeOption=${encodeURIComponent(filterParams.shoeSizeOption)}`;
    if (filterParams.measurement) url += `&measurement=${encodeURIComponent(filterParams.measurement)}`;

    assert.ok(url.includes('shoeSizeOption=265'));
    assert.ok(!url.includes('standardSize='));
  });
});
