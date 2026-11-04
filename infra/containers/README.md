# DriveMate ECS runtime

하나의 이미지에 코드와 고정된 실행 의존성을 넣고 `api`, `nginx`, `cycle` 역할로 실행한다. 모델·온비드 원본·문서/벡터·환경 파일·자격 증명은 이미지 빌드 입력이 아니다. 이 이미지는 ECS와 이후 Kubernetes에서 동일하게 사용할 수 있다.

## Code-only image build

CI 또는 배포 담당자가 검증한 Spring JAR와 최종 Expo 웹 export를 먼저 준비한다. 카카오 JavaScript 키처럼 공개 빌드 설정을 바꿨다면 Metro 캐시를 지운 export 결과를 사용한다.

```bash
python3 infra/containers/prepare_context.py --repo . --output /tmp/drivemate-code-context-NEW
docker build --tag drivemate-runtime:reviewed /tmp/drivemate-code-context-NEW
```

컨텍스트 출력 경로는 새 경로여야 한다. 스크립트는 JAR, `dist`, Python 실행 코드, 기존 requirements 및 컨테이너 런처만 허용 목록으로 복사하고 파일 해시를 기록한다. 저장소 전체를 Docker build context로 넘기지 않는다. CI가 이미 검증한 JAR·정적 웹을 그대로 이미지에 넣으므로 ECR 이미지 digest 교체가 코드 배포다.

기본 이미지는 Ubuntu 24.04이며 Java 17, Ubuntu의 Python 3.12, Nginx 및 기존 고정 Python 의존성을 사용한다. 앱 UID/GID는 10001이다. 실행 중 패키지 설치·코드 다운로드·스키마 변경·관리자 가입·문서 재임베딩은 하지 않는다.

## API와 Nginx task

- `api`: 명령 `api`, Spring은 `127.0.0.1:18085`에 바인딩한다. 이미지의 Python worker를 자식 프로세스로 실행한다.
- `nginx`: 동일 이미지의 명령 `nginx`, `0.0.0.0:8080`으로 정적 웹과 API/WebSocket을 제공한다. `api`의 `HEALTHY` 의존성을 설정한다.
- `api`가 검증한 이미지 내 `dist`를 `/srv/drivemate-web/site`로 복사한다. 이 공유 볼륨은 API에 쓰기 가능, Nginx에 읽기 전용으로 마운트한다.
- `/opt/drivemate/runtime`은 API 전용 쓰기 볼륨이다. 루트 파일시스템은 읽기 전용, 각 컨테이너의 `/tmp`는 쓰기 가능해야 한다. 새 task에는 새 임시 볼륨을 사용한다.
- healthcheck는 `CMD /opt/drivemate/venv/bin/python /opt/drivemate/container/healthcheck.py api` 또는 마지막 인자 `nginx`다. ALB 확인 경로는 `8080/api/v1/health`다. API 시작 대기 120초 이상을 잡는다.
- `stopTimeout`은 60초 이상, `linuxParameters.initProcessEnabled=true`를 권장한다. 런처는 종료 신호를 Java/Python 프로세스 그룹에 전달한다.
- API replica는 1이다. 위치가 메모리에 있으므로 롤링 배포 중 두 replica를 동시에 운영하지 않는다. 새 배포 시 연결이 끊기며 사용자가 다시 연결한다.

일반 API task 환경:

| 이름 | 값/의미 |
|---|---|
| `AWS_REGION` | 명시적 AWS 리전 |
| `DRIVEMATE_RELEASE_BUCKET` | 비공개 데이터 버킷 |
| `DRIVEMATE_RELEASE_KEY` | 승인된 release ZIP의 정확한 key |
| `DRIVEMATE_RELEASE_SHA256` | 해당 ZIP의 검증된 SHA256 |
| `DRIVEMATE_RAG_POINTER_KEY` | 같은 버킷의 pgvector 메타데이터 포인터 key |
| `DRIVEMATE_RAG_POINTER_SHA256` | 포인터의 검증된 SHA256 |
| `DRIVEMATE_DB_HOST` | 기존 RDS endpoint |
| `DRIVEMATE_ANALYTICS_LATEST_KEY` | 선택. 예: `data/cycles/latest.json`; 60초마다 새 집계 확인 |
| `DRIVEMATE_PROVIDER_MODE` | 기존 공급자 연결 정책. 생략 시 `mock` |

ECS `secrets`로 API 컨테이너에만 주입하는 기존 Secret JSON 필드는 `DRIVEMATE_DB_PASSWORD`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `DRIVEMATE_KNOWLEDGE_ALLOWED_EMAILS`다. 구성된 외부 공급자의 기존 환경변수는 그대로 전달한다. Kakao 서버 필드는 `DRIVEMATE_KAKAO_REST_KEY`, `DRIVEMATE_KAKAO_MOBILITY_KEY`다. Nginx에는 secret을 주입하지 않는다.

`infra/aws/ecs-service.json`의 선택 매개변수 `KakaoSecretArn`은 기본값이 빈 문자열이다. 비어 있으면 `DRIVEMATE_PROVIDER_MODE=mock`이며 카카오 키를 주입하지 않는다. 기존 Secrets Manager secret의 ARN을 배포 매개변수로 지정하면 `live`로 전환하고 그 secret의 `DRIVEMATE_KAKAO_REST_KEY` JSON 필드만 API에 주입한다. 실제 ARN·키는 공개 소스에 기록하지 않는다. 이 설정은 REST 키만 연결하며 별도 Mobility 키, Google·현대 계정 동의 또는 실제 호출 성공을 대신하지 않는다.

ECS execution role의 `GetSecretValue` 리소스에는 지정한 카카오 secret ARN만 조건부로 추가한다. API task role에 secret 조회 권한을 주지 않으며 Nginx와 cycle의 secret 목록은 바뀌지 않는다. 키를 회전하면 실행 중인 컨테이너가 자동 갱신되지 않으므로 새 task 배포가 필요하다. JSON 필드 주입과 갱신 방식은 [AWS ECS 공식 문서](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html)를 따른다.

DB 사용자는 `drivemate_app`으로 고정하고 TLS `verify-full`을 사용한다. 런처가 `SPRING_SQL_INIT_MODE=never`를 지정한다. DB master secret, 소유자 초기 비밀번호, bootstrap token을 일반 task에 전달하지 않는다. master/owner/bootstrap 변수가 발견되면 시작을 거절한다. 기존 bootstrap이 만든 `drivemate_app`은 현재 테이블 소유자이므로 DB 역할 자체를 DML 전용으로 낮춘 상태는 아니다. IAM execution role의 JSON key 주입과 task role의 AWS API 권한을 구분한다. task role에는 release·pointer·latest 집계 객체 읽기와 `s3:prefix=data/cycles/latest.json`에만 허용한 `ListBucket`이 필요하다. exact key가 아직 없으면 GET하지 않고 기존 보고서를 유지한다. secret이 회전하면 task를 교체해야 한다.

런타임은 ZIP 전체 SHA256을 검증한 다음 데이터 중 모델과 집계만 선택해 추출한다. ZIP에 들어 있는 JAR·Python·웹 코드로 이미지 코드를 덮어쓰지 않는다. API에는 원시 온비드 자료와 RAG 준비 색인을 추출하지 않는다. RAG 포인터는 엄격히 메타데이터 필드만 허용하며 실제 pgvector 검색은 RDS를 읽는다. 포인터의 `index_relative_path`가 가리키는 별도 S3 객체 권한은 필요하지 않다.

## 초기화와 독립 cycle task

DB 스키마·vector 확장·준비된 RAG 벡터 적재·소유자 계정 생성은 별도 bootstrap 역할의 일회 작업이다. 현재 최초 전환은 성공한 기존 bootstrap 결과를 재사용한다. API service를 시작하기 전에 이를 확인하고 active pgvector 포인터를 별도 검토한다. 앱 런타임이 임의로 local 포인터를 pgvector 포인터로 바꾸지 않는다.

`cycle`은 별도 ECS TaskDefinition과 task role로 실행한다. 명령 `cycle`이 기존 `cycle_worker.py --once`를 호출한다. 큐를 20초 동안 한 번 기다린 뒤 최대 한 메시지를 처리하고 종료한다. 상시 ECS service를 만들지 않는다. 기존의 메시지 예산·SQS 재시도·DLQ·S3 완료 마커 검증을 유지하며 새 집계가 있어도 서비스 모델을 자동 교체하지 않는다.

cycle 전용 설정은 `DRIVEMATE_CYCLE_QUEUE_URL`, `DRIVEMATE_DATA_BUCKET`, 선택적 `DRIVEMATE_DATA_KMS_KEY_ARN` 및 Secret의 `ONBID_SERVICE_KEY`다. release bucket/key/SHA도 필요하다. DB·OpenAI·소유자 자격 증명은 주입하지 않는다. 이 task에는 SQS 소비와 `data/cycles/*` S3 읽기/쓰기만 추가한다. `ONBID_SERVICE_KEY`를 직접 주입하므로 runtime Secrets Manager 조회 권한은 필요하지 않다.

스케줄러는 먼저 SQS 메시지를 넣고 이후 일회 task가 큐를 확인하도록 맞춘다. task가 실행되는 20초 창에 메시지가 없으면 정상 종료하므로 순서를 확인한다. 로컬 파일 잠금은 서로 다른 ECS task를 조정하지 못한다. 한 번에 cycle task 하나만 실행하며 자동 스케줄 활성화 전에 중복 실행 방지를 배포 설정에서 확인한다.

## 검증

```bash
python3 -m unittest discover -s infra/containers -p 'test_*.py' -v
```

합성 ZIP/S3 응답으로 해시 불일치, ZIP 경로·중복·링크, 코드/데이터 분리, 포인터 필드 제한, 모델 미승격, 비공개 자료 없는 build context, runtime 관리자 설정 거절을 검사한다. 이 검사는 실제 이미지 빌드·Fargate 기동·배포 HTTP/WSS 검증을 대신하지 않는다.
