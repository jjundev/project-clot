# 대시보드 배포 OOM 수정 검증 — 2026-10-25

Native 방식으로 조회 함수 → 생산 adapter → Pages 계측을 구현했다. 실제 입력 430,353개 상품의 생성과 전체 asset/history 검증이 각각 4GiB V8 힙 제한에서 종료 코드 0으로 완료됐다. 4910이 포함된 `scanState=complete`이며 전체 상품 key 집합도 독립 SQL 기대값과 일치한다. 원격 Pages 게시와 Ubuntu 러너 실측은 아직 수행하지 않았다.

## 원인과 변경

[기존 실패 실행](https://github.com/jjundev/project-clot/actions/runs/40102747613/job/120898080493)은 생성 중 SQLite `.all()`에서 약 4GB 힙 OOM으로 종료했다. 희소한 상품 ID 범위가 다른 브랜드까지 포함했고 거대한 `evidence_json`을 함께 적재했다. 이번 변경은 모든 조회 조건을 AND로 적용하고, 생산 adapter가 선택한 ACTIVE·찜 제외 상품 ID만 최대 200개씩 바인딩한다. 스캔 export는 증빙 열을 SELECT하지 않는다. 기본 증빙 포함 조회, 찜·재검증, 가격 보정, 전체 날짜 이력과 공개 v2 형식은 유지한다.

Pages는 생성과 검증을 별도 named step으로 분리하고 각각 `/usr/bin/time -v`와 `--max-old-space-size=4096`을 사용한다. helper 변경도 배포 검사를 실행하며 가격 검증 회귀 테스트를 포함한다. 데이터 삭제, 힙 상한 증설, 검증 생략, 검증기 재설계는 하지 않았다.

## 환경과 자동 검사

- 기준 커밋: `c3ca69af222f37c616797da2f55eaa788a2aebe5`.
- 작업 브랜치: `codex/dashboard-deploy-memory`.
- 최종 검증 환경: macOS arm64, Node `v24.17.0`, 기존 Playwright `1.62.1`.
- 최초 baseline: 기본 PATH의 Node `v26.4.0`에서 1,085/1,085 통과. 환경 차이를 확인한 뒤 최종 전체 테스트·브라우저·실데이터 생성·검증을 Node 24로 다시 실행했다. Node 26 측정값은 아래 최종 수치에 섞지 않았다.
- Node 24 `npm test`: **1,096/1,096**, 실패·취소·skip 0. `tests/helpers/dashboard-memory-probe.js`는 독립 test로 발견되지 않는다.
- Node 24 `npm run test:dashboard:browser`: **50/50**, 실패·취소·skip 0. HTTP/file, 440,129개 합성 목록, 상세·검색·브랜드·가격·적립금 UI 회귀를 포함한다.
- 조회 계약 red: 브랜드+범위 교집합, 빈 목록, 증빙 projection, 목록 분할, 잘못된 필터의 5개 테스트가 기존 구현에서 실패한 뒤 통과했다.
- 생산 연결 red: 기대 ID `[1,100000]` 대신 `[1,60000,70000,100000]`을 읽는 assertion 실패를 확인한 뒤 통과했다. 결과만 숨기고 불필요한 검증 이력을 읽는 구현도 잡는다.
- workflow red: helper trigger와 독립 검증 단계 누락으로 2개 실패한 뒤 통과했다.
- 512MiB 회귀: 무관한 320개 상품에 약 960MiB UTF-8 증빙을 가진 임시 DB로 자식 프로세스를 실행했다. `--max-old-space-size=512`에서 종료 코드 0, signal 없음, 대상 2개·이력 2개 및 정가 90000/보정판매가 75900/보정가격 72110을 확인했다. 이는 전체 실데이터 빌드가 512MiB에서 된다는 의미는 아니다.

## 고정 입력

취득 시각: `2026-10-25T01:31:30Z` (10:31:30 KST). 운영 watched DB는 Python SQLite backup API로 일관된 사본을 만들었다. 4910은 조사 때 받은 압축 파일의 Release digest와 재사용 DB의 압축 해제 SHA-256을 모두 확인했다. wide는 새로 다운로드했다. 저장소 변수 `CLOT_MUSINSA_POINTS_ENABLED=1`을 조회해 생성에 그대로 적용했다.

| 입력 | 최신 수집일 | bytes | SHA-256 |
|---|---|---:|---|
| watched `prices.db` 사본 | 2026-10-24 | 1,269,760 | `79c9cf662fb46b444cfc1d1b6bf6d2f223b1cd0ff1ee1c02fd7c19019009d8a9` |
| Release `data-4910/4910.db.gz` 해제본 | 2026-10-24 | 1,309,908,992 | `48ae83c09279f104dc9af8f37a672b22d11156151722eeef4e5994e7b4de3c42` |
| Release `data-musinsa/musinsa-wide.db.gz` 해제본 | 2026-10-24 | 268,201,984 | `11e077c2654849866f48f1446bcd210e09453617cad46b3bb1ae5f7216095772` |

압축 asset의 digest:

- `4910.db.gz`: `703509f3d837e9d079f6378595c892b61176f795fe3e7c3a109611829e38d305`, 149,519,586 bytes, Release updated `2026-10-24T11:49:38Z`.
- `musinsa-wide.db.gz`: `2f5ae04911884c44f72fc07a3c7d903a0ba1faf961d5092b996829182c50f0de`, 66,205,156 bytes, Release updated `2026-10-25T01:29:21Z`.

실행 전후 위 입력 사본 세 개의 SHA-256이 모두 동일했다. 운영 원본 `data/prices.db`도 전후 `17b31c72f95bf786dec0c5af14d2f57e0ec16984cf966cfd9118de3adefb110f`로 동일했다. backup으로 만든 DB는 헤더 차이 때문에 원본과 파일 hash가 다르다. 운영 원본과 기존 미추적 `data/4910-all.js`는 수정·삭제·스테이징하지 않았다.

## 독립 대상 대조

각 DB를 read-only로 열어 다음 SQL로 ID 집합을 계산했다. watched와 wide의 key는 `musinsa:<id>`, 4910은 `4910:<id>`로 구성했다. 빌드의 summary 함수를 기대값 계산에 쓰지 않았다.

```sql
-- wide
SELECT goods_no FROM wide.goods WHERE status='ACTIVE';
-- wide에 없는 watched
SELECT goods_no FROM watched.items
WHERE status IN ('ACTIVE','SOLDOUT')
AND goods_no NOT IN (SELECT goods_no FROM wide.goods WHERE status='ACTIVE');
-- 4910 찜
SELECT sno FROM scan.liked_goods WHERE status='ACTIVE';
-- 찜에 없는 4910 scan
SELECT sno FROM scan.goods WHERE status='ACTIVE'
AND sno NOT IN (SELECT sno FROM scan.liked_goods WHERE status='ACTIVE');
```

| 대상 | 기대 건수 |
|---|---:|
| Musinsa wide ACTIVE | 301,672 |
| wide에 없는 watched ACTIVE/SOLDOUT | 70 |
| 4910 ACTIVE liked | 9 |
| 찜에 없는 4910 ACTIVE scan | 128,602 |
| 합계 | **430,353** |

생성된 indexParts 715개를 실제로 로드하고 `unpackIndex`한 전체 key를 정렬해 독립 SQL 집합과 정확히 비교했다. 중복 key 없음, Musinsa 301,742개·4910 128,611개, manifest total 430,353개가 모두 일치했다. `has4910All=true`, `scanState=complete`, 적립금 `enabled=true`도 확인했다. 이어 기존 verifier로 모든 연결된 card·history·route·preview와 가격 summary 정합성을 검증했다.

검증기 stdout:

```json
{"totalItems":430353,"total4910":128611,"scanState":"complete"}
```

## 생성·검증 메모리와 실행 시간

각각 별도 Node 프로세스에 `--max-old-space-size=4096`을 지정했다. macOS `/usr/bin/time -l`의 maximum resident set size는 bytes라서 KiB로 나눠 기록했다. RSS와 V8 힙 상한은 다른 지표다. 아래 수치는 로컬 1회 측정이며, 같은 시기에 브라우저 검사도 진행해 성능 벤치마크나 Ubuntu 소요 시간 보장으로 사용하지 않는다.

| 프로세스 | exit | real (초) | 최대 RSS (bytes) | 최대 RSS (KiB) | 최대 RSS (GiB) |
|---|---:|---:|---:|---:|---:|
| 전체 생성 | 0 | 52.24 | 1,527,758,848 | 1,491,952 | 1.42 |
| 전체 검증 | 0 | 47.98 | 3,730,096,128 | 3,642,672 | 3.47 |

macOS가 별도로 보고한 peak memory footprint는 생성 1,845,074,288 bytes, 검증 4,947,721,760 bytes였다. 이 값도 RSS 및 V8 힙과 동일시하지 않는다. 검증기는 여전히 전체 archive를 보유하므로 향후 데이터 증가 시 재측정할 필요가 있다. 이번 스냅샷에서 검증기 OOM은 없었으므로 재설계는 추가하지 않았다. 이전 실패와 입력·환경이 완전히 같지 않으므로 개선 배율을 주장하지 않는다.

재현 명령 (`RUN_DIR`는 입력 사본과 빈 출력 디렉터리가 있는 작업 경로, PATH는 Node 24):

```bash
CLOT_DB_PATH="$RUN_DIR/prices.db" \
CLOT_4910_DB_PATH="$RUN_DIR/4910.db" \
CLOT_MUSINSA_WIDE_DB_PATH="$RUN_DIR/musinsa-wide.db" \
CLOT_DASHBOARD_PATH="$RUN_DIR/site/index.html" \
CLOT_REQUIRE_MUSINSA_WIDE=1 CLOT_MUSINSA_POINTS_ENABLED=1 \
/usr/bin/time -l node --max-old-space-size=4096 src/cli.js visualize --no-open

/usr/bin/time -l node --max-old-space-size=4096 \
  scripts/verify-dashboard-build.js "$RUN_DIR/site/index.html"
```

Ubuntuでは `/usr/bin/time -v`を使う。Pagesの timeout 20分・取得方針・upload前検証を維持した。ローカル生成＋検証は合計100.22秒で完了したが、Actions全体の20分以内完了は今回未確認。

作業データ・生ログ・独立比較スクリプトは `/tmp/clot-dashboard-verify.YyWxKf/`に保持している。入力情報 `inputs.json`、期待集合 `expected-keys.json`、比較結果 `key-comparison.json`、前後 hash `hash-comparison.json`、`build.*`、`verify.*`がある。DB本体や巨大な証拠 JSONはgitに追加していない。

## 公開状態

ローカルでの実装・生成・検証は完了。mainへの統合、push、Pages実行と公開URLの確認はまだ行っていない。ローカル成功を公開成功として扱わない。

## 독립 리뷰

별도 리뷰어가 `c3ca69a..913b3f3` 전체 변경과 spec·계획·실데이터 생로그를 검토했다. Critical / Important / Minor 지적과 판단 유보 항목은 모두 없으며 병합 가능으로 판단했다. Node 24에서 관련 테스트 67개를 독립 재실행해 모두 통과했다. 대규모 생성·검증은 중복 실행하지 않고 원시 결과와 key·hash 대조를 확인했다.
