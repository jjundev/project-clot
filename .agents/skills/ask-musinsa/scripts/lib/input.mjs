import {fail} from './result.mjs';
import {normalizeStandardSize,normalizeShoeSize,parseMeasurementInput,buildFilterQueryParams} from './filters.mjs';
export function goodsNo(input) {
  const text=String(input).trim(); let id=text;
  if(!/^\d+$/.test(text)) {
    let u; try {u=new URL(text);} catch {throw fail('INVALID_ARGUMENT','상품번호 또는 무신사 상품 URL 필요');}
    const m=u.pathname.match(/^\/products\/(\d+)\/?$/);
    if(u.protocol!=='https:'||u.hostname!=='www.musinsa.com'||u.username||u.password||u.port||!m)
      throw fail('INVALID_ARGUMENT','상품 URL 형식 오류');
    id=m[1];
  }
  const number=Number(id);
  if(!Number.isSafeInteger(number)||number<1) throw fail('INVALID_ARGUMENT','상품번호 형식 오류');
  return number;
}
const allowed={search:['limit','page','sort','gender','is-used','size','shoe-size','measure'],
  recommend:['limit','gender','store'],product:[],options:[]};
const sorts={popular:'POPULAR',sale:'SALE',price_low:'PRICE_LOW',price_high:'PRICE_HIGH',newest:'NEWEST',review:'REVIEW'};
const genders={all:'A',men:'M',women:'F'};
export function validateOptions(command,options={}) {
  if(!allowed[command]||Object.keys(options).some(k=>!allowed[command].includes(k)))
    throw fail('INVALID_ARGUMENT','지원하지 않는 명령 또는 옵션');
  const o={...options};
  if(['search','recommend'].includes(command)) {
    o.limit=Number(o.limit??20);
    if(!Number.isInteger(o.limit)||o.limit<1||o.limit>100) throw fail('INVALID_ARGUMENT','limit은 1..100');
  }
  if(command==='search') {
    o.page=Number(o.page??1);o.sort=o.sort??'popular';o.gender=o.gender??'all';
    if(!Number.isSafeInteger(o.page)||o.page<1||!Object.hasOwn(sorts,o.sort)||!Object.hasOwn(genders,o.gender))
      throw fail('INVALID_ARGUMENT','page/sort/gender 형식 오류');
    const used=o['is-used']??false;
    if(![true,false,'true','false'].includes(used)) throw fail('INVALID_ARGUMENT','is-used는 true/false');
    o['is-used']=used===true||used==='true';
    if(o.size!==undefined) {
      const pieces=String(o.size).split(',').map(s=>s.trim());
      const shoePieces=pieces.filter(s=>/^\d{3}$/.test(s)).length;
      if(shoePieces>0&&shoePieces<pieces.length) throw fail('INVALID_ARGUMENT','의류/신발 size를 한 목록에 섞을 수 없습니다');
    }
    for(const [key,parser] of [['size',s=>/^\d{3}$/.test(s)?normalizeShoeSize(s):normalizeStandardSize(s)],['shoe-size',normalizeShoeSize],['measure',parseMeasurementInput]]) {
      if(o[key]!==undefined) {
        const pieces=String(o[key]).split(',');
        if(pieces.some(p=>!p.trim()||!parser(p.trim()))) throw fail('INVALID_ARGUMENT',`${key} 필터 형식 오류`);
      }
    }
  }
  if(command==='recommend') {
    o.gender=o.gender??'M';o.store=o.store??'musinsa';
    if(!['M','F','A'].includes(o.gender)||!['musinsa','outlet','beauty','player','boutique'].includes(o.store))
      throw fail('INVALID_ARGUMENT','추천 gender/store 형식 오류');
  }
  return o;
}
export function searchUrl(query,options={}) {
  if(!String(query??'').trim()) throw fail('INVALID_ARGUMENT','검색어 필요');
  const o=validateOptions('search',options);
  const u=new URL('https://www.musinsa.com/search/goods');
  u.search=new URLSearchParams({keyword:String(query),page:String(o.page),sortCode:sorts[o.sort],gf:genders[o.gender],isUsed:String(o['is-used']),...buildFilterQueryParams(o)});
  return u.href;
}
