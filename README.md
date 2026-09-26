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

---

## 📁 디렉토리 구조

```text
~/Documents/Private/project-clot/
├── data/
│   ├── prices.db            # SQLite 데이터베이스 (시계열 가격 로그 & 상품 메타데이터)
│   └── latest_prices.json   # Git 저장소 공유용 최신 가격 스냅샷
├── logs/                    # 데몬 실행 로그 (daily.log)
├── src/
│   ├── cli.js               # 통합 CLI 진입점
│   ├── db.js                # SQLite 데이터베이스 레이어 (node:sqlite)
│   ├── collector.js         # 상품 가격, 쿠폰, 품절 상태 수집기
│   ├── sync.js              # 무신사 좋아요 목록 증분 동기화
│   └── notifier.js          # macOS 데스크톱 및 텔레그램 알림 발송
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
