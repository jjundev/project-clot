// http.mjs
import {fail} from './result.mjs';
import {isLoginHtml} from './html.mjs';
const hosts=new Set(['www.musinsa.com','api.musinsa.com','goods-detail.musinsa.com']);
export async function request(url,{method='GET',body,fetchImpl=fetch,
  sleepImpl=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  timeoutMs=15000,now=Date.now}={}) {
  let target;
  try { target=new URL(url); } catch { throw fail('INVALID_ARGUMENT','요청 URL 형식 오류'); }
  if(target.protocol!=='https:'||!hosts.has(target.hostname)||target.username||target.password||target.port)
    throw fail('INVALID_ARGUMENT','허용되지 않은 요청 주소');
  if(!['GET','POST'].includes(method)||
    (method==='POST'&&(target.hostname!=='goods-detail.musinsa.com'||!/^\/api2\/goods\/\d+\/options\/v2\/prioritized-inventories$/.test(target.pathname))))
    throw fail('INVALID_ARGUMENT','허용되지 않은 요청 방식');
  for(let attempt=0;attempt<3;attempt++) {
    let response,content;
    try {
      response=await fetchImpl(target.href,{method,body,redirect:'manual',
        signal:AbortSignal.timeout(timeoutMs),headers:{
          'User-Agent':'Mozilla/5.0','Accept':'application/json,text/html',
          'Accept-Language':'ko-KR,ko;q=0.9','Referer':'https://www.musinsa.com/',
          ...(body?{'Content-Type':'application/json'}:{})
        }});
      content=await response.text();
    } catch(e) {
      if(attempt===2) throw fail(['TimeoutError','AbortError'].includes(e.name)?'TIMEOUT':'NETWORK_ERROR','HTTPS 요청 실패');
      await sleepImpl(500*(2**attempt)); continue;
    }
    if(response.status>=300&&response.status<400) {
      const location=new URL(response.headers.get('location')||'/',target);
      throw fail(location.pathname.includes('/auth/login')?'AUTH_REQUIRED':'REDIRECT','리다이렉트 응답');
    }
    if([401,403].includes(response.status)) throw fail(response.status===401?'AUTH_REQUIRED':'ACCESS_DENIED',`HTTP ${response.status}`);
    if([429,502,503,504].includes(response.status)) {
      const raw=response.headers.get('retry-after');
      const parsed=raw==null?NaN:(/^\d+$/.test(raw)?Number(raw)*1000:Date.parse(raw)-now());
      const delay=Number.isFinite(parsed)?Math.max(0,parsed):500*(2**attempt);
      if(delay>30000||attempt===2) throw fail(response.status===429?'RATE_LIMITED':'HTTP_ERROR',`HTTP ${response.status}`);
      await sleepImpl(delay); continue;
    }
    if(!response.ok) throw fail('HTTP_ERROR',`HTTP ${response.status}`);
    return content;
  }
}
export async function requestJson(url,options={}) {
  const text=await request(url,options);
  if(isLoginHtml(text)) throw fail('AUTH_REQUIRED','로그인 페이지 응답');
  try {return JSON.parse(text);} catch {throw fail('SCHEMA_CHANGED','JSON 응답을 읽을 수 없습니다');}
}
