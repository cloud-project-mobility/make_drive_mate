# DB·AI 최적화 검증

2026-11-25, 동일한 합성 관측을 이전·수정 Java 서비스에 순서대로 입력했다. PostgreSQL 16.15에서 중복·지연 응답 각각의 SQL은 8 → 2회, 쓰기는 2 → 0회였다. 늦게 온 950km를 처리한 후 최신값 1,100km가 양쪽 표에 남았다. 차량 12,000대와 Sample 4,000건을 추가한 조회 계획은 두 표의 기존 기본키 인덱스를 사용했다. [SQL 수·실행계획](logs/postgres.json)

Python 정비 상담은 기존 6개 문항의 답변 허용·보류가 4/6에서 6/6으로 바뀌었다. 정비 이력의 모델 호출은 1회에서 0회, BM25는 2회에서 1회, 질의 벡터 직렬화는 3회에서 1회로 줄었다. 같은 합성 검색 대역에서 출처는 유지됐다. [연산별 계수](logs/ai-work.json) · [테스트 요약](logs/test-summary.json)

기능과 실험의 경계, 장단점, 다음 검증 순서를 함께 기록했다. [기술 선택과 장단점](../../TECHNOLOGY-DECISIONS.md) · [Python 공식 Sample 실험](../../../experiments/hyundai-api-experiments/README.md) · [현대 저장 기능 브랜치](https://github.com/cloud-project-mobility/make_drive_mate/tree/review/hyundai-sample-db)

## 재현

- 앱 루트에서 Node 24·npm 11로 `npm run check`, `npm run export:web`를 실행한다. 웹 테스트 환경에서 `npx playwright test tests/e2e/ai-consultation.spec.ts --retries=0`을 실행한다.
- Python 워커 환경에서 `python -m unittest discover -s backend/scripts -p 'test_*.py'`를 실행한다. `measure_ai_work.py <앱 경로>`는 가상 검색 입력으로 BM25·벡터·답변 호출 수를 기록한다.
- 기존 가격 평가를 재실행하려면 검토된 문서 코퍼스와 당시 공매 모델 번들이 필요하다. `score_quality.py --repo <앱 경로> --model-dir <모델 폴더> --output <결과 파일>`로 동일한 8개 검색·6개 답변을 채점한다.
- PostgreSQL 검증은 기존 현대 기능 커밋 `ee8ed6b`와 수정 브랜치에 각각 `mvn test`를 먼저 실행한다. JDK·PostgreSQL 16 바이너리와 share 디렉터리가 준비된 환경에서 `python verify_postgres.py --bin <PostgreSQL-bin> --share <PostgreSQL-share> --baseline <이전/backend-spring> --candidate <수정/backend-spring> --maven <mvn>`을 실행한다. 임시 루프백 클러스터를 만들어 합성 값으로 SQL과 인덱스를 측정한 뒤 종료한다.
