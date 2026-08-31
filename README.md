# 👔 Project-Clot (무신사 가격 추적 및 위시리스트 관리 시스템)

> **무신사 관심 상품의 실시간 가격, 브랜드 쿠폰가, 품절/재입고 상태를 매일 자동으로 추적하고 기록하는 로컬 백그라운드 시스템**

---

## ✨ 핵심 기능

1. **자동 위시리스트 동기화 (`sync`)**
   - 무신사 계정에서 좋아요(하트)를 누른 상품 목록(175개+)을 자동으로 가져와 로컬 DB에 등록합니다.
   - 좋아요를 취소한 상품은 과거 가격 기록을 보존한 채 소프트 삭제(`UNLIKED`) 처리하여 리소스를 절약합니다.

2. **나의 할인가 & 쿠폰 추적 (`track`)**
   - 일반 판매가뿐만 아니라 **회원 등급 할인, 브랜드 쿠폰, 적립금 선할인**이 모두 적용된 **'나의 최종 실구매가'**를 시계열로 기록합니다.

3. **하루 1회 실행 보장 데몬 (`launchd`)**
   - macOS 백그라운드 서비스(`launchd`)로 매일 오전 09:30에 조용히 실행됩니다.
   - 그 시간에 맥북이 꺼져 있었어도 부팅 시 1회 즉시 실행되며, 하루에 맥북을 여러 번 껐다 켜도 **'Daily Lock'** 메커니즘을 통해 무조건 하루 1번만 실행됩니다.

4. **수동 관심 상품 등록 (`watch`)**
   - 무신사 좋아요를 누르지 않고도 특정 상품 URL이나 번호(`goodsNo`)만으로 개별 추적이 가능합니다.

5. **가격 하락 & 재입고 알림 (`notifier`)**
   - 가격이 어제보다 떨어졌거나 **역대 최저가**를 갱신했을 때, 또는 품절 상품이 **재입고**되었을 때 macOS 화면 알림(배너) 및 텔레그램 봇으로 즉시 알림을 발송합니다.

6. **Git 자동 백업**
   - 수집된 데이터는 `data/latest_prices.json` 및 `data/prices.db`에 저장되며, 깃 저장소에 자동 커밋 & 푸시되어 클라우드 백업이 유지됩니다.

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
```

### 3. macOS 백그라운드 자동 실행 스케줄러 등록
```bash
# 매일 오전 09:30 자동 실행 데몬 설치
node src/cli.js daemon-install

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
