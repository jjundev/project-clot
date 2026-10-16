# 확인된 혜택 기준 추정 쿠폰가

사용자가 권고안1을 명시 승인했다. 정상완주 목록+최근 직접조회로 추정 쿠폰가를 계산하며 공개API가 제공하지 않는 쿠폰은 예외로 명시한다. HTTP/스키마/페이지 반복/deadline/429는 여전히 실패다. 기존 매핑과 일일회원200+200한도, 이력은 보존한다.

## 계약

- walk.exceptions:number[]는 정상종료된 빈 목록과 저장회원쿠폰이 충돌한 쿠폰ID만 포함한다. 이때 기존매핑 보존, failed에는 포함하지 않는다. complete는 여전히 전체목록완주만 뜻하므로 예외가 있으면false이다. failedCoupons는 진짜실패만이다. remaining=requested-walked (예외포함). 정상처리 기준은 실패/stop없고 walked+예외고유수=requested인 경우다. 이 조건을 검증하는 pricingCoverage(walk)를 공용으로 사용한다.
- goods.coupon_price_source와 coupon_price_changes.source(nullable TEXT)를 additive로 추가한다. 기존행값을 재작성하지 않는다. 복구는 이전DB백업+이전코드로가능하며 이전코드는추가nullable열을무시한다.
- 오늘 직접조회했고 sale/extra가 조회당시와같은 상품은 오늘 유효한 직접반환쿠폰만으로 계산, DIRECT로 저장한다. 나머지는 완주매핑과기존10일직접캐시로계산하고 ESTIMATED. 확인조건이 다른경우는 추정으로낮춘다. 금액NULL이면sourceNULL. 과거sourceNULL은확인가로추측하지않는다.
- 가격변동기록에는source변동도기록한다. 쿠폰가하락알림은이전기록/current가모두DIRECT인경우만내보낸다. 판매가알림은공개판매가로명확히구분한다.
- metrics.pricing={policy:'confirmed-benefits-estimate-v1',priced,direct,estimated,exceptionCoupons:[...]} 저장. 요약은추정/직접확인수, 예외ID와추가할인가능성 경고 표시. 예외를전수100%정확으로표현하지않는다.
- 정상 일상실행은새정책으로전체목록을매일갱신한다. 실제이번검증은이미끝난오늘30만선택+1208목록 스냅샷에서 resume-pricing 모드로복구할수있다. 해당모드는오늘의완전한30만선택을검증하고, 오직기존실패가모두suspectEmpty인경우만예외후보를재확인한다. 회원기록있고매핑없는USABLE후보를count+목록으로조회해서 실제빈정상종료ID수가기존실패수와정확히같을때만복구한다. 다른실패/마감/오늘아님/표본선택부족은거부한다. 새catalog수집/회원호출은하지않고가격을재계산한다. 누적duration과recovery메타에원래실행시각·시간을보존한다. 새fullscan을했다고주장하지않는다.
- 최종실행검사는전상품선택정상과가격계산완료를검증한다. 예외는warning와구조화coverage로나타내고진짜실패는실패로남긴다. 실제Actions복구와DB직접대조·이력원래열보존 확인후최종MD갱신.
