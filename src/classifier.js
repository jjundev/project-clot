/**
 * @fileoverview Category classifier for Musinsa products.
 * Resolves standard 5 categories: 'top', 'outer', 'bottom', 'shoes', 'bag'.
 */

export const CATEGORY_CODES = {
  '001': 'top',
  '002': 'outer',
  '003': 'bottom',
  '007': 'shoes',
  '018': 'shoes',
  '103': 'shoes',
  '004': 'bag',
  '008': 'bag',
  '020': 'bag', // 모자
  '005': 'bag', // 패션소품
};

export const CATEGORY_NAMES = {
  top: '상의',
  outer: '아우터',
  bottom: '바지',
  shoes: '신발',
  bag: '가방·잡화',
};

export const CATEGORY_ORDER = {
  top: 1,
  outer: 2,
  bottom: 3,
  shoes: 4,
  bag: 5,
  etc: 6,
};

/**
 * Classifies a product into one of the 5 categories.
 * Prioritizes explicit categoryCode, then falls back to heuristics on goodsName.
 *
 * @param {string} [goodsName='']
 * @param {string} [brandName='']
 * @param {string} [categoryCode='']
 * @returns {'top'|'outer'|'bottom'|'shoes'|'bag'}
 */
export function classifyCategory(goodsName = '', brandName = '', categoryCode = '') {
  // 1. Explicit Musinsa category code
  if (categoryCode && CATEGORY_CODES[categoryCode]) {
    return CATEGORY_CODES[categoryCode];
  }

  const name = String(goodsName || '').toLowerCase();

  // 2. Shoes (high priority keywords)
  if (
    /(스니커즈|운동화|슈즈|부츠|뮬|로퍼|워커|더비|샌들|슬리퍼|구두|힐|단화|러닝화|클로그|바부슈|슬라이드|모카신|sneakers|shoes|boots|mule|loafer|walker|derby|sandal|3홀|8홀|클럽 c|젤-|piglet|campus)/i.test(
      name
    )
  ) {
    return 'shoes';
  }

  // 3. Bags & Accessories
  if (
    /(백팩|숄더백|토트|크로스\s*백|미니백|쇼퍼백|보스턴백|에코백|더플백|가방|\b백\b|백[\s\]\)]|호보백|데이팩|지갑|월렛|wallet|키링|파우치|카드\s*홀더|카드\s*지갑|벨트|머플러|스카프|목걸이|반지|팔찌|귀걸이|안경|선글라스|시계|모자|볼캡|비니|버킷햇|bag|backpack|tote|cross\s*bag|pouch|card|belt)/i.test(
      name
    )
  ) {
    return 'bag';
  }

  // 4. Outer
  if (
    /(자켓|재킷|코트|패딩|점퍼|블루종|가디건|집업|아노락|바람막이|윈드브레이커|무스탕|베스트|파카|플리스|후리스|야상|사파리|라이더|블레이저|다운|jacket|coat|jumper|cardigan|zip-up|parka|down|fleece|blazer|leather)/i.test(
      name
    )
  ) {
    return 'outer';
  }

  // 5. Bottom
  if (
    /(팬츠|바지|슬랙스|데님|청바지|쇼츠|트레이닝|조거|스커트|치마|치노|버뮤다|하프팬츠|카고|와이드|진\b|pants|jeans|slacks|shorts|denim|skirt|chino|jogger)/i.test(
      name
    )
  ) {
    return 'bottom';
  }

  // 6. Top (default apparel)
  if (
    /(셔츠|티셔츠|티\b|니트|스웨트|후드|맨투맨|탑|블라우스|나시|탱크탑|폴로|카라티|롱슬리브|하프슬리브|슬리브리스|크롭|뷔스티에|스쿱|헤비웨이트|tee|shirt|knit|hood|sweat|sleeveless|blouse|top)/i.test(
      name
    )
  ) {
    return 'top';
  }

  // Sensible apparel fallback
  return 'top';
}
