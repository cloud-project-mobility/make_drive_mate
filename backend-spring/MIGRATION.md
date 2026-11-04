# Spring API 전환

`backend-spring`이 HTTP 서비스의 실행 모듈이다. Java 17 / Spring Boot 4.1.2를 사용하며 기존 `/api/v1` 계정·백업·연동 API 계약을 유지한다. Python은 온비드 수집·전처리·학습·예측 작업자로 남는다. 기존 `backend/app`은 회귀 비교용 구현이며 Spring 실행 시 시작하지 않는다. JSON 계약은 Spring Boot의 Jackson 2 호환 모듈을 명시적으로 사용한다. 이 모듈은 폐기 예정이므로 이후 Jackson 3 전환 시 백업·외부 API 계약 테스트를 함께 실행해야 한다.

## 로컬 실행

```sh
cd backend-spring
./mvnw test
./mvnw spring-boot:run
```

Java 17, curl, tar, sha512sum이 필요하다. 실행기는 공식 Maven 3.9.16 배포본을 `.tools/`에 받아 고정 SHA512로 검증한다. 기본 주소는 `127.0.0.1:18085`, 로컬 DB는 `data/drivemate.mv.db`이다. 테스트는 별도 메모리 H2 DB를 사용한다. API 키는 빌드나 일반 테스트에 필요하지 않다.

## 운영 설정

| 환경 변수 | 의미 |
|---|---|
| `SERVER_ADDRESS` / `SERVER_PORT` | 컨테이너는 `0.0.0.0` / `18085` |
| `SPRING_DATASOURCE_URL` | `jdbc:postgresql://<RDS endpoint>:5432/drivemate?sslmode=require` |
| `SPRING_DATASOURCE_USERNAME` / `SPRING_DATASOURCE_PASSWORD` | 배포 환경의 비밀 저장소에서 주입 |
| `DRIVEMATE_PROVIDER_MODE` | `mock`, `disconnected`, `live`; 기본은 명시적 예시 모드 |
| `DRIVEMATE_CORS_ORIGINS` | 허용한 프런트엔드 출처를 쉼표로 구분; 와일드카드 금지 |
| `DRIVEMATE_SESSION_HOURS` | 로그인 세션 수명, 기본 12시간 |
| `DRIVEMATE_PYTHON` | 예측 작업자 Python 경로 |
| `DRIVEMATE_ML_WORKER` | `onbid_worker.py` 절대 경로 |
| `DRIVEMATE_MODEL_BUNDLE` | 검증된 `model_bundle.joblib` 절대 경로 |
| `DRIVEMATE_MODEL_SHA256` | 모델 파일의 SHA256; Python 작업자가 역직렬화 전에 확인 |
| `DRIVEMATE_ALLOW_LLM` | `true`일 때 요청의 `use_llm: true` 허용; 기본 `false` |
| `DRIVEMATE_LLM_DAILY_LIMIT` | 전체 계정 합산 GPT 요청 상한; 기본 UTC 하루 20회, 0이면 차단 |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | 서버 환경에 주입; 모델 기본값은 작업자의 `gpt-6-astra` |
| `DRIVEMATE_ANALYTICS_REPORT` | 완료된 파이프라인 `latest.json` 절대 경로 |
| `DRIVEMATE_RAG_WORKER` / `DRIVEMATE_RAG_COLLECTION` | 문서 작업자와 활성 컬렉션 JSON 절대 경로 |
| `DRIVEMATE_KNOWLEDGE_ALLOWED_EMAILS` | 문서 조회 허용 계정 이메일; 쉼표 구분, 기본 빈 값은 전부 거부 |
| `DRIVEMATE_PG_HOST`, `DRIVEMATE_PG_DATABASE`, `DRIVEMATE_PG_USER`, `DRIVEMATE_PG_PASSWORD`, `DRIVEMATE_PG_SSLROOTCERT` | 문서 작업자의 PostgreSQL 연결. 별도 앱 역할과 `verify-full` TLS 사용 |

저장 스키마는 H2의 PostgreSQL 호환 모드와 PostgreSQL에서 사용할 수 있는 JDBC SQL로 작성했다. 시작 시 없는 테이블만 만든다. 기존 테이블을 삭제하거나 덮어쓰지 않는다. `GET /api/v1/health`는 실제 DB 쿼리를 수행한다.

## 계정·백업 이전

기존 SQLite DB 파일을 Spring DB로 지정하면 안 된다. Spring은 PBKDF2-HMAC-SHA256 비밀번호 해시와 새로운 세션을 사용한다. 기존 Python 서비스의 scrypt 비밀번호·세션·Fernet Google 토큰을 자동 이전하지 않는다.

기존 사용자는 앱에서 JSON 백업을 내보내고 새 서버에서 계정을 등록한 뒤 검증된 백업을 올린다. 기존 SQLite 파일은 보관하고 서비스 주소를 전환한다. Google은 다시 동의해 연결한다. 이전 사용자 데이터가 있는 운영 서버에서는 이 안내와 별도 계정 이전 절차를 적용한 뒤 전환한다.

백업은 차량 최대 3대, 완료된 주행만 허용, 소유 차량 참조, 주행 시간, 정비 종류·거리, 예시 경로 출처 등 기존 규칙을 서버에서 다시 검증한다. 같은 JSON 재전송은 리비전을 늘리지 않으며 다른 기기의 낡은 백업은 409로 거부한다. 사용자별 계정 행 잠금으로 동시 갱신을 직렬화한다.

## 컨테이너

저장소 최상위에서 `docker build -f backend-spring/Dockerfile -t drivemate-api .`로 빌드한다. 컨테이너는 비관리자 계정으로 실행하며 Java API와 Python CPU 예측 작업자를 포함한다. 모델은 이미지에 자동 포함되지 않으므로 검증한 모델을 `/opt/drivemate/model/model_bundle.joblib`로 읽기 전용 마운트한다. 비밀값은 이미지나 빌드 인수로 넣지 않는다. HTTPS 역방향 프록시 뒤에서 실행하고 DB 접근은 서비스 보안 그룹으로 제한한다.

현재 테스트는 H2 환경에서 인증·세션 폐기·계정 격리·백업 충돌·입력 제한·CORS를 확인한다. PostgreSQL과 Docker의 배포 검증은 실제 실행 결과를 별도 배포 기록에 남긴다. `X-Forwarded-For`는 기본적으로 신뢰하지 않아 프록시 공유 IP에 인증 요청 제한이 함께 적용될 수 있다.

## 가격 분석 API

인증한 사용자만 `POST /api/v1/valuation/simulations`를 호출할 수 있다. 입력은 `vehicle`(필수: `model`, `age_years`, `odometer_km`; 선택: `make`, `fuel`, `vehicle_category`, `engine_cc`), `monthly_km`, `months`(0~24개월), `monthly_upkeep_krw`, `use_llm`이다. 클라이언트는 실행 파일·모델·비밀 파일 경로를 지정할 수 없다. Spring이 허용 필드를 먼저 검사하고 Python 작업자가 다시 검증한다. 작업자는 서버가 정한 고정 명령으로 실행되며 최대 2개 동시 실행, 표준 출력 512KB 제한을 적용한다. AWS에서는 예측·문서 검색 작업을 115초로 제한하고 CloudFront 응답 제한을 120초로 설정한다. 로컬 예측 기본 제한은 120초이며 `DRIVEMATE_PREDICTION_TIMEOUT_SECONDS`로 조정한다. 내부 오류와 표준 오류는 응답에 포함하지 않는다.

`GET /api/v1/analytics/latest`는 로그인 후 서버가 지정한 최신 완료 보고서만 읽는다. 파이프라인 상태가 완료가 아니거나 파일이 없으면 503을 반환한다. 두 API는 임의의 예측값이나 보고서를 성공 결과로 꾸미지 않는다.

유료 설명 요청은 모든 사용자와 API 인스턴스가 공유하는 DB 일일 버킷에서 먼저 차감한다. 실패한 요청도 보수적으로 횟수에 포함하며 UTC 날짜가 바뀌면 새 버킷을 사용한다. 이 제한은 호출 수 제한이며 AWS/OpenAI 청구액을 보장하는 절대 금액 상한은 아니다. 배치 작업이나 별도 API 키 사용은 이 HTTP 제한 밖에 있으므로 운영 예산과 사용량을 별도로 관찰한다.

## 비공개 문서 근거 검색

`POST /api/v1/knowledge/query`는 `{ "question": "질문", "use_llm": false }`를 받는다. 질문은 1~1,000 UTF-16 문자이며 다른 필드·파일 경로 지정은 거부한다. 로그인과 문서 허용 이메일 목록을 모두 확인한다. 허용 목록을 비워두면 403을 반환한다. 공개 회원가입만으로 프로젝트 문서를 읽을 수 없으며, 배포 시 허용 계정을 공개 트래픽보다 먼저 생성한다.

문서 검색은 `use_llm: false`여도 질문 임베딩 API를 사용하므로 가격 GPT 설명과 같은 전역 일일 20회 버킷을 소비한다. `true`는 검색된 근거 중 인용할 항목을 GPT로 고르는 기능을 추가한다. 문서의 계획·구현 상태와 출처를 응답에 유지한다. 가격 예측과 문서 검색을 합쳐 동시에 최대 두 작업자만 실행한다. 문서 원문과 활성 컬렉션 파일은 웹 정적 폴더에 두지 않는다.
