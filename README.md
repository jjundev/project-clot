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

9. **4910 유니클로·GU 추적 (`track-4910`)**
   - [4910.kr](https://4910.kr)(에이블리 남성관)에 올라온 **유니클로·GU 판매글 전체**(약 1.6만 개)를 `daily` 실행 때마다 함께 스캔해 `data/4910.db`에 저장합니다.
   - 4910의 유니클로·GU는 공식몰이 아니라 일본 구매대행 셀러의 판매글이므로, 판매글 번호(`sno`) 단위로 추적합니다. 같은 제품이라도 셀러별로 따로 기록됩니다.
   - 이력은 **바뀔 때만** 남깁니다(신규·가격변동·종료·재등장). 완전한 스캔에서 2회 연속 보이지 않은 판매글은 종료(`DROPPED`)로 처리하고, 다시 보이면 재등장으로 되살립니다.
   - 텔레그램으로 하루 1통, 브랜드별 스캔 수와 직전 기록가 대비 **10% 이상 하락한 상위 10개**를 보냅니다.
   - **찜한 상품의 회원가**: 4910.kr에서 찜(하트)한 상품을 `ABLY_JWT_TOKEN`으로 불러와 하루 한 번 **내 회원가**를 함께 기록합니다. 대시보드에서는 `4910 찜` 필터로 찜 상품만 모아 **표시가 / 쿠폰적용가(신규회원 기준) / 내 회원가** 세 가격을 한 카드에서 비교합니다. 회원가는 보통 쿠폰적용가보다 조금 높은데, 쿠폰적용가에는 신규회원 첫 구매 쿠폰이 포함되기 때문입니다.
   - **대시보드 출처 필터**: `전체`(무신사 + 4910 찜) · `무신사` · `4910 찜` · `4910 전체`. `4910 전체`는 스캔한 판매 중 판매글 전부를 보여 주며, 찜한 판매글은 찜 데이터(회원가 포함)로 한 번만 나옵니다. 찜하지 않은 판매글은 **표시가만** 있고 회원가는 없습니다. 하락 표시는 마지막 완료 스캔에서 가격이 내려간 판매글에만 붙습니다.
   - 판매글 목록은 `index.html` 옆의 별도 파일 `4910-all.js`(약 4MB, gzip 약 1MB)에 담겨, `4910 전체`를 처음 누를 때만 내려받습니다. 카드는 120개씩 그리고, 스크롤하거나 `더 보기`를 누르면 더 그립니다.
   - 로그인 쿠키에는 갱신 수단이 없어서, 만료되면 텔레그램 요약에 `⚠️ 4910 로그인 만료 — ABLY_JWT_TOKEN 갱신 필요`가 붙습니다. 이때 Secret을 다시 올리세요. 토큰이 없으면 찜 동기화만 건너뜁니다. 찜 동기화가 그 밖의 이유로 실패하면 `⚠️ 4910 찜 가격 기록 실패 — Actions 로그 확인`이 붙습니다.
   - 4910 수집이 실패해도 무신사 수집·커밋은 그대로 진행됩니다(`⚠️ [4910] 수집 실패` 로그만 남음).
   - `daily` 안에서 자동으로 돌고(`--skip-4910`으로 제외), 단독 실행은 `track-4910 [--brand uniqlo|gu] [--dry-run]`입니다.
   - ⚠️ **로컬(Mac)에서는 `--dry-run`으로만 실행하세요.** `data/4910.db`는 GitHub Actions가 매일 커밋하는 파일이라, 로컬에서 쓰면 다음 `git pull`이 덮어쓰기를 거부하고 텔레그램 요약도 한 통 더 갑니다. 로컬에 따로 쌓고 싶다면 `CLOT_4910_DB_PATH=/tmp/4910.db node src/cli.js track-4910`처럼 경로를 바꾸세요.

---

## 📁 디렉토리 구조

```text
~/Documents/Private/project-clot/
├── data/
│   ├── prices.db            # SQLite 데이터베이스 (시계열 가격 로그 & 상품 메타데이터)
│   ├── 4910.db              # 4910 유니클로·GU 판매글 & 변동 이력
│   └── latest_prices.json   # Git 저장소 공유용 최신 가격 스냅샷
├── logs/                    # 데몬 실행 로그 (daily.log)
├── src/
│   ├── cli.js               # 통합 CLI 진입점
│   ├── db.js                # SQLite 데이터베이스 레이어 (node:sqlite)
│   ├── collector.js         # 상품 가격, 쿠폰, 품절 상태 수집기
│   ├── sync.js              # 무신사 좋아요 목록 증분 동기화
│   ├── notifier.js          # macOS 데스크톱 및 텔레그램 알림 발송
│   └── site4910/            # 4910.kr 유니클로·GU 스캔 (client, store, track, digest)
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

# 4910 유니클로·GU 스캔 결과만 확인 (DB에 쓰지 않음, 텔레그램 없음)
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
| `ABLY_JWT_TOKEN` | Secret | 4910.kr 로그인 쿠키 `ably-jwt-token` 값 (찜 상품 회원가, 선택) |
| `CLOT_SECRETS_PAT` | Secret | 이 레포의 **Secrets: Read and write** 권한만 준 fine-grained PAT. 실행 중 토큰이 교체되면 `MUSINSA_COOKIE`를 자동 갱신 |
| `CLOT_ACTIONS_DAILY` | Variable | `true`일 때만 매일 09:30(KST) 스케줄 실행 |

```bash
# 쿠키를 Secret으로 올리기 (값이 터미널에 출력되지 않음)
node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(require("os").homedir()+"/.clot/musinsa-session.json")).cookie)' | gh secret set MUSINSA_COOKIE

# 4910 찜 상품 회원가용 토큰 올리기: 4910.kr에 로그인한 브라우저에서 DevTools → Application → Cookies → https://4910.kr 의
# `ably-jwt-token` 값을 복사한 뒤, 아래 명령이 값을 물어보면 붙여넣기 (입력이 화면에 표시되지 않음)
gh secret set ABLY_JWT_TOKEN

# 러너(데이터센터 IP)에서 무신사 접속·로그인, 4910 접속과 4910 회원 로그인(`4910 member login`) 확인만 (DB 변경 없음)
gh workflow run daily.yml -f mode=probe
```

- 스케줄을 켜기 전에 Mac 데몬을 내리세요 (`daemon-uninstall`). 둘 다 `data/prices.db`를 커밋하면 나중 push가 거절됩니다.
- 세션이 만료되면 job이 실패합니다(GitHub 알림 메일). Mac에서 로그인한 뒤 위 명령으로 Secret을 다시 올리면 됩니다.

### 6. 대시보드 웹 배포 (GitHub Pages)
`.github/workflows/pages.yml`이 커밋된 `data/prices.db`로 대시보드를 빌드해 Pages에 올립니다. `data/prices.db`·`data/4910.db` push(Mac 데몬), daily Actions 완료 후, 수동 실행(`gh workflow run pages.yml`)에 갱신됩니다.

👉 **https://jjundev.github.io/project-clot/**

- 최초 1회: 저장소 **Settings → Pages → Source: GitHub Actions** 로 설정해야 합니다.
- 페이지에는 `noindex`와 `robots.txt`로 검색 색인을 막았습니다. 접근 제한은 아니며, 저장소가 공개이므로 `data/prices.db`와 `data/latest_prices.json`은 누구나 내려받을 수 있습니다. `data/4910.db`(찜 목록 포함)와 Pages에 함께 올라가는 `4910-all.js`(판매글 목록)도 마찬가지로 공개됩니다.
- 4910 쪽 빌드가 실패하면(DB 없음·손상) `4910 전체` 칩은 숨겨지고 무신사 대시보드는 그대로 배포됩니다. 이때 빌드 로그에 `4910-all.js not built` 경고가 남습니다.
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
