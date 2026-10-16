# 👔 Project-Clot (무신사 가격 추적 및 위시리스트 관리 시스템)

> **무신사 관심 상품의 실시간 가격, 브랜드 쿠폰가, 품절/재입고 상태를 매일 자동으로 추적하고 기록하는 로컬 백그라운드 시스템**

---

## ✨ 핵심 기능

1. **자동 위시리스트 동기화 (`sync`)**
   - 무신사 계정에서 좋아요(하트)를 누른 상품 목록(175개+)을 자동으로 가져와 로컬 DB에 등록합니다.
   - 좋아요를 취소한 상품은 과거 가격 기록을 보존한 채 소프트 삭제(`UNLIKED`) 처리하여 리소스를 절약합니다.

2. **나의 할인가 & 쿠폰 추적 (`track`)**
   - 일반 판매가뿐만 아니라 **회원 등급 할인, 브랜드 쿠폰, 적립금 선할인**이 모두 적용된 **'나의 최종 실구매가'**를 시계열로 기록합니다.
   - **수집 경로**: 저장된 무신사 로그인 쿠키(`~/.clot/musinsa-session.json`, 저장소 밖)로 상품 페이지·쿠폰·카드 프로모션을 HTTPS로 직접 조회해 나의 할인가를 계산합니다(브라우저 불필요, 잠자기 중에도 동작). 쿠키가 없거나 만료되면 OpenCLI 브리지에서 새로 받아오고, 그래도 실패한 상품만 OpenCLI `my-prices` → 공개가 파서 순으로 폴백합니다.

3. **하루 1회 실행 보장 데몬 (`launchd`)**
   - macOS 백그라운드 서비스(`launchd`)로 매일 오전 09:30에 조용히 실행됩니다.
   - **잠자기 인식(Sleep-aware)**: 덮개를 닫아 둔 상태(DarkWake)에서 실행되면 응답할 수 없는 Chrome/OpenCLI 브리지를 기다리지 않고 즉시 공개가 직통 파서로 수집한 뒤 `deferred`로 기록합니다. 이후 30분 간격 catch-up 틱(10:00~21:30) 중 맥이 완전히 깨어난 첫 시점에 로그인 쿠폰가로 자동 재수집(upgrade)합니다.
   - 실행 명령은 `caffeinate -i -s -u`로 감싸져 수집 도중 다시 잠들지 않고, 덮개가 열려 있으면 DarkWake를 정상 기상으로 승격시킵니다. 현재 상태와 다음 틱의 동작은 `node src/cli.js power-status`로 확인할 수 있습니다.
   - 그 시간에 맥북이 꺼져 있었어도 부팅 시 1회 즉시 실행되며, 하루에 맥북을 여러 번 껐다 켜도 **'Daily Lock'** 메커니즘을 통해 무조건 하루 1번만 실행됩니다.

4. **수동 관심 상품 등록 (`watch`)**
   - 무신사 좋아요를 누르지 않고도 특정 상품 URL이나 번호(`goodsNo`)만으로 개별 추적이 가능합니다.

5. **가격 하락 & 재입고 알림 (`notifier`)**
   - 가격이 어제보다 떨어졌거나 **역대 최저가**를 갱신했을 때, 또는 품절 상품이 **재입고**되었을 때 macOS 화면 알림(배너) 및 텔레그램 봇으로 즉시 알림을 발송합니다.

6. **Git 자동 백업**
   - 수집된 데이터는 `data/latest_prices.json` 및 `data/prices.db`에 저장되며, 깃 저장소에 자동 커밋 & 푸시되어 클라우드 백업이 유지됩니다.

7. **OpenCLI 기반 무신사 정밀 검색 및 실시간 재고/옵션 조회 (`opencli`)**
   - 의류 표준 사이즈(`--size M`), 신발 사이즈(`--shoe-size 270`), 실측 치수(`--measure "총장:72-76,가슴:55-60"`) 기반 다중 필터 검색을 지원합니다.
   - 상품 번호(`goodsNo`) 또는 상품 URL로 개별 옵션/사이즈별 실시간 품절 여부, 추가금, 남은 수량, 출고 예정일을 즉시 조회(`opencli musinsa options <goodsNo>`)합니다.

8. **주문 내역 사이즈 추출 및 과거 구매 기반 맞춤 실측(`mysize`, `--my-size`)**
   - `opencli musinsa orders`: 복잡한 주문 내역 텍스트(`색상 / 사이즈 / 수량`)에서 `size`, `option`, `qty`를 지능적으로 분리 추출하여 독립된 `size` 열로 제공합니다.
   - `opencli musinsa mysize`: 과거 구매한 의류의 실측 치수(총장, 가슴, 허리, 어깨, 소매, 허벅지 cm)를 카테고리별(`top`, `pants`, `outer`)로 조회하고 검색 필터(`--as-filter`)로 변환합니다.
   - `opencli musinsa search <query> --my-size <category>`: 과거 구매했던 의류 실측을 자동으로 반영하여 내 몸에 맞는 상품을 손쉽게 검색합니다.

9. **4910 상위 100 브랜드 × 우수 셀러 추적 (`track-4910`)**
   - **범위**: [4910.kr](https://4910.kr)(에이블리 남성관) **브랜드 랭킹 상위 100개 브랜드**(유니클로·GU는 순위와 관계없이 항상 포함)의 판매글입니다. 브랜드 목록은 주 1회(월요일) 갱신하고, 다른 날은 저장된 목록을 씁니다. 상위 100에서 빠진 브랜드의 판매글은 `OUT_OF_SCOPE`가 되며 종료(`DROPPED`)로 세지 않습니다.
   - **셀러 기준**: **구매만족도 95% 이상, 리뷰 100개 이상**인 셀러의 판매글만 추적합니다. 4910의 유니클로·GU처럼 공식몰이 아니라 구매대행 셀러가 올린 글이 많아서, 판매글 번호(`sno`) 단위로 따로 기록합니다. 기준에서 탈락한 셀러의 판매글은 `OUT_OF_SCOPE`로 바뀌고(이력은 유지), 다시 통과하면 재등장으로 되살아납니다.
   - **이력**: **바뀔 때만** 남깁니다(신규·가격변동·종료·재등장). 완전한 스캔에서 2회 연속 보이지 않은 판매글은 종료(`DROPPED`)로 처리합니다. 일부 브랜드가 불완전 스캔이면 그 브랜드는 미발견을 세지 않습니다.
   - **쿠폰가 계산과 공개 범위**: 로그인(`ABLY_JWT_TOKEN`)한 내 쿠폰함으로 **쿠폰가 = 목록가 − 적용되는 쿠폰 중 최대 할인**(10원 단위 올림)을 매일 계산합니다. 4910 전체의 실구매가·할인율·최저가·하락 표시는 쿠폰가 기준(쿠폰가 이력 `coupon_price_changes`)입니다. 토큰이 없거나 만료된 날은 쿠폰가를 갱신하지 않고 마지막 쿠폰가를 최대 3일 유지합니다(그날 표시가가 바뀐 판매글은 표시가). 쿠폰 적용 여부는 판매처마다 대표 판매글 2개로 `best-coupon`을 조회해 판정하고, 계산이 실제 할인과 어긋나는 판매처는 요약에 경고로 남습니다. 쿠폰가는 가격 이벤트(`price_changes`)에는 쓰지 않습니다. 토큰이 없거나 만료되면 쿠폰 단계만 건너뛰고 `⚠️ 4910 로그인 만료 — ABLY_JWT_TOKEN 갱신 필요`가 요약에 붙습니다. ⚠️ 쿠폰가와 **쿠폰함 내역은 DB(Release)와 Pages 대시보드에 그대로 공개됩니다.**
   - **찜한 상품의 회원가**: 4910.kr에서 찜(하트)한 상품의 `member_price`를 같은 쿠폰함 기준으로 기록합니다. 대시보드의 `4910 찜` 필터에서 **표시가 / 쿠폰적용가 / 내 회원가**를 한 카드에서 비교합니다. 찜 동기화가 실패하면 `⚠️ 4910 찜 가격 기록 실패 — Actions 로그 확인`이 붙습니다.
   - ⚠️ **`member_price` 기준 변경 (2026-10)**: 이전에는 에이블리 앱의 회원가(`/api/v2/goods`)였지만, 이 변경 이후 첫 `track-4910` 실행(2026-10)부터는 4910 쿠폰함의 best-coupon 결과(목록가 − 최대 쿠폰 할인)입니다. 열 이름은 그대로라서 그 실행 이전 값은 에이블리 앱 기준입니다.
   - **저장소: GitHub Release**: 판매글이 수십만 건이라 DB(약 100MB)를 git에 커밋하지 않습니다. `data/4910.db`는 Release `data-4910`의 첨부 파일 `4910.db.gz`(최신본), `4910.db.prev.gz`(직전본, 롤백용), `4910.db.<YYYY-MM-DD>.gz`(날짜별 사본, 최근 7개)로 보관합니다. `4910-db push`는 직전본 → 날짜별 사본 → 최신본 순서로 하나씩 올리므로 중간에 실패해도 받을 수 있는 DB가 남고, `4910-db pull`은 최신본이 없으면 직전본을 받으며 ⚠️ 경고를 남깁니다. **`data/4910.db`의 git 이력은 2026-10-11까지**이고, 이후 파일은 `.gitignore`에 들어 있습니다.
   - **실행**: 별도 workflow `4910 tracker`(`.github/workflows/4910.yml`)가 매일 10:30(KST)에 `4910-db pull` → `track-4910` → `4910-db push` 순서로 돌고, 텔레그램 요약을 하루 1통 보냅니다. 앞 단계가 실패하면 뒤 단계는 실행하지 않습니다(빈 DB로 스캔하거나 Release 이력을 덮어쓰지 않기 위해서). 무신사 `daily`와 Pages 배포는 4910 실패의 영향을 받지 않고, `daily`에서는 4910 단계가 빠졌습니다(`--skip-4910`은 호환용으로 남아 아무 일도 하지 않습니다).
   - **로컬 사용법**: `node src/cli.js 4910-db pull`로 Release의 DB를 받은 뒤 `node src/cli.js track-4910 --dry-run`으로 확인합니다. `track-4910`은 `data/4910.db`가 없으면 실행을 거부합니다(빈 DB로 시작하면 모든 판매글이 신규로 잡혀 이력이 덮이므로). ⚠️ **로컬(Mac)에서는 `--dry-run`으로만 실행하세요.** 쓰기 실행은 텔레그램 요약을 한 통 더 보내고, 로컬 DB를 `4910-db push`하면 Actions가 쌓은 이력을 덮어씁니다. 로컬에 따로 쌓고 싶다면 `CLOT_4910_DB_PATH=/tmp/4910.db`처럼 경로를 바꾸세요.
   - **최초 1회 부트스트랩**: Release가 아직 없을 때는 로컬의 기존 `data/4910.db`로 `node src/cli.js 4910-db push --allow-fresh`를 한 번 실행해 `data-4910` Release를 만듭니다. 그 전에는 `4910 tracker`와 Pages의 4910 섹션이 DB를 받지 못해 멈추거나 건너뜁니다.
   - **대시보드 출처 필터**: `전체`(무신사 + 4910 찜) · `무신사` · `4910 찜` · `4910 전체`. `4910 전체`를 누르면 브랜드 칩(판매글 수 순)이 뜨고, 브랜드를 고를 때마다 그 브랜드 파일(`4910/b{브랜드번호}.js`, 목록은 `4910/index.js`)만 내려받아 쌓습니다. 카드는 120개씩 그리고, 스크롤하거나 `더 보기`를 누르면 더 그립니다. 찜하지 않은 판매글의 가격은 그날 쿠폰가를 알면 **쿠폰가**, 모르면 **표시가**이고(회원가는 없음), 두 기준끼리는 비교하지 않습니다. 하락 표시는 마지막 스캔에서 같은 기준 가격이 내려간 판매글에만, 역대 최저가 표시는 같은 기준 가격이 한 번이라도 바뀐 판매글에만 붙습니다.
   - 텔레그램 요약에는 스캔 브랜드·판매글·통과 셀러 수, 신규·가격변동·종료 수, 직전 기록가 대비 **10% 이상 하락한 상위 10개**, 찜 상품 쿠폰가 하락이 들어갑니다.

10. **무신사 와이드 스캔 (`track-musinsa`)**
   - **범위**: 무신사 대분류 5개(`001`, `002`, `003`, `103`, `004`) 아래의 세부 분류를 동적으로 발견하고 리뷰순(`REVIEW`) 목록을 번갈아 읽어 매일 **고유 300,000개**를 선택합니다(성별 `gf=A`, 로그인 없이, 기본 병렬도3). 조회용 세부 분류와 DB의 대분류를 구분하며, 전역 리뷰순 상위30만이나 대분류 균등 배분은 아닙니다. 목록 API는 페이지마다 서명이 붙어 `page`를 건너뛸 수 없어서 `nextPageUrl`을 순서대로 따라갑니다.
   - **쿠폰가 정의**: **쿠폰가 = 판매가 − 추가할인 − 등록부 적용 목록과 최근 직접 조회에서 확인된 사용 가능 쿠폰 중 최대 할인**입니다. 회원 등급 할인·적립금·카드 즉시할인은 **제외**합니다(목록에 제한 플래그가 없고 결제수단별 조건이 달라서). 등록부 전환이 끝나고 적용 목록이 적재되면 전체 추적 상품을 계산합니다. 직접 조회 결과는 10일간 보완 자료로 쓰며, 아직 시작하지 않았거나 만료·퇴출된 쿠폰은 제외합니다. 전환 전이나 적용 목록이 아직 없을 때는 쿠폰가가 비어 있습니다(NULL).
   - **쿠폰 등록부 방식**: 쿠폰을 상품마다 묻지 않고 쿠폰 번호를 기준으로 모읍니다.
     - **번호 순회와 판별**: 쿠폰 번호는 순서대로 늘어나므로 로그인 없이 `/count`로 번호를 50개씩 훑어 상품이 있는 쿠폰을 등록부(`USABLE`·`OTHER`·`PENDING`·`OUT_OF_SCOPE`·`RETIRED`)에 올립니다. 회원 쿠키로는 하루 약 60~200번만 호출해 쿠폰마다 내게 적용되는 쿠폰인지(`USABLE`) 아닌지(`OTHER`)를 판별합니다.
     - **표본**: 판별을 맞는지 보려고 하루 200개(대분류마다 40개) 상품을 골라 직접 조회해 목록과 비교하고, 요약에 정확도(🎯)와 판별 대기 수(🧮)로 보여 줍니다.
     - **목록 순회**: `USABLE` 쿠폰마다 쿠폰 적용 상품 목록 API를 읽어 쿠폰가를 계산합니다(5개 대분류 합산 목록을 실제 끝까지 읽습니다. 60페이지·리뷰 하한으로 잘라 완료 처리하지 않습니다). 상품별 직접 조회 결과는 10일간(`COUPON_TTL_DAYS`) 추정 보완에 씁니다. 오늘 같은 판매가·추가 할인에서 직접 조회한 상품은 `DIRECT`, 나머지는 `ESTIMATED`로 구분합니다. 정상 종료된 빈 목록이 회원 기록과 충돌하면 쿠폰 ID를 API 예외 경고로 남기고 확인된 혜택 기준의 추정 가격 계산은 계속합니다. HTTP·스키마·마감 실패는 계속 갱신을 보류합니다. 쿠폰가 확정 하락 알림은 이전·현재 모두 직접 확인한 경우만 보냅니다.
   - **이력과 `OUT_OF_SCOPE`**: **바뀔 때만** 남깁니다(신규·가격변동·재등장, 쿠폰가는 `coupon_price_changes`). 완전한 스캔에서 **2회 연속 보이지 않은 상품은 `OUT_OF_SCOPE`**(종료가 아님)로 바뀌고, 다시 보이면 `REVIVED`로 되살아납니다. 페이지를 끝까지 못 읽어 불완전하게 끝난 대분류는 미노출을 세지 않습니다.
   - **저장소: GitHub Release**: `data/musinsa-wide.db`는 git에 커밋하지 않고(`.gitignore`) Release `data-musinsa`의 `musinsa-wide.db.gz`(최신본), `musinsa-wide.db.prev.gz`(직전본, 롤백용), `musinsa-wide.db.<YYYY-MM-DD>.gz`(날짜별 사본)로 보관합니다. 올리는 순서와 복구 방식은 `4910-db`와 같습니다.
   - **실행**: workflow `Musinsa wide scan`(`.github/workflows/musinsa-wide.yml`)이 매일 11:30(KST)에 `musinsa-db pull` → `track-musinsa` → `musinsa-db push` 순서로 돌고, 텔레그램 요약을 하루 1통(스캔 요약, 쿠폰 조회 요약, 쿠폰가 10% 이상 하락 상위 10개) 보냅니다. DB 업로드 후 30만 상품·쿠폰 목록 완료 상태를 별도로 검증하고, 불완전하면 실행을 실패로 표시합니다. 네트워크 예산165분·Actions 제한180분이며, 상품 수집45분·번호 탐색12분·판별15분의 단계별 예산을 사용합니다. 앞 단계가 실패하면 뒤 단계는 실행하지 않고, `daily`와 같은 `clot-daily` concurrency 그룹을 써서 두 workflow가 겹치지 않으며 쿠키 교체(rotation) 단계도 `daily`와 같습니다. 기존 당일 30만 선택이 정상이고 실패가 전부 빈 목록 충돌인 실행은 `resume-pricing` 모드로 예외를 재확인하고 가격 계산만 재개할 수 있습니다(상품·회원 재조회 없음). 수동 실행의 `mode`는 `dry-run`(기본, 쓰기 없음) · `scan` · `init`(Release가 없을 때 첫 적재: `track-musinsa --init` 후 `musinsa-db push --allow-fresh`) · `backfill`(쿠폰 등록부 일회성 채우기: `musinsa-db pull` → `track-musinsa --backfill [--from <n>]` → `musinsa-db push`)입니다. ⚠️ `init`은 **02:30 UTC(11:30 KST) 이후**, 또는 그날 예약 실행이 이미 끝난 뒤에 돌리세요. 그 전에 돌리면 같은 날 예약 스캔이 스캔 일수 1일짜리 DB를 받아 `musinsa-db push`가 거부하고 실행이 빨갛게 끝납니다. 쿠키(`MUSINSA_COOKIE`)가 없거나 형식이 틀려도 스캔과 push는 그대로 진행하고 쿠폰 조회만 건너뛰며, 마지막 단계에서 실행을 빨갛게 표시합니다.
   - **`backfill` 모드 (등록부 전환)**: 병합한 날 **오후**에 한 번 직접 실행합니다(약 2시간, 제한 180분). `daily`(09:30)나 와이드 스캔(11:30)과 겹치지 않게 **13:00(KST) 이후**에 돌리세요(같은 `clot-daily` 그룹이라 겹치면 한쪽이 기다립니다). 시간 초과·429·세션 만료로 중단되면 커서를 DB에 저장해 push하며(세션이 만료되면 마지막 상태 점검 단계는 실패로 표시될 수 있습니다), 요약에 `⏸`가 붙으면 **다시 실행**해 이어서 합니다. `✅ 전환 완료`가 뜨기 전에는 다음 날 스캔이 쿠폰가를 계산하지 않습니다. 로컬에서는 쓰지 마세요(`--init`·`--dry-run`과도 함께 쓸 수 없습니다).
   - **로컬 사용법**: ⚠️ **로컬(Mac)에서는 `--dry-run`으로만 실행하세요.** `node src/cli.js track-musinsa --dry-run [--category 001,002] [--depth 5]`는 DB에 쓰지 않고 텔레그램도 보내지 않으며 쿠폰 조회도 하지 않습니다. 쓰기 실행은 텔레그램 요약을 한 통 더 보내고, 로컬 DB를 `musinsa-db push`하면 Actions가 쌓은 이력을 덮어씁니다. `track-musinsa`는 `data/musinsa-wide.db`가 없으면 `--init` 없이는 실행을 거부합니다.
   - ⚠️ **공개 범위**: 저장소가 공개이므로 Release `data-musinsa`의 `musinsa-wide.db.gz`에 들어 있는 **쿠폰가와 상품별 쿠폰 목록(쿠폰 이름 포함), 쿠폰 등록부(쿠폰 이름·조건)와 쿠폰별 적용 상품이 누구에게나 공개됩니다.** 내 쿠폰함 내역이 그대로 드러나는 점에 유의하세요.

---

## 📁 디렉토리 구조

```text
~/Documents/Private/project-clot/
├── data/
│   ├── prices.db            # SQLite 데이터베이스 (시계열 가격 로그 & 상품 메타데이터)
│   ├── 4910.db              # (git 미추적) 4910 판매글 & 변동 이력 — Release data-4910에서 받아 씀
│   ├── musinsa-wide.db      # (git 미추적) 무신사 와이드 스캔 상품·쿠폰가 이력 — Release data-musinsa에서 받아 씀
│   └── latest_prices.json   # Git 저장소 공유용 최신 가격 스냅샷
├── logs/                    # 데몬 실행 로그 (daily.log)
├── src/
│   ├── cli.js               # 통합 CLI 진입점
│   ├── db.js                # SQLite 데이터베이스 레이어 (node:sqlite)
│   ├── collector.js         # 상품 가격, 쿠폰, 품절 상태 수집기
│   ├── sync.js              # 무신사 좋아요 목록 증분 동기화
│   ├── notifier.js          # macOS 데스크톱 및 텔레그램 알림 발송
│   ├── site4910/            # 4910.kr 상위 브랜드 스캔 (client, store, track, sellers, coupons, release, digest)
│   └── musinsaWide/         # 무신사 와이드 스캔 (client, store, track, coupons, release, digest)
├── package.json
├── .env.example             # 텔레그램/디스코드 웹훅 설정 템플릿
└── README.md
```

---

## 🚀 사용 가이드

### 1. 첫 실행 & 전체 동기화
```bash
cd ~/Documents/Private/project-clot

# 1) 무신사 좋아요 목록 동기화 및 오늘 가격 수집 (1회 실행)
node src/cli.js daily --force
```

### 2. 주요 명령어
```bash
# 전체 추적 중인 상품 목록 및 최저가 조회
node src/cli.js list

# 특정 상품의 날짜별 가격 변동 히스토리 확인
node src/cli.js history 6047897

# 좋아요 누르지 않고 수동으로 관심 상품 추가
node src/cli.js watch https://www.musinsa.com/products/3074360

# 수동 관심 상품 추적 해제
node src/cli.js unwatch 3074360

# 4910 상위 100 브랜드 스캔 결과만 확인 (DB에 쓰지 않음, 텔레그램 없음) — 먼저 Release의 DB를 받아야 함
node src/cli.js 4910-db pull
node src/cli.js track-4910 --dry-run
node src/cli.js track-4910 --brand gu --dry-run

# 오늘(또는 특정 날짜) 가격 조사 즉시 중단 및 생략 처리 (진행 중인 프로세스 자동 종료)
node src/cli.js skip
# 또는
npm run skip
```

### 3. OpenCLI 무신사 검색, 실측 필터, 옵션 및 구매 내역/마이사이즈

무신사 OpenCLI 어댑터를 통해 터미널에서 직접 표준 사이즈, 신발 사이즈, 실측 치수 필터로 상품을 검색하고 개별 옵션의 실시간 재고와 과거 구매 내역 및 실측 치수를 확인할 수 있습니다.

#### 1) 사이즈 및 실측 필터 검색 (`opencli musinsa search`)
```bash
# 의류 표준 사이즈 필터 검색 (단일 또는 콤마 구분)
opencli musinsa search "셔츠" --size M
opencli musinsa search "후드집업" --size "L,XL"

# 정밀 실측(cm) 필터 검색 (한국어 부위 별칭 및 범위 지원)
# 지원 부위: 총장/기장, 가슴, 어깨, 소매/팔, 허리, 허벅지, 밑위, 밑단, 엉덩이/힙
# 범위 형식: "최소-최대" (70-75), "최소~최대" (70~75), "최소+" (75+), "최대-" (80-)
opencli musinsa search "슬랙스" --size L --measure "총장:100-105,허리:40-42"
opencli musinsa search "오버핏 셔츠" --measure "기장:72~76,가슴:58+"

# 신발 사이즈(mm) 필터 검색 (숫자 또는 mm 단위 지원)
opencli musinsa search "스니커즈" --shoe-size 270
opencli musinsa search "러닝화" --shoe-size "265,270"
```

#### 2) 과거 구매 기반 자동 실측 검색 (`opencli musinsa search --my-size`)
내가 과거에 구매했던 의류의 실제 실측 치수를 자동으로 가져와 검색 필터에 실시간 적용합니다:
```bash
# 과거 구매한 상의 실측(총장/가슴/어깨/소매) 기준으로 셔츠 검색 (기본 오차: ±2cm)
opencli musinsa search "옥스포드 셔츠" --my-size top

# 바지(하의) 실측(총장/허리/허벅지) 기준으로 슬랙스 검색
opencli musinsa search "와이드 슬랙스" --my-size pants

# 아우터 실측 기준으로 자켓 검색
opencli musinsa search "블레이저" --my-size outer

# 허용 오차 범위(tolerance) 조절 (예: ±3cm)
opencli musinsa search "맨투맨" --my-size top --tolerance 3
```
- **자동 브릿지**: `--my-size <category>` 지정 시 최근 구매한 해당 카테고리 의류의 실측을 조회하여 자동으로 `--measure` 필터를 생성 및 적용합니다.
- **수동 지정 우선**: 직접 `--measure`를 함께 전달하면 수동 입력값이 우선 적용됩니다.

#### 3) 상품 옵션 및 실시간 재고 조회 (`opencli musinsa options`)
상품 번호(`goodsNo`) 또는 상품 URL로 각 사이즈/옵션의 실시간 판매/품절 상태, 옵션 추가금, 남은 재고 수량, 발송 예정일을 조회합니다:
```bash
# 상품 번호로 옵션 및 재고 확인
opencli musinsa options 7035474

# 상품 URL로 옵션 확인
opencli musinsa options https://www.musinsa.com/products/7035474

# 별칭(aliases)도 동일하게 지원
opencli musinsa opt 7035474
opencli musinsa stock 7035474
```

#### 4) 주문 내역 및 구매 사이즈 조회 (`opencli musinsa orders`)
과거 주문 내역을 조회할 때 복잡한 옵션 문구(`[옵션] SAX BLUE / L / 1개`)에서 **사이즈(`size`)**, **옵션(`option`)**, **수량(`qty`)**을 깔끔하게 분리하여 표시합니다:
```bash
# 최근 주문 내역 5개 조회 (size, option, qty 분리 열 출력)
opencli musinsa orders --limit 5

# 전체 기간 주문 내역 조회
opencli musinsa orders --all

# 특정 기간 주문 내역 조회 (1y, 3y, 5y)
opencli musinsa orders --period 3y

# 별칭(aliases) 지원
opencli musinsa purchases --limit 10
opencli musinsa history
```
- **독립된 사이즈 열 (`size`)**: 의류 표준 사이즈(`M`, `L`, `XL`), 신발 사이즈(`270`), 바지/허리 인치(`32`), 숫자 호수(`1`, `2`, `3`)를 지능적으로 파싱하여 별도 컬럼으로 분리합니다.
- **옵션명 및 수량의 깨끗한 격리**: 옵션(`option`) 열에는 불필요한 주문 접두어(`[옵션]`, `옵션 :`)와 수량 문구를 제거한 순수 옵션명만 표시하며, 수량(`qty`)은 별도 열(`1개` 등)로 분리되어 데이터 가독성을 크게 높였습니다.

#### 5) 과거 구매 의류 실측 조회 및 맞춤 필터 변환 (`opencli musinsa mysize`)
무신사에서 과거 구매했던 의류들의 실제 상세 치수(cm)를 카테고리별로 조회하고, 이를 `opencli musinsa search`에서 즉시 사용할 수 있는 실측 필터 문자열로 변환합니다:
```bash
# 과거 구매한 모든 의류의 cm 실측표 조회 (총장, 가슴, 허리, 어깨, 소매, 허벅지)
opencli musinsa mysize

# 상의(top) 카테고리만 실측 조회
opencli musinsa mysize --type top

# 하의(pants) 또는 아우터(outer) 카테고리 실측 조회
opencli musinsa mysize --type pants
opencli musinsa mysize --type outer

# 검색용 실측 필터 인자(--measure "...") 형식으로 변환 출력
opencli musinsa mysize --type top --as-filter

# 허용 오차 범위(tolerance)를 지정하여 필터 생성 (기본값 ±2cm)
opencli musinsa mysize --type top --tolerance 3 --as-filter

# 별칭(aliases) 지원
opencli musinsa my-size --type top
opencli musinsa measurements --type pants
```
- **표시 실측 단위**: `총장(length)`, `가슴(chest)`, `허리(waist)`, `어깨(shoulder)`, `소매(sleeve)`, `허벅지(thigh)` 단면 치수를 cm 단위로 일관되게 정규화합니다.
- **`--type` 옵션**: `all`, `top`, `pants`, `outer` 카테고리 필터링을 지원합니다.
- **`--as-filter` 옵션**: 해당 상품의 실측에 허용 오차(tolerance, 기본 ±2cm)를 반영한 `--measure "총장:70-74,가슴:56-60,어깨:50-54,소매:61-65"` 형태의 검색 인자를 생성해 줍니다.

### 4. macOS 백그라운드 자동 실행 스케줄러 등록
```bash
# 매일 오전 09:30 자동 실행 데몬 설치 (30분 간격 catch-up 포함, 재설치 시 기존 설정 교체)
node src/cli.js daemon-install

# 전원/기상 상태와 다음 daily 틱의 동작 확인
node src/cli.js power-status

# 데몬 삭제
node src/cli.js daemon-uninstall
```

### 5. GitHub Actions에서 실행 (`.github/workflows/daily.yml`)
Mac 없이 GitHub 러너에서 HTTPS 세션만으로 `daily --skip-opencli`를 돌립니다. Chrome이 없으므로 쿠키는 Secret으로 넣습니다.

| 이름 | 종류 | 내용 |
|---|---|---|
| `MUSINSA_COOKIE` | Secret | `app_atk=...; app_rtk=...` (`~/.clot/musinsa-session.json`의 `cookie` 값) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Secret | 알림용 (선택) |
| `ABLY_JWT_TOKEN` | Secret | 4910.kr 로그인 쿠키 `ably-jwt-token` 값 (`4910 tracker`의 쿠폰가·찜 회원가용, 선택) |
| `CLOT_SECRETS_PAT` | Secret | 이 레포의 **Secrets: Read and write** 권한만 준 fine-grained PAT. 실행 중 토큰이 교체되면 `MUSINSA_COOKIE`를 자동 갱신 |
| `CLOT_ACTIONS_DAILY` | Variable | `true`일 때만 매일 09:30(KST) 스케줄 실행 |

```bash
# 쿠키를 Secret으로 올리기 (값이 터미널에 출력되지 않음)
node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(require("os").homedir()+"/.clot/musinsa-session.json")).cookie)' | gh secret set MUSINSA_COOKIE

# 4910 쿠폰가·찜 회원가용 토큰 올리기: 4910.kr에 로그인한 브라우저에서 DevTools → Application → Cookies → https://4910.kr 의
# `ably-jwt-token` 값을 복사한 뒤, 아래 명령이 값을 물어보면 붙여넣기 (입력이 화면에 표시되지 않음)
gh secret set ABLY_JWT_TOKEN

# 러너(데이터센터 IP)에서 무신사 접속·로그인, 4910 접속과 4910 회원 로그인(`4910 member login`) 확인만 (DB 변경 없음)
gh workflow run daily.yml -f mode=probe
```

**4910은 별도 workflow(`.github/workflows/4910.yml`, 이름 `4910 tracker`)입니다.** 매일 10:30(KST)에 스케줄로 돌고(`scan`), 수동 실행은 기본이 `probe`입니다. `scan`은 `4910-db pull` → `track-4910` → `4910-db push`를 차례로 실행하며 앞 단계가 실패하면 멈춥니다. git 커밋은 하지 않고 Release `data-4910`에만 올립니다(`GITHUB_TOKEN`, `contents: write`). 같은 Secret(`ABLY_JWT_TOKEN`, `TELEGRAM_*`)을 씁니다.

```bash
# 러너에서 4910.kr 접속만 확인 (무신사 세션 불필요, DB 변경 없음)
gh workflow run 4910.yml -f mode=probe

# 전체 스캔 (Release에 4910.db.gz 가 먼저 있어야 함 — 위 4910 부트스트랩 참고)
gh workflow run 4910.yml -f mode=scan
```

- 스케줄을 켜기 전에 Mac 데몬을 내리세요 (`daemon-uninstall`). 둘 다 `data/prices.db`를 커밋하면 나중 push가 거절됩니다.
- 세션이 만료되면 job이 실패합니다(GitHub 알림 메일). Mac에서 로그인한 뒤 위 명령으로 Secret을 다시 올리면 됩니다.

### 6. 대시보드 웹 배포 (GitHub Pages)
`.github/workflows/pages.yml`이 커밋된 `data/prices.db`로 대시보드를 빌드해 Pages에 올립니다. `data/prices.db` push(Mac 데몬), `Daily price tracker`·`4910 tracker` Actions 완료 후, 수동 실행(`gh workflow run pages.yml`)에 갱신됩니다. 빌드 전에 Release `data-4910`에서 `4910.db`를 내려받아 쓰며, 받지 못해도 배포는 실패하지 않습니다.

👉 **https://jjundev.github.io/project-clot/**

- 최초 1회: 저장소 **Settings → Pages → Source: GitHub Actions** 로 설정해야 합니다.
- 페이지에는 `noindex`와 `robots.txt`로 검색 색인을 막았습니다. 접근 제한은 아니며, 저장소가 공개이므로 `data/prices.db`와 `data/latest_prices.json`은 누구나 내려받을 수 있습니다. Release `data-4910`의 `4910.db.gz`(찜 목록·쿠폰함 내역 포함)와 Pages에 함께 올라가는 `4910/` 브랜드별 파일(판매글·쿠폰가 목록)도 마찬가지로 공개됩니다.
- 4910 쪽 빌드가 실패하면(Release에서 DB를 받지 못함·DB 손상) `4910 전체` 칩은 숨겨지고 무신사 대시보드는 그대로 배포됩니다. 이때 빌드 로그에 `4910.db not available` 또는 `4910 index not built` 경고가 남습니다.
- 표시 데이터는 마지막으로 커밋된 DB 기준입니다. 로컬 `visualize`가 더 최신일 수 있습니다.

---

## 🔔 (선택) 텔레그램 알림 설정

가격 하락 시 스마트폰으로 텔레그램 알림을 받고 싶다면:
1. `.env.example`을 복사하여 `.env` 생성:
   ```bash
   cp .env.example .env
   ```
2. 텔레그램 `@BotFather`에서 발급받은 봇 토큰과 내 채팅 ID를 입력합니다:
   ```env
   TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrs
   TELEGRAM_CHAT_ID=12345678
   ```

### 대시보드 출처와 필터

대시보드의 출처는 **전체 / 무신사 / 4910**입니다. 전체는 두 출처의 합집합이며, 4910 찜 상품과 일반 수집 상품이 겹치면 찜의 회원가를 우선해 한 번만 집계합니다. 다른 쇼핑몰의 같은 숫자 상품 번호는 별개 상품입니다.

**브랜드 선택**은 모든 출처에서 공통으로 사용합니다. 여러 브랜드를 고르면 그중 하나에 속한 상품을 표시합니다. 출처를 바꿔도 선택은 유지되며, 해당 출처에 없는 브랜드는 0건으로 표시하고 해제할 수 있습니다. 브랜드 선택은 새로고침하면 초기화됩니다.

필터 옆 숫자는 검색어와 다른 필터를 적용한 상태에서 그 항목을 선택했을 때의 건수입니다. 출처 집계는 현재 출처 조건을, 브랜드 집계는 현재 브랜드 조건을 제외합니다. 카테고리와 빠른 필터도 같은 원칙을 따릅니다. 상단 지표는 빠른 필터의 집계를 사용합니다. 최저가와 하락은 겹칠 수 있지만, 전체는 항상 판매중과 품절의 합입니다. 하락은 직전 관측과 같은 가격 기준으로 비교합니다.

전체 상품의 검색·가격 요약을 모두 받은 뒤 집계하고, 카드는 120개씩 표시합니다. 상세 가격 이력은 상품을 열 때만 받습니다. 로딩·실패·수집 DB 미포함 상태를 별도로 안내하며, 다른 빌드의 파일이 섞이면 재시도를 제공합니다. 생성 HTML과 옆의 `4910/` 폴더를 함께 보관하면 로컬 파일로도 열 수 있습니다.

검증 명령:

```sh
npm ci
npm test
npx playwright install chromium
npm run test:dashboard:browser
node scripts/verify-dashboard-build.js /absolute/path/to/index.html
```

브라우저 검증에 설치된 Chrome을 쓰려면 `CLOT_BROWSER_EXECUTABLE`에 실행 파일 경로를 지정합니다. 산출물 검증기는 요약·상세의 revision, 식별자, 건수와 가격 지표를 교차 확인하며 실패 시 0이 아닌 종료 코드를 반환합니다.

### 4910 가격 재검증
4910 가격은 AGLO 웹, 옵션 수량 1, 쿠폰 1장, 포인트 차감 전 기준이다. 쿠폰 후보가 있어도
`is_applied`가 참이 아니면 적용가로 기록하지 않는다. 전체 스캔의 판매처 표본을 다른 상품의
적용 증거로 쓰지 않으며, 완전한 상품 대상 목록과 보존된 단품 조건이 있는 경우에만 확장한다.
미검증 가격은 차트·최저가·하락 비교에서 제외한다.

Release DB를 별도 경로에 내려받아 아래 명령으로 조사한다. 기본 실행은 읽기 전용이다.

```sh
node scripts/4910-price-revalidate.js --db /tmp/4910-copy.db --from 2026-10-11 --to 2026-10-16 --out /tmp/4910-report.json
```

`--live`는 현재 찜 전건과 판매처 30곳의 표본을 읽기 전용으로 대조한다(회원 토큰 필요).
현재 응답은 과거 정답으로 사용하지 않는다. `--apply`는 SHA256이 같은 백업을 만든 후
`price_validations`만 추가·갱신한다. 실행 대상은 쓰기 중이 아닌 독립 DB 복사본이어야 한다.
비어 있는 입력·날짜 오류·인증 실패는 CLI 실패로 보고한다. 원격 Release와 Pages는 자동 갱신하지 않는다.
상세 결과는 [2026-10-16 재검증 보고서](docs/verify/2026-10-16-4910-price-revalidation.md)를 참고한다.

### 4910 전체 상품 가격 검증

`4910 full price verification` Actions는 일반 4910 수집 성공 후 전체 활성 상품과 찜 상품을
32개 파티션으로 검증한다(동시 파티션 8개, 파티션별 클라이언트 2개). 판매처 표본을 다른
상품으로 일반화하지 않고, 상품 상세의 AGLO 기준 가격·옵션과 `best-coupon`의 실제 적용
여부를 확인한다. 일부 쿠폰 목록에 포함된 상품은 우선 확인하지만, 목록 누락을 적용 불가로
해석하거나 후보 쿠폰만으로 최적가를 확정하지 않는다.

원본 Release DB 스냅샷, 날짜, 보유 쿠폰 조건 지문이 일치할 때만 결과를 병합한다. 같은 날의
원본 가격 이력은 보존하고 검증 메타데이터로 정정한다. 삭제·품절·쿠폰 미적용은 미검증 사유로,
통신 실패·시간 제한은 `pending`으로 구분한다. `verification-summary` artifact에 전체·검증·미검증·
대기 건수가 남는다. 실패한 작업을 재실행하면 파티션 checkpoint를 복원하고, 새 전체 실행은
Release DB에 이미 저장된 같은 날·같은 쿠폰·같은 목록가의 검증 결과를 재사용한다.

수동 재실행: `gh workflow run 4910-full.yml --ref main`. 성공 후 Pages가 자동 재배포된다.
쿠폰을 자동 발급하거나 구매·장바구니 상태를 변경하지 않는다.


### 무신사 30만 상품 웹 가격

Pages는 `data-musinsa` Release의 `musinsa-wide.db.gz`를 읽어 무신사 대량 수집 가격도 표시한다. 하루 고유 조사 대상 300,000개와 사이트에서 제공하는 ACTIVE 상품 수는 다르다. 이전 회차 잔류 상품과 기존 찜 목록의 추가 상품이 포함될 수 있다.

카드와 상세에 직접 확인 가격 / 확인된 혜택 기준 추정가 및 기준일을 표시한다. 추정가에는 확인하지 못한 쿠폰 혜택이 빠질 수 있으며 쿠폰 목록 API 예외 번호를 화면에 경고한다. 추정가를 확정된 가격 하락이나 역대 최저가로 표시하지 않는다. 상품 요약과 가격 이력은 `musinsa/`에 분할하며 이력은 상세를 열 때 읽는다. 원시 회원 응답이나 쿠키를 정적 파일에 넣지 않는다.

로컬에서도 `node src/cli.js musinsa-db pull` 뒤 `node src/cli.js visualize --no-open`으로 연결할 수 있다. 입력 경로는 `CLOT_MUSINSA_WIDE_DB_PATH`로 지정한다. Pages는 `CLOT_REQUIRE_MUSINSA_WIDE=1`로 필수 DB 및 일일 가격 출처 검증 실패 시 배포를 중단한다. `Musinsa wide scan` 성공 후 자동 재배포한다.

### 대시보드 데이터 로딩

첫 화면은 빌드 시 계산한 120개 상품과 정확한 기본 집계로 표시한다. 전체 검색 인덱스는 HTTP에서 Web Worker가 백그라운드로 읽으며, 검색·필터 결과는 전체 인덱스 준비 후 표시한다. 파일로 열 때는 같은 조회 엔진을 사용하는 대체 경로를 쓴다. 카드 목록은 페이지마다 120개를 받고 화면에는 최대 360개를 유지한다.

상세 가격 이력은 상품 최신 관측일 기준 **최근 90일**이 기본이다. **전체**를 선택하면 이전 이력 파일을 추가로 읽는다. 기간 이전 마지막 가격은 이월 기준으로 구분하며, 원본 DB 이력과 역대 최저가 판정은 보존한다. 각 이력 파일은 원문 256KiB 이하, 성공한 이력 파일 캐시는 원문 16MiB 이하의 LRU로 제한한다. 이 값은 브라우저 전체 메모리 상한을 뜻하지 않는다. 전체 검색 준비 비용은 상품 수에 따라 증가한다.

같은 날 4910 목록 재수집으로 검증 메타데이터가 초기화돼도, 최근 성공한 전체 검증 작업의 artifact에서 날짜·쿠폰 조건·현재 목록가·상품번호가 모두 일치하는 결과를 복원한다. 더 최근의 관측이 우선하며, 조건이 바뀐 상품은 다시 조회한다.
