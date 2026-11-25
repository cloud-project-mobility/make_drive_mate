# hyundai-api-experiments

DriveMate용 Hyundai Developers 공식 Sample API를 외부 Python에서 검증하는 독립 실험입니다.

2026-11-25 13:46 KST, 현대 공식 콘솔의 Sample Test가 제공한 cURL에서 테스트 설정을 확인했습니다. WSL Python에서 동일한 누적거리 GET을 보내 **HTTP 403, 206.99ms**를 받았습니다. JSON 오류 응답에 별도 공급자 코드가 없어 누적거리 값은 검증하지 못했습니다. 콘솔도 사용자 ID에 적합한 클레임이 없다는 오류를 표시했습니다. 후속 차량 데이터 요청은 0건입니다. 테스트 설정은 로컬 .env에만 있습니다. [실제 호출 증거](docs/evidence/sample-odometer-20261125.json)

- [실행 결과와 증거](docs/RUN_REPORT.md)
- [현재 공식 API 목록·필드·단위·인증](docs/API_MATRIX.md)
- [DriveMate 적용 보고서](docs/DRIVEMATE_REPORT.md)
- [응답 모델과 Python 사용법](docs/MODELS.md)
- [오류·보안·저장 조건](docs/CONTRACT_AND_SECURITY.md)
- [기존 자료 재사용 내역](docs/PROVENANCE.md)

## 1. 설치

실제 작업 경로는 `/home/hyuksu/projects/drivemate_hyundai_developers/hyundai-api-experiments`입니다.
WSL Ubuntu에서 Python 3.11.17, uv 0.12.23을 사용했습니다. 시스템 Python과 다른 프로젝트의 가상환경은 변경하지 않았습니다.

```bash
cd /home/hyuksu/projects/drivemate_hyundai_developers/hyundai-api-experiments
bash scripts/setup.sh
source scripts/enter.sh
uv sync --locked
uv run python --version
```

`setup.sh`는 필요한 경우 uv를 `.tools/`에 설치하고 관리형 Python을 `.python-runtime/`, 패키지를 `.venv/`에 설치합니다.
새 터미널마다 `source scripts/enter.sh`를 실행합니다. `.venv`를 다른 PC나 Windows로 복사하지 마세요.
`uv.lock`은 기존 잠금 파일을 재사용한 뒤 이번 WSL에서 `uv lock`, `uv sync --locked`로 실제 검증했습니다.
Windows용 기존 `setup.ps1`·`enter.ps1`도 보존했지만 같은 폴더의 Linux `.venv`와 혼용하지 말고 별도 복사본을 쓰세요.
이번 Windows Python 프로젝트 실행은 하지 않았습니다.

## 2. 환경변수 설정

아직 `.env`가 없다면 `.env.example`을 복사한 후 로컬 편집기로 입력합니다.

```bash
[ -e .env ] || cp .env.example .env
chmod 600 .env
```

- `HYUNDAI_SAMPLE_TOKEN`: 공식적으로 발급/제공받은 Sample 토큰. Bearer 접두사 제외.
- `HYUNDAI_SAMPLE_CAR_ID`: 해당 토큰으로 접근 가능한 공식 테스트 차량 ID.
- `HYUNDAI_CLIENT_ID`, `HYUNDAI_CLIENT_SECRET`, `HYUNDAI_REDIRECT_URI`: 향후 개인 OAuth용이며 이번 Sample GET에 사용하지 않습니다.

코드는 선택된 로컬 `.env`만 읽습니다. 다른 프로젝트의 `.env`나 프로세스 토큰을 자동으로 가져오지 않습니다.
실제 값을 명령행·문서·테스트·CI에 넣지 마세요. 이 환경에서는 공식 콘솔이 표시한 Sample 설정을 사용했습니다.

기존 `uv run python scripts/import_official_sample.py`는 **과거 공식 UI의 설정 조회 경로**를 유지한 진단 도구입니다.
2026-11-25 기준 해당 경로가 404이므로 정상 설치 절차로 기대하지 마세요.
DriveMate 콘솔에서 데이터 API → 차량 상태 → 누적 운행 거리 조회 → Sample Test로 이동합니다. 테스트 차량을 선택하고 호출하면 cURL에서 Sample 경로와 Authorization 헤더를 확인할 수 있습니다. 이 명령에는 토큰과 차량 ID가 포함되므로 팀 문서에는 경로 템플릿과 결과만 기록합니다.
URL을 추측하거나 개인 토큰으로 대체하지 않습니다.

## 3. Mock 실행

```bash
uv run hyundai-experiments mock odometer
uv run hyundai-experiments mock ev-charging
uv run python scripts/verify_mock.py
```

합성 fixture + `httpx.MockTransport`만 사용합니다. `source=MOCK`, `network_attempted=false`,
`verification_outcome=mock_only`로 표시합니다. `status=mock_only_validated`는 실서버 성공이 아닙니다.
오류 재현: `uv run hyundai-experiments mock odometer --scenario unauthorized` (예상 종료 코드 1).

## 4. 공식 Sample 호출

로컬 Sample 설정을 저장한 뒤 **누적거리부터** 실행합니다.

```bash
uv run hyundai-experiments sample odometer
```

최근 실제 호출은 종료 코드 1, `sample_failure`·`permission_denied`입니다. 설정이 빠진 환경은 종료 코드 2, `not_verified`입니다.
누적거리 고정 Sample 경로는 현재 로그인 콘솔의 cURL과 일치합니다. 나머지 데이터 경로의 실행 결과는 API별 표에 기록했습니다.
실차 `/api/v1/` 경로로 자동 전환하지 않습니다.

누적거리 성공 후 나머지를 검증하는 단일 실행 명령은 아래와 같습니다.
이 명령 자체가 누적거리부터 시작하므로 위 단일 명령과 중복 실행하지 않아도 됩니다.

```bash
uv run python scripts/verify_suite.py
```

누적거리 실패 시 중지합니다. 이후에도 인증·권한·429·서버·네트워크 실패에는 중지하고
남은 API를 미검증으로 기록합니다. 재시도 0회, TLS 검증 켬, 리다이렉트 없음, Mock 대체 없음.
`--resume-from`은 같은 설정으로 방금 성공한 본인 누적거리 진단에만 사용하며 과거/타인의 로그를 재사용하지 않습니다.
내 차량 리스트 Sample 명령은 제공하지 않습니다. 공식 근거가 없는 URL을 만들지 않았습니다.

## 5. 결과 확인

`output/`의 JSON에는 시작/수신 UTC 시각, API 이름, 마스킹된 요청 URL, HTTP 상태,
공급자 오류 코드, 응답시간, JSON·필수 구조 검증 결과가 있습니다. 실제 응답 본문은 메모리에서만 다룹니다.
`data`, 토큰, 차량 ID, 오류 원문은 진단에 포함하지 않습니다. `--no-save`로 파일 저장을 생략할 수 있습니다.

| verification_outcome | 의미 |
|---|---|
| sample_success | 실제 Sample HTTP 200 + 오류 본문 없음 + 필수 구조 검증 통과 |
| sample_failure | 실제 Sample 전송/HTTP/본문/구조 실패. 세부 status로 구분 |
| not_verified | 설정 부족 등으로 요청하지 못함 |
| sample_unsupported | 공식 미지원이 확인된 경우만 사용. 이번에는 해당 없음 |
| mock_only | 자체 Mock 실행. 성공 여부는 별도 status 확인 |

401만으로 만료라고 단정하지 않습니다. 4011은 데이터 API 헤더 오류, 4012는 세션 오류로 분류하며
그 밖에는 invalid/expired 미구분입니다. 자동 토큰 갱신 기능은 없습니다.
단위 미상·필수 null·빈 누적거리 배열은 0이나 정상으로 바꾸지 않고 검증 실패합니다.

## 6. 테스트와 공개 전 검사

```bash
uv run pytest
uv run ruff check src scripts tests
uv run python scripts/check_secrets.py
```

기본 테스트는 외부 소켓 연결을 차단하며 401·403·429·5xx·timeout·잘못된 JSON·누락·빈 배열·null·미상 단위·부분 실패를 검증합니다.
GitHub Actions는 Ubuntu/Windows에서 비밀키 없는 오프라인 테스트만 실행합니다. 이번에 Actions를 원격 실행하지 않았습니다.
`.env`, `.venv/`, `.tools/`, 런타임·캐시, `output/`은 Git 제외입니다.
`fixtures/sample_responses/`는 실제 수신 자료가 없어 비어 있고 안내문만 있습니다.

```text
src/hyundai_experiments/  설정·고정 API 목록·클라이언트·타입 모델·오류·CLI
scripts/                 설치·Sample/Mock 실행·비밀정보 검사
fixtures/mock_responses/ 직접 만든 가상 응답
fixtures/sample_responses/ 실제 수신 자료 전용 (이번에는 없음)
tests/                   외부 통신을 차단하는 pytest
docs/                    규격·실행 증거·한계·DriveMate 설계
```
