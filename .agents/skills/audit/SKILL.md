---
name: audit
description: >
  Audit Project-Clot daily price collection health and OpenCLI authentication integrity.
  Triggers on: (1) daily collection status inquiries ("오늘 가격 수집 잘 됐어?", "수집 문제 없었나", "수집 상태 점검"),
  (2) OpenCLI / browser bridge inquiries ("opencli 수집 성공했어?", "회원가 정상 수집됐나"),
  (3) explicit /audit command.
---

# /audit — Project-Clot 일일 수집 건전성 감사 스킬

Project-Clot의 일일 수집(Daily Run) 결과, OpenCLI 크롬 브릿지 인증 성공률, 품목 결측 여부, 로그 에러를 5대 핵심 지표로 상호 대조(`Cross-Check`)하여 객관적 팩트(`Ground Truth`)에 기반한 판정(`Verdict`)을 보고합니다.

## 핵심 선도 개념 (Leading Concepts)

- **`Ground Truth` (원천 팩트)**: 추측성 진단 금지. DB(`daily_runs`, `price_logs`), 시스템 로그(`daily.log`, `daily.err`), 산출물(`dashboard.html`)의 실측치만 인용합니다.
- **`Cross-Check` (상호 대조)**: 활성 VIP 품목 수와 당일 수집 품목 수를 대조하여 결측을 1개 단위로 감지합니다.
- **`Verdict` (판정)**: 모든 차원은 타협 없이 `[PASS]`, `[WARN]`, `[FAIL]`로 엄격히 판정합니다.
- **`Remediation` (처방)**: `WARN`이나 `FAIL` 발생 시 모호한 원인 설명에 그치지 않고, 즉시 실행 가능한 **단일 복구 명령어**를 사용자에게 제시합니다.

---

## 실행 절차 (Procedure)

### Step 1. 원천 팩트 획득 (`Ground Truth`)
- **실행**: 프로젝트 CLI의 감사 엔진을 호출합니다.
  - 특정 날짜가 주어지면:
    ```bash
    node src/cli.js audit <YYYY-MM-DD> --json
    ```
  - 날짜가 생략되면 (오늘 기준):
    ```bash
    node src/cli.js audit --json
    ```
- **Completion Criterion**: 5대 지표 및 수치(총 품목수, `my_price` 수집률, 에러수, 가격 인하 품목)가 포함된 유효한 JSON 출력을 확보해야 완료됩니다. CLI 실행이 차단되거나 실패할 경우, DB 직접 쿼리(`sqlite3 data/prices.db`)와 `logs/daily.log` 확인으로 대체합니다.

### Step 2. 5대 차원 판정 (`Cross-Check` & `Verdict`)
획득한 감사 데이터를 다음 5개 기준에 따라 평가합니다:

| # | 차원 | PASS 기준 | WARN 기준 | FAIL 기준 |
|---|---|---|---|---|
| 1 | **Run Status** | `mode === 'full'` 완료 | `mode === 'deferred'` 또는 `degraded` | 당일 실행 기록 없음 (미수집 또는 중단) |
| 2 | **Catalog Coverage** | `missingCount === 0` (100% 수집) | - | `missingCount > 0` (일부 또는 전체 누락) |
| 3 | **OpenCLI Auth** | `authPercent === 100%` (회원가 전건 확보) | 1% ~ 99% 또는 Deferred 모드 | `0%` (Full 모드임에도 회원가 전무) |
| 4 | **Log Cleanliness** | 0 fatal errors, 0 서킷 브레이커 | - | fatal error > 0 또는 서킷 브레이커 발동 |
| 5 | **Artifact Sync** | `dashboard.html` 및 `latest_prices.json` 갱신 | 파일 중 하나 누락/오래됨 | 둘 다 미생성 |

- **Completion Criterion**: 5개 차원 각각에 대해 구체적 수치와 함께 `PASS`, `WARN`, `FAIL` 중 하나의 판정이 명확히 매핑되어야 완료됩니다.

### Step 3. 브리핑 및 처방 제시 (`Remediation`)
- **출력 구성**:
  1. **종합 판정 (Overall Verdict)**: `PASS` / `WARN` / `FAIL`
  2. **5대 차원 체크리스트**: 각 지표별 판정 아이콘과 구체적 수치 요약.
  3. **가격 변동 내역**: 오늘 감지된 가격 인하 품목 Top 3~5 (브랜드, 품목명, 기존가 → 할인가, 인하율).
  4. **처방 (Remediation)**: `WARN` 또는 `FAIL`이 있을 경우, 해결을 위해 즉시 복사해 실행할 수 있는 명령어 제시:
     - 슬립으로 인한 지연: `node src/cli.js daily --force --assume-awake`
     - 로그인 세션 만료: `opencli musinsa my-prices 595040` 확인 안내
     - 대시보드 미갱신: `node src/cli.js visualize --no-open`
- **Completion Criterion**: 요약 체크리스트, 가격 인하 내역, 그리고 상태에 따른 처방이 포함된 응답을 사용자에게 전달해야 완료됩니다.
