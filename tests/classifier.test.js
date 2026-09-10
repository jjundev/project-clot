import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCategory, CATEGORY_CODES, CATEGORY_NAMES, CATEGORY_ORDER } from '../src/classifier.js';

describe('Category Classifier', () => {
  test('resolves explicit Musinsa category codes', () => {
    assert.equal(classifyCategory('Any Product', 'Brand', '001'), 'top');
    assert.equal(classifyCategory('Any Product', 'Brand', '002'), 'outer');
    assert.equal(classifyCategory('Any Product', 'Brand', '003'), 'bottom');
    assert.equal(classifyCategory('Any Product', 'Brand', '103'), 'shoes');
    assert.equal(classifyCategory('Any Product', 'Brand', '018'), 'shoes');
    assert.equal(classifyCategory('Any Product', 'Brand', '004'), 'bag');
    assert.equal(classifyCategory('Any Product', 'Brand', '020'), 'bag');
  });

  test('classifies shoes correctly by goodsName keywords', () => {
    assert.equal(classifyCategory('1461 3홀 블랙 스무스 / 11838002'), 'shoes');
    assert.equal(classifyCategory('클럽 C 85 빈티지 - 크림 / DV6434'), 'shoes');
    assert.equal(classifyCategory('젤-1130 - 화이트:클라우드 그레이'), 'shoes');
    assert.equal(classifyCategory('스웨이드 뮬 [토프]'), 'shoes');
    assert.equal(classifyCategory('루즈핏 하프부츠 HA2419'), 'shoes');
    assert.equal(classifyCategory('[미누의코디 x 식스핏] BOLD TOE DERBY'), 'shoes');
  });

  test('classifies bags and accessories correctly', () => {
    assert.equal(classifyCategory('TR 미니멀 크로스 백 [블랙]'), 'bag');
    assert.equal(classifyCategory('캔버스 레더 데이팩 - 카멜'), 'bag');
    assert.equal(classifyCategory('LUA WALLET (GREY)'), 'bag');
    assert.equal(classifyCategory('STN-26SS6 다이스 목걸이'), 'bag');
    assert.equal(classifyCategory('블랙 비드 링 팔찌'), 'bag');
    assert.equal(classifyCategory('Noir Bloom Card Wallet (Black)'), 'bag');
  });

  test('classifies outer correctly', () => {
    assert.equal(classifyCategory('릴렉스드 데님 트러커 재킷 [딥 인디고]'), 'outer');
    assert.equal(classifyCategory('오버사이즈 하이넥 윈드브레이커 재킷 [블랙]'), 'outer');
    assert.equal(classifyCategory('[리얼덕다운] 시어 후디드 라이트 다운 재킷'), 'outer');
    assert.equal(classifyCategory('크롭 무브 가디건 [화이트 멜란지]'), 'outer');
    assert.equal(classifyCategory('over fit leather blouson jacket-black'), 'outer');
    assert.equal(classifyCategory('프리미엄 베지터블 클래식 A-2 자켓 BROWN'), 'outer');
  });

  test('classifies bottom correctly', () => {
    assert.equal(classifyCategory('나일론 와이드 스트링 팬츠 [블랙]'), 'bottom');
    assert.equal(classifyCategory('딥 턱 와이드 데님 팬츠 [딥 인디고]'), 'bottom');
    assert.equal(classifyCategory('Deep Pleats Wide Jeans DCPT030CPIndigo'), 'bottom');
    assert.equal(classifyCategory('9130 원턱 세미와이드 슬랙스-먹색'), 'bottom');
    assert.equal(classifyCategory('가젯 팬츠 Black'), 'bottom');
    assert.equal(classifyCategory('하이퍼글램 우븐 쇼츠 IT4665'), 'bottom');
  });

  test('classifies top correctly', () => {
    assert.equal(classifyCategory('오버사이즈 스트라이프 럭비 스웨트셔츠 [네이비/크림]'), 'top');
    assert.equal(classifyCategory('스튜디오 아치 오버핏 후드 (NAVY)'), 'top');
    assert.equal(classifyCategory('우먼즈 울 텐셀 슬림 스쿱 넥 긴소매 티셔츠 [다크 브라운]'), 'top');
    assert.equal(classifyCategory('베아 크롭 브이넥 니트'), 'top');
    assert.equal(classifyCategory('Bow Detail Blouse'), 'top');
    assert.equal(classifyCategory('에센셜 탱크 탑 2팩'), 'top');
  });

  test('exports category names and order matching specifications', () => {
    assert.equal(CATEGORY_NAMES.top, '상의');
    assert.equal(CATEGORY_NAMES.outer, '아우터');
    assert.equal(CATEGORY_NAMES.bottom, '바지');
    assert.equal(CATEGORY_NAMES.shoes, '신발');
    assert.equal(CATEGORY_NAMES.bag, '가방·잡화');
    assert.equal(CATEGORY_ORDER.top < CATEGORY_ORDER.outer, true);
    assert.equal(CATEGORY_ORDER.outer < CATEGORY_ORDER.bottom, true);
    assert.equal(CATEGORY_ORDER.bottom < CATEGORY_ORDER.shoes, true);
    assert.equal(CATEGORY_ORDER.shoes < CATEGORY_ORDER.bag, true);
  });
});
