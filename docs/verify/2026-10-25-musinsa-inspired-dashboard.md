# 무신사 스타일 가격 대시보드 검증 — 2026-10-25

Native 실행. 기준 커밋 `6ef9f3e`, 브랜치 `codex/musinsa-dashboard`. Node v24.17.0, 기존 Playwright Chromium, 새 의존성 없음.

## 변경

- 검은 헤더, 이미지 5:6, 6/4/3/2열 목록, 단일 가격 필터와 하락폭 기본 정렬.
- 출처·복수 브랜드·검색·판매 상태·과거 기록·테마·가격 및 적립금 가정 유지.
- 모달을 별도 main 상세로 교체. URL/history factory를 단일 HTML에 주입.
- 목록에서 상세 진입은 push, 이전/다음은 replace, 직접 진입/새로고침 후 복귀는 로컬 replace. 외부 query/hash/history state 보존.
- 120개 배치·360개 카드 DOM 제한·이력 분리 유지. 상세 동안 목록 중단, 복귀 시 필요한 구간·스크롤·포커스 복원.

## 실행 및 결과

| 검증 | 결과 |
|---|---|
| `npm test` | 1118 passed, 0 failed |
| `npm run test:dashboard:browser` | 72 passed, 0 failed |
| 일반 fixture 생성물 검증 | 5개, exit 0 |
| wide/search + 적립금 fixture 생성물 검증 | 138개, exit 0 |
| scale fixture 생성물 검증 | 440,129개 / 4910 439,503개, exit 0 |

생성물 검증은 임시 디렉터리의 index.html에 `node --max-old-space-size=4096 scripts/verify-dashboard-build.js <index.html>`를 실행했다. 기존 512MiB 메모리 회귀도 npm test에 포함한다. 운영 DB·data/dashboard.html·수집·공개 데이터 계약은 변경하지 않았다.

실행한 fixture 생성은 `tests/helpers/dashboard-page.js`의 `writeFixture(dir, options)`이며 options는 각각 `{}`, `{search:true,pointScenario:'ELIGIBLE'}`, `{scale:true}`다. 최종 빌드 상세:

```text
{"name":"normal","node":"v24.17.0","output":"/tmp/clot-design-verify-normal-ORJx8W","status":0}
{"totalItems":5,"total4910":3,"scanState":"complete"}
{"name":"wide-search","node":"v24.17.0","output":"/tmp/clot-design-verify-wide-search-PmoUl8","status":0}
{"totalItems":138,"total4910":3,"scanState":"complete"}
{"name":"scale","node":"v24.17.0","output":"/tmp/clot-design-verify-scale-oHIaDb","status":0}
{"totalItems":440129,"total4910":439503,"scanState":"complete"}
```

브라우저 검증은 HTTP 하위 경로 /project-clot/ 및 file://, 숫자/출처별 goods, targetGoodsNo, 새로고침, back/forward, storage/history 거부, 365일 기간/늦은 이력/페이지 응답, 검색 인덱스 실패·직접 조회·재시도·차트 실패·표 유지, 적립금 전체 상태, 열린 탭에서 49시간 만료를 포함한다.

44만 개 목록에서 4회 더보기 후 상세→다음 상품→뒤로가기를 검증했다. 카드 키 배열과 정렬, 원래 카드 포커스 및 스크롤 오차 2px 이내를 확인했다. 필터+60초 신선도 갱신과 지연 페이지 검증은 1,500개 스캔 fixture로 별도 수행했다. 목록의 이력 asset 요청은 0, DOM 상품 최대 360개다. 만료되어 사라진 진입 카드는 인접한 남은 상품으로 포커스를 돌리는 회귀를 RED→GREEN으로 추가했다.

## 로딩 비교

Node 24.17.0, 동일 Chromium·440,129개 fixture·무신사 상의 scope·1440×1000·3회, 네트워크/CPU 무제한, 외부 리소스 차단. 초기 Node 26 측정은 사용하지 않고 기준 커밋을 임시 archive로 꺼내 Node 24에서 다시 측정했다. `measureDashboard(url,{runs:3,isolateExternal:true})` 사용.

| 중앙값 | 변경 전 | 변경 후 |
|---|---:|---:|
| 첫 카드 | 44.8ms | 47.0ms |
| 실제 검색 준비 | 260.7ms | 264.7ms |
| 인덱스 encoded bytes | 98529 | 98529 |

두 실행 모두 인덱스 1개, 동일 card assets, 이력 요청 0, pageerror 0. 첫 카드 +2.2ms, 검색 준비 +4.0ms로 이 소규모 비제한 측정에서 뚜렷한 회귀는 관찰하지 못했다. 시간은 기기/네트워크에 따라 달라진다. 제공된 JS heap은 양쪽 10,000,000 bytes로 표시된 메인 스레드 순간값이며 Worker 전체 메모리 값이 아니다. 원본 결과: [변경 전](2026-10-25-musinsa-inspired-dashboard/loading-before.json), [변경 후](2026-10-25-musinsa-inspired-dashboard/loading-after.json).

## 화면 증거

390·768·1440px에서 전체 페이지 가로 스크롤 없음, 목록 2·3·6열, 상세는 900px 이상 2영역을 검사했다. 모바일에서는 상품 가격이 첫 844px 뷰포트에 들어온다. 필터를 펼치면 모든 조건을 선택할 수 있다.

공개 배포 사이트의 데이터를 읽어 새 템플릿에 결합한 로컬 캡처다. 기존 가격·이미지·23개 실제 이력과 Chart.js를 사용했고 pageerror 0이었다. 저장된 무신사/상의 scope이며 전체 첫 방문 scope를 뜻하지 않는다. 이 캡처로 원격 배포가 완료된 것은 아니다.

- [실제 데이터 데스크톱 목록](2026-10-25-musinsa-inspired-dashboard/live-catalog-1440.png)
- [실제 데이터 데스크톱 상세](2026-10-25-musinsa-inspired-dashboard/live-detail-1440.png)
- [실제 데이터 모바일 목록](2026-10-25-musinsa-inspired-dashboard/live-catalog-390.png)
- [실제 데이터 모바일 상세](2026-10-25-musinsa-inspired-dashboard/live-detail-390.png)

격리된 fixture 캡처(상품 사진 없음): catalog-390/768/1440.png, detail-390/768/1440.png, catalog-dark.png, brand-dark.png, brand-dark-mobile.png, detail-dark-mobile.png. detail fixture 캡처는 차트 CDN 실패를 의도적으로 재현하며 표는 사용 가능하다. 같은 문서 이름의 디렉터리에 보관한다.

## 실행 중 결정과 범위

모바일에서 필터가 첫 가격을 밀어내는 캡처를 확인해 640px 미만에서만 기본 접힘으로 바꿨다. 검색과 가격 필터는 항상 보인다. 대가: 모바일의 세부 필터는 한 번 더 눌러야 한다.

원래 checkout의 사용자 package.json 변경, rea-musinsa와 기타 미추적 자료는 보존했다. REA의 더미 상품·가격·후기·상거래 기능이나 asset을 런타임에 가져오지 않았다. push·merge·Pages 배포는 수행하지 않았다.
