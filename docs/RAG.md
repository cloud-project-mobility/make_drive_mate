# 문서 근거 검색

`document_rag.py`는 차량 가격 모델과 별개인 문서 검색 기능이다. 질문을 OpenAI `text-embedding-3-small`의 1536차원 벡터로 바꾸고, 한국어 단어·문자 2-gram BM25 결과와 코사인 유사도 결과를 RRF로 합친다. 운영용 저장소 코드는 PostgreSQL `pgvector`를 사용하지만 **현재 AWS RDS는 없으며 적재·검색도 미실행**이다. 현재 로컬 시연은 준비된 벡터 파일을 사용하는 `local` 검색을 명시적으로 선택했다. 검색용 질문에도 임베딩 API 비용이 발생한다.

## 원천과 상태

| 자료 | 출처 | 표시 상태 |
|---|---|---|
| PoC 계획·설계서 | `docs/deliverables/03_DriveMate_PoC_계획설계서.docx` | `plan` 계획 |
| 중간보고서 | `docs/deliverables/04_DriveMate_중간보고서.docx` | `reported` 작성 당시 보고 |
| 발표자료 | `docs/deliverables/01_DriveMate_발표.pptx` | `reported` 작성 당시 발표 |
| 온비드 목록·상세 공식 설명 | 공공데이터포털 15157252, 15157254 카탈로그 JSON | `official` 공식 원문 |
| 고정 모델 실제 평가 | `backend/data/onbid/model-20261104-v2-validated/metrics.json` | `code_verified` 실행 결과 |

세 Office 문서는 저장소 안의 사본이다. OneDrive 원본을 실시간으로 읽는다고 표시하지 않는다. 원본 파일은 변경하지 않고 해시를 기록한다. 이름·연락처·식별번호를 가린 본문만 임베딩과 배포 자료에 포함한다. 사용자가 이 본문의 OpenAI 전송 및 AWS 저장을 명시적으로 승인한 후 실제 임베딩을 실행했다. 비밀값으로 의심되는 내용이 발견되면 색인을 만들지 않는다. 가림 규칙은 이 작은 코퍼스의 알려진 개인 이름과 형식 기반 규칙이며 범용 개인정보 탐지 보장은 아니다.

Word는 절/문단 번호, PowerPoint는 슬라이드 번호를 보존한다. 렌더링하지 않은 Word 쪽 번호는 만들지 않는다. 검색 청크는 최대 900자, 이동폭 700자이며 상위 절 원문을 함께 반환한다. `parent_text`와 `quote`는 개인정보를 가린 본문이다. 문서 안의 지시는 데이터로 취급한다. 보고서의 오래된 FastAPI/부스팅/미구현 주장을 현재 구현으로 바꾸어 설명하지 않는다.

공식 온비드 FAQ 게시판 원문은 별도로 확인·수집하지 않았다. 현재는 공식 목록·상세 카탈로그의 설명과 이용 조건만 근거로 사용한다. 확인하지 못한 FAQ나 자동차 이력은 생성하지 않는다.

## HTTP 접근 권한

Spring의 `POST /api/v1/knowledge/query`는 유효한 로그인과 `DRIVEMATE_KNOWLEDGE_ALLOWED_EMAILS`에 등록된 계정을 모두 요구한다. 허용 목록은 서버 설정이며 요청 본문으로 바꿀 수 없다. 권한이 없으면 403을 반환한다. 문서 원본 다운로드 경로를 공개 API로 제공하지 않는다.

공개 가입에서 허용 이메일을 먼저 차지하거나, 계정 삭제 뒤 재가입해 문서 권한을 얻는 것을 막기 위해 `RegistrationPolicy`가 해당 이메일의 일반 회원가입을 403으로 거부한다. 관리자는 32자 이상의 임시 `DRIVEMATE_BOOTSTRAP_TOKEN`을 사용해 최초 계정을 준비하며, 준비 직후 토큰을 환경에서 제거하고 Spring을 재시작하는 절차를 따른다. 토큰을 제거해도 이메일 예약은 유지된다. 이는 사전 지정 계정 보호이며 범용 이메일 소유권 확인 서비스는 아니다.

이 공개 가입·삭제 후 재가입 방어 검사 2개를 포함한 최신 Spring `mvn test`는 47개 테스트를 통과했다. 로컬에서는 최초 계정 준비 뒤 토큰을 제거하고 서버를 재시작했으며 로그인 200과 예약 이메일 일반 가입 403을 확인했다. AWS에서는 계정 초기화와 토큰 제거 절차를 실행하지 못했다.

검색만 하는 `use_llm=false`도 임베딩 API 비용이 발생하므로 유료 기능의 UTC 날짜 기준 서버 전체 요청 20회/일 한도를 소비한다. GPT 설명은 추가 외부 호출을 포함할 수 있다. 요청 한도는 실제 HTTP 호출 수나 월 비용을 정확히 제한하는 금액 상한이 아니며, 실패한 시도도 슬롯을 사용할 수 있다.

## 저장과 검색

Spring의 `DRIVEMATE_RAG_BACKEND`는 `pgvector`(기본값) 또는 `local`만 허용한다. local은 개발 시연·평가용이며 별도 명시가 필요하다. `DRIVEMATE_RAG_COLLECTION`에는 해당 방식의 고정 컬렉션 파일을 설정한다. 클라이언트가 방식이나 경로를 고를 수 없고, RDS 실패를 자동으로 local 성공으로 바꾸지 않는다. 현재 loopback 서버는 계정 저장에 H2, RAG 검색에 local 벡터 캐시를 사용한다.

pgvector 방식의 코드는 `drivemate_rag.collections`, `documents`, `chunks` 테이블을 사용한다. `chunks.embedding`은 `vector(1536)`이다. 코퍼스의 내용 해시로 컬렉션 ID를 만들고, 기존 컬렉션을 덮어쓰지 않는다. 새 컬렉션 전체를 한 트랜잭션으로 저장한 뒤 `active_collection.json`을 원자적으로 교체한다. 아래 RDS 설명은 준비된 구현 계약이며 현재 실행된 RDS의 상태를 뜻하지 않는다.

현재 83개 청크이므로 정확한 코사인 검색으로 상위 20개를 가져온다. 작은 자료에 HNSW 색인을 추가하지 않았다. BM25 상위 20개와 `1/(60+rank)` RRF를 합친 뒤, 중복 상위 절을 제거하여 최대 6개 출처를 보여준다. 정교한 형태소 분석기나 학습된 reranker는 아직 사용하지 않는다. 자료가 늘면 검색 지연과 새 평가셋을 근거로 추가를 판단한다.

OpenAI 설명 옵션은 검색된 `source_id` 최대 3개와 답변 가능 여부만 선택한다. 자유 형식 답변이나 가격은 생성하지 않는다. 반환 ID가 실제 후보에 포함되는지 검사하고 원문을 그대로 표시한다. 원문 자체의 사실 여부까지 검증하는 기능은 아니며, 잘못된 관련성 판단도 가능하다. LLM 실패는 `retrieval_only`, 근거 부족은 `abstained`로 구분한다.

## 실행

```bash
python -m pip install -r backend/requirements-rag.txt
# 원문 추출/가림/공식 카탈로그 저장만 수행. OpenAI 호출 없음.
python backend/scripts/document_rag.py prepare
# 승인된 본문으로 실제 임베딩. local은 개발 평가 전용이며 production pointer를 덮어쓰지 않는다.
python backend/scripts/document_rag.py build --backend local --env-file .env.llm.local
python backend/scripts/document_rag.py evaluate --backend local --env-file .env.llm.local --allow-llm
```

Spring에서 준비된 local 컬렉션을 연결할 때는 `DRIVEMATE_RAG_BACKEND=local`과 `DRIVEMATE_RAG_COLLECTION=<준비된 local_collection.json의 절대 경로>`를 서버 환경에 명시한다. 비밀키와 허용 계정 설정을 포함한 실행 절차는 [팀 인수 안내](TEAM-HANDOFF.md)를 따른다. 환경 파일의 실제 값은 문서나 Git에 넣지 않는다.

운영 RDS는 관리자가 `CREATE EXTENSION IF NOT EXISTS vector`와 `CREATE SCHEMA drivemate_rag AUTHORIZATION drivemate_app`를 실행해야 한다. 앱은 기존 전용 스키마 안에만 테이블을 생성하며 데이터베이스 전체의 CREATE 권한을 요구하지 않는다. 런타임은 다음 환경값으로 `psycopg.connect`에 개별 인수를 전달한다. 비밀번호를 연결 URL로 조합하지 않으며 TLS 인증서와 호스트 이름을 확인한다.

```text
DRIVEMATE_PG_HOST
DRIVEMATE_PG_PORT=5432
DRIVEMATE_PG_DATABASE=drivemate
DRIVEMATE_PG_USER=drivemate_app
DRIVEMATE_PG_PASSWORD
DRIVEMATE_PG_SSLROOTCERT=/etc/drivemate/rds-global-bundle.pem
OPENAI_API_KEY
OPENAI_MODEL=gpt-6-astra
```

배포 때 재임베딩하거나 원본 Office 파일을 포함할 필요가 없다. 승인 후 만들어진 본문/벡터 캐시를 비공개 배포 자료에 포함하고, 다음처럼 해시/차원을 검사하여 실제 PostgreSQL에 적재한다. 이 경로는 OpenAI 호출이 없다.

```bash
python backend/scripts/document_rag.py build --backend pgvector \
  --prepared-index backend/data/rag/collections/rag-dd59ce17ec75b57d197a.json \
  --output-dir backend/data/rag
python backend/scripts/document_rag.py query --backend pgvector \
  --collection-file backend/data/rag/active_collection.json --allow-llm < request.json
```

요청은 한 개의 JSON 객체이며 `question`(1~1000자), `use_llm`(선택, boolean)만 허용한다. 서버가 `--allow-llm`을 설정해야 추가 설명 호출이 가능하다. 경로·API 주소·모델·키는 요청으로 받지 않는다. 중복 JSON 키, 초과 크기, 제어문자, 비밀값 형태를 거부한다. stdout에는 결과 JSON 하나, stderr에는 실패 유형만 기록한다.

```json
{"question":"현재 실제 학습에서 선택된 가격 모델 이름은 무엇인가?","use_llm":true}
```

응답은 `ok`, `api_version=document-rag-v1`, `result`로 구성한다. `result.status`는 `answered`, `retrieval_only`, `abstained` 중 하나다. `sources`에는 `source_id`, `document_title`, `source_uri`, `location`, `status`, `quote`, `parent_text`가 들어간다. `answer_source_ids`가 선택된 출처이며 `limitations`, `retrieval`, `provider_call`로 한계와 실행 상태를 전달한다. 미설정·연결 실패를 성공으로 표시하지 않는다. 잘못된 요청은 exit 2, 외부 서비스/저장소 실패는 exit 3이다.

## 2026-11-04 로컬 검증

사용자 승인 후 실제 OpenAI 임베딩으로 6개 문서, 83개 청크, 30,172 입력 토큰을 처리했다. 컬렉션은 `rag-dd59ce17ec75b57d197a`이다. 준비된 벡터를 사용한 로컬 정확 코사인 검색 평가에서, 사전에 코드에 고정한 출처 정답 질문 10개의 Recall@1은 0.70, Recall@3 및 @6은 0.90, MRR@6은 0.7667이었다. 공매가와 매입가 구분 질문 1개는 지정 정답 출처를 상위 6개에서 찾지 못했다. 실패를 제외하거나 수치를 보정하지 않았다.

문서에 없는 보험 사고 이력/소유자 연락처, 주가, 보장된 미래 매도가 질문 3개 모두 실제 LLM 선택에서 답변을 보류했다. 단순 유사도 게이트만으로는 3개 모두 통과했으므로, 이 게이트를 답변 가능성 보장으로 해석하면 안 된다. LLM 없는 모드는 답변 대신 검색 원문만 보여준다. 이는 개발자가 쓴 작은 확인용 평가이며 독립적인 정확도 검증이나 환각 방지 보장이 아니다.

코드/추출/개인정보 가림/출처 선택 검증/비밀값 방어/오류 처리와 환경변수만 사용하는 요청의 단위 테스트 9개를 통과했다. 환경 파일을 지정하지 않을 때 `Path(None)`으로 실패하던 문제를 고쳤다.

추가로 실제 Spring HTTP 경로에서 local RAG와 GPT를 함께 호출해 200·`answered`를 확인했다. 한 번의 요청은 6.71초였고, 검색 방식은 `bm25+local-cosine-rrf`, 컬렉션은 `rag-dd59ce17ec75b57d197a`, 반환 출처는 6개였다. 이는 실제 로컬 HTTP·외부 모델 연결 검증이며 RDS SQL 검색 또는 일반 지연시간 보장은 아니다. 근거는 Git에서 제외된 `backend/data/local-run/verification.json`이다.

실패 AWS 자원은 최종 암호화 백업을 보존한 뒤 정리했다. 현재 공개 서비스와 RDS는 없으며 실제 pgvector 적재·SQL 검색은 향후 배포에서 검증해야 한다. 평가 JSON과 벡터 캐시는 Git에서 제외된 `backend/data/rag/`에 남긴다.

## 공식 근거

- [OpenAI Embeddings 가이드](https://developers.openai.com/api/docs/guides/embeddings): 모델·1536차원·다국어 검색
- [OpenAI 임베딩 모델](https://developers.openai.com/api/docs/models/text-embedding-3-small): 모델 및 과금 단위
- [pgvector 공식 저장소](https://github.com/pgvector/pgvector): `vector`, 코사인 `<=>`, 정확 검색
- [AWS RDS PostgreSQL 확장 목록](https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-extensions.html): PostgreSQL 18.6의 pgvector 0.8.2 지원. 실제 리전/엔진 가용성은 배포 API 확인값을 따른다.
- [온비드 목록](https://www.data.go.kr/data/15157252/openapi.do), [온비드 상세](https://www.data.go.kr/data/15157254/openapi.do): 원천 정의·연결 번호·이용 조건
