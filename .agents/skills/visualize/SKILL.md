---
name: visualize
description: >
  MUST USE when the user asks to see price trend charts, view the price tracking dashboard,
  or inspect visual pricing history — e.g. "/visualize", "가격 그래프 보여줘",
  "대시보드 띄워줘", "가격 동향 보고 싶어", "차트 열어줘", "/visualize <goodsNo>".
---

# /visualize — 무신사 가격 동향 대시보드 시각화 스킬

Project-Clot의 SQLite 데이터베이스(`prices.db`)에 누적된 상품별 가격 및 쿠폰 할인 이력을 무신사 감성의 독립형 인터랙티브 HTML 대시보드(`data/dashboard.html`)로 빌드하고 macOS 기본 브라우저에 띄웁니다.

## 워크플로우

1. **대시보드 생성 및 브라우저 오픈**:
   - 상품 번호 인자가 있으면:
     ```bash
     node src/cli.js visualize <goodsNo>
     ```
   - 전체 대시보드 열람 시:
     ```bash
     node src/cli.js visualize
     ```
2. **요약 브리핑**:
   `data/latest_prices.json` 또는 직전 실행 출력을 참조하여 현재 추적 중인 전체 상품 수, 역대 최저가 도달 상품 2~3개의 상품명과 현재 실구매가를 사용자에게 간결히 안내합니다.
