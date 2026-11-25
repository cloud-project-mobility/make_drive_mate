# DriveMate 기술 선택과 장단점

2026-11-25 기준. 수기 차량 수정과 상담·검색 개선은 앱 main을 기준으로 한다. 현대 공식 Sample 저장은 `ee8ed6b`에서 분기한 `review/hyundai-sample-db`의 변경이다. 현대 성공 응답은 미확인이고, 이번 저장 시험은 합성 응답과 로컬 PostgreSQL로 실행했다.

## 데이터베이스

| 선택 | 이 프로젝트에서 사용하는 이유와 장점 | 비용·적용 한계 |
|---|---|---|
| Spring `JdbcTemplate` | 수기 수정은 계정·차량 키로 UPDATE한 뒤 영향 행 수로 신규 여부를 판정한다. SQL과 바인딩이 명시적이어서 불필요한 사전 조회를 제거하고 실행계획을 확인하기 쉽다. | 매핑과 SQL을 직접 유지한다. 새 차량 최초 등록에는 0행을 변경하는 UPDATE 시도가 한 번 있다. [수기 차량 저장](../backend-spring/src/main/java/com/drivemate/api/VehicleRegistrationService.java) · [Spring JDBC](https://docs.spring.io/spring-framework/reference/data-access/jdbc/core.html) |
| `TransactionTemplate`·계정 행 `FOR UPDATE` | 공급자 요청과 검증을 마친 뒤에만 계정을 잠근다. 수기·Sample 동시 등록의 3대 제한과 차량·상태 두 표의 원자적 갱신을 함께 보호한다. | 같은 계정의 쓰기는 순서대로 처리된다. 운영 시 계정별 잠금 대기와 트랜잭션 길이를 측정해야 한다. [Spring 트랜잭션](https://docs.spring.io/spring-framework/reference/data-access/transaction/programmatic.html) · [PostgreSQL 행 잠금](https://www.postgresql.org/docs/16/explicit-locking.html) |
| 기존 PostgreSQL 기본키와 UNIQUE | 차량은 (사용자, 차량), Sample 연결은 (사용자, 출처)로 식별한다. 전체 차량 목록 대신 현재 계정의 관측 한 건을 조인한다. 합성 차량 12,000대에서 두 표의 기본키 인덱스가 사용됐다. | 인덱스를 추가하면 모든 쓰기에 비용이 든다. 데이터 분포가 달라지면 실행계획도 달라질 수 있다. [고유 인덱스](https://www.postgresql.org/docs/16/indexes-unique.html) · [실행계획](https://www.postgresql.org/docs/16/using-explain.html) |
| 공급자 시각과 서버 수신시각 분리 | 같은 차량의 검증된 공급자 현지 시각으로 순서를 정한다. 공급자 시각이 없는 과거 행은 수신 Instant로 비교하고 신뢰할 수 있는 시각을 나중에 보강한다. 시간대 변환이나 기존 데이터 일괄 수정 없이 지연 응답을 막는다. | 수신시각만으로 과거의 실제 전송 순서를 복원할 수 없다. 새 시각에서 거리 감소 또는 같은 시각의 거리 충돌은 409로 반환하고 양쪽 표를 보존한다. |

PostgreSQL 16.15에서 같은 Java 서비스 메서드에 동일한 합성 관측을 보냈다. SELECT·INSERT·UPDATE·DELETE만 계수했다. 쓰기는 INSERT·UPDATE 횟수이며 연결 및 트랜잭션 제어문은 제외했다.

| 동작 | 실제 SQL 수 | 쓰기 수 |
|---|---:|---:|
| 최초 Sample 등록 | 8 → 6 | 2 → 2 |
| 새 거리 갱신 | 8 → 5 | 2 → 2 |
| 중복 관측 | 8 → 2 | 2 → 0 |
| 과거 관측 지연 도착 | 8 → 2 | 2 → 0 |
| 수기 차량 수정 | 4 → 3 | 1 → 1 |

늦은 응답 뒤 DB에 남은 누적거리는 이전 950km, 수정 후 1,100km였다. 별도 실행계획에 계정 4,000개, 차량 12,000대, Sample 상태 4,000건을 추가했다. 결과는 1행이었다. 운영 p95 지연은 미측정이다.

## AI와 외부 연동

| 선택 | 사용 이유와 장점 | 비용·적용 한계 |
|---|---|---|
| 구조화된 정비 기록과 일반 상담 분리 | 단일 이력 질문에는 차량·정비 항목·기록 유무로 답한다. 모델과 문서 검색을 건너뛴다. 앱 요약에 없는 교체 날짜와 실물 부품 상태는 확인할 수 없다고 안내한다. | 한국어 질문 분류에는 오분류 가능성이 있다. 복합 질문과 정비 주기는 일반 상담 경로로 처리한다. [워커](../backend/scripts/assistant_worker.py) |
| BM25·벡터 검색·순위 결합 | 차종·연식·연료 적합성으로 후보를 거른다. BM25의 부품명 일치와 벡터의 의미 유사도를 순위로 합친다. 한 요청 안에서 BM25 순위와 검증된 질의 벡터 문자열을 재사용한다. | 문서 검토·임베딩·DB 비용이 든다. 시험 대역에서 동일 출처를 얻으면서 BM25 2회 → 1회, 1,536차원 벡터 직렬화 3회 → 1회였다. 운영 pgvector 지연은 별도 측정 대상이다. [검색 구현](../backend/scripts/vehicle_rag.py) · [pgvector](https://github.com/pgvector/pgvector) |
| 가격 모델과 GPT 역할 분리 | 공매 모델은 금액·구간을 계산하고 GPT는 확인된 근거를 설명한다. 숫자·단위·출처를 독립적으로 검증할 수 있다. | 기존 341건 낙찰가 MAE 236.15만원은 소비자 매매가·정비 견적의 정확도를 설명하지 않는다. [가격 모델](ONBID-MODEL.md) |
| Python 3.11·uv·프로젝트 전용 venv | lock과 Python 버전으로 팀원의 의존성 조합을 재현한다. 프로젝트별 런타임이 다른 앱의 환경과 분리된다. | 새 환경은 패키지 파일이나 캐시가 필요하다. lock이 외부 인증·인증서 조건까지 보장하지는 않는다. [uv 동기화](https://docs.astral.sh/uv/concepts/projects/sync/) |
| python-dotenv·httpx | 지정한 .env만 보간 없이 읽는다. HTTPS 호스트·timeout·재시도를 명시하고 MockTransport로 같은 클라이언트·파서를 시험한다. | 실제 공급자 권한은 실호출이 필요하다. 환경 프록시를 무시하므로 프록시 필수 환경은 별도 구성이 필요하다. [HTTPX transports](https://www.python-httpx.org/advanced/transports/) |
| dataclass·Decimal | 거리·단위·공급자 시각·수신시각을 구분하고 명시적 파서로 null과 모르는 단위를 거절한다. | dataclass 자체는 런타임 검증기가 아니다. 명세가 바뀌면 파서와 테스트를 함께 갱신한다. [Python dataclasses](https://docs.python.org/3.11/library/dataclasses.html) |
| 카카오 REST 폴링과 별도 위치 공유 WebSocket | 사용자 요청 직후 경로를 구하고 활성 화면에서 5분마다 다시 조회한다. GPS 수정만으로 카카오 호출이 늘지 않는다. 같은 계정 기기의 위치 공유에는 사용자가 켠 WebSocket을 쓴다. | 5분은 앱 정책이다. 교통 반영 지연·일일 한도·동시 화면 증가를 운영에서 확인한다. [경로 스케줄러](../src/domain/routePolling.ts) · [카카오 길찾기](https://developers.kakaomobility.com/guide/navi-api/directions.html) |
| pytest·JUnit·H2·PostgreSQL·Playwright | 현대 오류 계약은 pytest, 저장·동시성은 빠른 H2와 실제 PostgreSQL, 사용자 화면은 두 폭의 Playwright로 검증한다. | Mock·로컬 DB·웹 브라우저에서 측정한 결과는 운영 부하, 실제 현대 권한, 기기 GPS의 증거로 쓸 수 없다. [H2 호환 모드](https://www.h2database.com/html/features.html) |

## 다음 작업

| 순서 | 작업 | 완료를 판단할 증거 |
|---|---|---|
| 1 | 현대 프로젝트의 Sample 토큰·차량 권한 확인 | 외부 Python에서 200, 오류 본문 없음, msgId와 거리·단위·시각 검증. 저장·재공유 조건 확인 후 허용 범위의 fixture 확보 |
| 2 | 수기·GPS·현대 저장 기능을 통합 사본에서 함께 시험 | 수기 차량과 Sample 차량 분리, 누적거리 중복 가산 0건, 재로그인 뒤 최신값 유지, 공급자 실패 시 기존값 표시 |
| 3 | 독립 질문셋으로 실제 생성 답변 평가 | 차종·연식별 정답과 근거를 먼저 정해 두 명이 수치·인용·보류를 채점. 근거 없는 정비 완료 확정 0건을 릴리스 기준으로 제안 |
| 4 | 동시 사용자 수를 늘려 비용과 지연 측정 | DB 잠금 대기, p50·p95, 카카오 429, 검색당 임베딩 횟수 확인. 응답 저장 기간과 캐시는 이용 조건 확인 후 결정 |
