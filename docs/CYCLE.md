# 반복 데이터 분석 사이클

`backend/scripts/onbid_pipeline.py`는 **수집 → 원본 저장 → 전처리 → 모델 비교·평가 → 집계·시각화**를 한 번 실행하는 CLI다. 같은 명령을 수동으로 다시 실행하거나, 서버 스케줄러에서 호출할 수 있다. 스케줄을 등록하거나 새 모델을 운영 모델로 자동 교체하지 않는다.

## 실행

Python 3.12에 `backend/requirements-ml.txt`를 설치한 환경을 사용한다. 로컬 검증 환경은 `backend/data/onbid/.venv-ml/bin/python`이다.

```text
python backend/scripts/onbid_pipeline.py --reuse-run backend/data/onbid/run-20261104-annual
python backend/scripts/onbid_pipeline.py --start 2025-11-04 --end 2026-11-03 --max-calls 100
```

- `--reuse-run`은 기존 수집 폴더의 `manifest.json`과 허용된 원본 페이지만 체크섬 검증 후 복사한다. API를 호출하지 않는다. 기존 원본·정제·모델을 덮어쓰지 않는다.
- 신규 수집은 `.env.onbid.local`의 키를 사용한다. 필요하면 서버가 고정한 `--env` 파일 경로를 사용한다. 종료일은 한국 시간 기준 오늘 이전이어야 한다.
- 호출 예산은 `--max-calls` 1~100회이며 재시도도 포함한다. 예산 초과 또는 API 오류는 실패로 기록한다. 빈 데이터로 조용히 대체하지 않는다.
- 전체 실행의 기본 출력은 `backend/data/onbid/pipeline/`이며 `--output-root`로 바꿀 수 있다. 반복 실행마다 새 run ID를 만든다.

## 파일과 상태

```text
pipeline/
  latest.json                 # 최신 성공 실행의 안전한 집계 결과
  latest-attempt.json          # 최근 시도의 성공/실패 상태
  history.jsonl               # 실행 이력
  runs/<run-id>/
    manifest.json             # 단계별 상태·시각·코드 SHA256
    data/manifest.json        # 수집 조건과 원본 SHA256
    data/raw/                 # 원본 응답
    data/processed/           # 정제 CSV·제외 CSV·품질 요약
    model/                    # 후보 모델·분할·전체/조건부 평가
    summary.json              # 공개 가능한 집계 JSON
    report.html               # 외부 라이브러리 없이 열리는 독립 보고서
    charts/*.svg              # 재사용 가능한 개별 차트
```

수집·원본 재사용, 전처리, 학습·평가, 집계, 시각화의 각 단계가 시작/완료/실패로 기록된다. 실패한 실행 폴더를 보존하고 `latest-attempt.json`과 `history.jsonl`에 실패 유형을 남긴다. API 키나 원시 예외 메시지는 기록하지 않는다. **실패한 실행이 `latest.json`의 마지막 성공 결과를 덮어쓰지 않는다.**

중복 실행은 `.cycle.lock`으로 거절한다. 프로세스가 강제로 종료되어 잠금이 남았다면 파일에 기록된 PID가 종료되었는지 확인한 뒤 관리자가 잠금을 제거한다. 성공한 실행 기록과 보고서는 분석 이력이며, 오래된 원본을 자동 삭제하지 않는다.

## 분석·시각화

원본/승용 범주/정제 건수, 결측률, 가격 분포, 차종별 건수, 개찰 월별 건수, 모델별 검증 MAE, 최종 시험 오차 분포를 HTML과 SVG로 만든다. 표·차트에는 원문 물건명, 물건관리번호, 차량번호, 연락처, 키를 넣지 않는다. 차종 문자열도 HTML escape와 차량번호 패턴 제거를 거친다.

모델 선택은 검증 구간 MAE로 하고 보정·최종 시험은 분리한다. 같은 차량 그룹이 시간 경계에 걸치면 제외한다. 미학습 모델·제조사 조합과 학습 수치 범위 밖 입력은 서비스에서 유보하므로, **전체 시험 성능과 가격 제공 대상의 조건부 성능·제공률을 함께 기록**한다. 고가 차량의 큰 오차를 숨기기 위해 가격을 잘라내지 않는다.

현재 검증된 2,197행 실행의 중요 기준은 Random Forest, 전체 최종 시험 341행 MAE 236.15만원, 가격 제공 대상 262행 MAE 134.74만원·제공률 76.83%다. 재실행으로 새 데이터가 들어오면 표본과 결과가 달라질 수 있다. 과거 값과 단순 비교해 성능 개선을 단정하지 않는다.

## 프런트 조회 계약

Spring의 인증된 `GET /api/v1/analytics/latest`는 서버가 지정한 `DRIVEMATE_ANALYTICS_REPORT` 파일을 읽는다. 기본 파일은 `pipeline/latest.json`이다. 응답은 다음 집계 구조이며 로컬 절대 경로와 개별 차량 ID를 포함하지 않는다.

```text
schema_version, run_id, status, generated_at, price_kind, production_promoted
source: mode, date_start, date_end, api_calls_this_run, original_collection_calls
quality: raw_rows, passenger_rows, clean_rows, excluded_rows,
         usable_percent_of_passenger, missing_rates, exclusion_reason_counts,
         exact_duplicate_rows, repeated_vehicle_groups
model: selected_model, validation_scores, test_metrics,
       service_support_audit, split_counts, source_sha256
charts: price_histogram, top_models, monthly_counts, category_counts,
        model_comparison, absolute_error_histogram
reports: html, svg
review_required
```

차트 행은 `{label, count}`이며 `model_comparison`만 `{label, mae_manwon}`이다. `reports`는 저장 루트 기준 상대 경로다. API가 원본 파일이나 모델 파일을 임의 경로로 읽도록 허용하는 경로가 아니다.

## 운영 모델 승격

모든 성공 응답은 `production_promoted=false`다. 실행 완료와 모델 평가 통과·사용 승인은 다르다. 새 후보를 운영에 반영하려면 데이터 단위, 표본 수, 전체·하위집단 오차, 제공률, 불확실성 구간, 실제 판매가격과의 차이를 별도로 검토하고 명시적으로 모델 경로를 변경한다. 이 사이클은 OpenAI 호출을 하지 않으며 LLM 비용을 발생시키지 않는다.

## EC2 · SQS · S3 worker

`infra/aws/cycle_worker.py`는 Spring과 분리된 단일 프로세스 worker다. `infra/aws/requirements-aws.txt`를 같은 Python 3.12 환경에 설치한다. AWS 자격 증명은 SDK 기본 체인으로 해결하며, 배포 환경에서는 EC2 instance profile을 사용한다. 정적 AWS 액세스 키를 코드에 넣지 않는다.

```text
python infra/aws/cycle_worker.py
python infra/aws/cycle_worker.py --once
```

`--once`도 실제 큐를 한 번 조회하는 운영 명령이다. 오프라인 테스트 명령은 아래와 같다.

```text
python -m unittest discover -s infra/aws -p test_cycle_worker.py -v
```

필수 환경변수는 `AWS_REGION`, `DRIVEMATE_CYCLE_QUEUE_URL`, `DRIVEMATE_DATA_BUCKET`이다. 추가 설정은 `DRIVEMATE_REPO_ROOT`, `DRIVEMATE_CYCLE_OUTPUT_ROOT`, 선택 KMS 키 `DRIVEMATE_DATA_KMS_KEY_ARN`이다. 온비드 키는 bootstrap의 `ONBID_SERVICE_KEY` 또는 `DRIVEMATE_ONBID_SECRET_ARN`이 가리키는 Secrets Manager JSON의 `ONBID_SERVICE_KEY`를 시작 시 읽는다. 실행 중에만 쓰는 키 파일은 임시 디렉터리의 0600 파일이며 원본·보고서 경로와 분리한다.

메시지 본문은 **정확히** `{"kind":"refresh","schema_version":1}`만 허용한다. 본문으로 명령·날짜·키·파일 경로를 바꾸지 못한다. 조회 기간은 실행일의 한국 시간 어제까지 최근 365일이다.

- 최대 한 메시지씩, 20초 long polling. HTTP read timeout은 35초로 더 길게 설정했다.
- 최초 visibility 900초, 60초마다 900초로 갱신한다. 갱신 실패 시 진행 중 수집·학습 프로세스를 중단한다.
- 전체 작업 deadline은 1,800초다. 종료 시 자식 프로세스를 정리하고 실패 메시지를 삭제하지 않는다.
- 큐에 `RedrivePolicy.maxReceiveCount=3`과 DLQ가 없으면 시작을 거절한다. 실제 DLQ 생성·권한·스케줄 설정은 별도 인프라 배포에 속한다.
- SQS MessageId의 SHA256을 작업 ID로 사용한다. `data/cycles/completed/<job-id>.json`이 있으면 재수집하지 않고 메시지를 삭제한다. 완료 marker는 모든 게시가 성공한 뒤, 메시지를 삭제하기 전에 쓴다. 이는 완료 작업의 중복 방지이며 모든 장애 상황에 대한 exactly-once 보장은 아니다.
- `data/cycles/jobs/<job-id>.json`의 사용/예약 ledger가 동일 메시지의 재시도까지 합쳐 온비드 요청을 100회 이내로 제한한다. 요청 전 남은 예산을 예약하고, 자식 수집 manifest의 실제 요청 수로 정산한다. 강제 종료로 정산 여부가 불명확하면 자동으로 다시 과금성 호출을 허용하지 않는다. 관리자가 원본 manifest와 ledger를 확인해야 한다.
- 전처리·학습 실패 후 원본 수집이 완료되어 있으면 재시도는 해당 원본을 재사용한다. S3 업로드 실패 후 로컬 분석이 완료되어 있으면 분석 결과를 재사용한다.

실행 데이터는 우선 `pipeline/jobs/<job-id>/runs/<run-id>/`에 보관한다. 성공한 실행의 원본·정제 CSV·모델·보고서를 `s3://<data-bucket>/data/cycles/<run-id>/`로 올린 뒤, S3 `data/cycles/latest.json`을 단일 객체 PUT으로 게시한다. 이후 Spring이 읽는 로컬 `pipeline/latest.json`도 원자적으로 교체한다. `.env` 등 숨김 파일·심볼릭 링크·지원하지 않는 확장자는 업로드하지 않는다. 암호화는 기본 SSE-S3(AES256), KMS 환경변수가 있으면 지정 KMS 키를 사용한다. public ACL은 지정하지 않으며 버킷의 Block Public Access는 인프라에서 강제한다.

instance profile에는 해당 큐의 ReceiveMessage, DeleteMessage, ChangeMessageVisibility, GetQueueAttributes, 데이터 버킷의 이 prefix에 대한 GetObject/PutObject, 필요한 경우 지정 Secret의 GetSecretValue와 지정 KMS 키 권한만 부여한다. 원문·모델은 비공개 객체이며 공개 분석 화면은 집계 JSON을 읽는다.

7개 오프라인 어댑터 테스트로 완료 중복 방지, 업로드 전 게시 금지, 실패 시 미삭제, 재시도 예산 정산, 강제 종료 예약 보존, 메시지 본문 제한, 집계 파일 권한을 확인했다. worker의 `umask 077` 아래에서도 API와 공유하는 `latest.json`만 교체 전에 `0640`으로 지정해 같은 배포 그룹이 읽을 수 있도록 한다. 원본·모델 파일 권한은 넓히지 않는다. AWS 실환경 실행 성공은 별도 배포 및 실제 큐·S3 검증 기록으로 확인해야 한다.

공식 참고: [SQS visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html), [SQS long polling 설정](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_sqs.CfnQueueProps.html).
