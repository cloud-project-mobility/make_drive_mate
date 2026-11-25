# 공식 Sample 실행 보고서

2026-11-25 13:46 KST, 현대 공식 콘솔의 Sample Test가 제공한 cURL에서 테스트 설정을 확인했습니다. WSL Python에서 동일한 누적거리 GET을 보내 **HTTP 403, 206.99ms**를 받았습니다. JSON 오류 응답에 별도 공급자 코드가 없어 누적거리 값은 검증하지 못했습니다. 콘솔도 사용자 ID에 적합한 클레임이 없다는 오류를 표시했습니다. 후속 차량 데이터 요청은 0건입니다. 테스트 설정은 로컬 .env에만 있습니다.

사용자가 제공한 19개 승인 내역은 공개 규격 19개와 일치합니다. [승인 목록](API_MATRIX.md) · [정확한 UTC 시각·권한 오류·구조 검사 상태](evidence/sample-odometer-20261125.json)

| 항목 | 자체 Mock | 공식 Sample | HTTP |
|---|---|---|---|
| 내 차량 리스트 | 미구현 | 콘솔에 Sample 버튼 없음. 외부 Sample 경로 미확인 | — |
| 누적 운행 거리 | 통과 | 실제 공식 Sample 호출 실패 | 403 |
| 주행 가능 거리 | 통과 | 누적거리 실패 뒤 미호출 | — |
| 엔진오일 경고등 | 통과 | 누적거리 실패 뒤 미호출 | — |
| 타이어 공기압 경고등 | 통과 | 누적거리 실패 뒤 미호출 | — |
| 브레이크 오일 경고등 | 통과 | 누적거리 실패 뒤 미호출 | — |
| 주유 경고등 | 통과 | 누적거리 실패 뒤 미호출 | — |
| 워셔액 경고등 | 통과 | 누적거리 실패 뒤 미호출 | — |
| 스마트키 배터리 상태 | 통과 | 누적거리 실패 뒤 미호출 | — |
| EV 배터리 잔량 | 통과 | 누적거리 실패 뒤 미호출 | — |
| EV 충전 상태 | 통과 | 누적거리 실패 뒤 미호출 | — |

공식 Sample 성공 0개, 실제 실패 1개, 우선 대상 중 미검증 10개입니다. 공식 성공 fixture는 0개이고 실차 연동은 미검증입니다. 콘솔에서 상태 4종·경고등 7종·가입일/종료일에 테스트 표시를 확인했습니다. 현대 기술지원에는 시간, 경로 템플릿, HTTP 403과 콘솔 오류 문구를 제공해 테스트 토큰의 차량 클레임을 확인할 수 있습니다.

최종 오프라인 재검증에서 `uv sync --locked` 성공, pytest **149개 통과**, 자체 Mock **10개 통과**, 설정값 2개와 대조한 소스·출력 비밀정보 검사 **발견 0건**을 기록했습니다. [비밀정보 검사](evidence/secret-scan.json)

<details>
<summary>같은 날 13:04까지의 초기 검증 기록 (당시 Sample 설정 없음)</summary>

검증일: **2026-11-25, Asia/Seoul**. 기존 2026-10-13 보고서를 이번 결과로 교체했습니다.

## 결론

- 코드 구현: 완료. 기존 검증 코드 재사용 + WSL 환경/진단/회귀 테스트/현행 문서 보완.
- 자체 Mock: 10종 성공. 자동 테스트 **149 passed, 0 failed (0.24s)**.
- 공식 차량 Sample 데이터: **실제 HTTP 호출 0회, 성공 0개, 미검증 11개**. 차량 보유 없이 수신 가능하다는 결론을 이번 실행으로 확정할 수 없습니다.
- 공식 Sample 미지원 확정: 0개. 설정 URL 404나 표시 부재만으로 전체 미지원을 단정하지 않습니다.
- 실차 연동·사용자 OAuth·차량 동의·운영 DB 저장: 미검증.

## 실제 경로와 환경

`/home/hyuksu/projects/drivemate_hyundai_developers/hyundai-api-experiments`

Windows 탐색기 경로는 `\\wsl$\Ubuntu\home\hyuksu\projects\drivemate_hyundai_developers\hyundai-api-experiments`입니다.
WSL Ubuntu에서 프로젝트 전용 uv 0.12.23, 관리형 Python 3.11.17, .venv를 실제 생성해 실행했습니다.
다른 프로젝트/시스템 Python의 패키지는 변경하지 않았습니다. [재사용·pull 내역](PROVENANCE.md)을 참고하세요.

## API별 결과

| API | 자체 Mock | 공식 Sample | 데이터 HTTP 상태 |
|---|---|---|---|
| 내 차량 리스트 | — | 미검증: Sample 경로·접근 조건 미확인 | 요청 안 함 |
| 누적 운행 거리 | 통과 | 미검증: 설정 누락 | 요청 안 함 |
| 주행 가능 거리 | 통과 | 미검증: 누적거리 선행 조건 미충족 | 요청 안 함 |
| 엔진오일 경고등 | 통과 | 미검증: 누적거리 선행 조건 미충족 | 요청 안 함 |
| 타이어 공기압 경고등 | 통과 | 미검증: 누적거리 선행 조건 미충족 | 요청 안 함 |
| 브레이크 오일 경고등 | 통과 | 미검증: 누적거리 선행 조건 미충족 | 요청 안 함 |
| 주유 경고등 | 통과 | 미검증: 누적거리 선행 조건 미충족 | 요청 안 함 |
| 워셔액 경고등 | 통과 | 미검증: 누적거리 선행 조건 미충족 | 요청 안 함 |
| 스마트키 배터리 | 통과 | 미검증: 누적거리 선행 조건 미충족 | 요청 안 함 |
| EV 배터리 잔량 | 통과 | 미검증: 누적거리 선행 조건 미충족 | 요청 안 함 |
| EV 충전 상태 | 통과 | 미검증: 누적거리 선행 조건 미충족 | 요청 안 함 |

Mock 성공을 공식 Sample 성공으로 합산하지 않습니다. 설정 조회/문서 조회와 차량 데이터 조회도 별개입니다.
내 차량 리스트의 HTTP 상태·응답시간·필수 구조 검증은 모두 해당 없음이며 가상 응답도 만들지 않았습니다.

## 직접 관찰한 증거

1. Windows의 정상 HTTPS에서 공식 누적거리 페이지와 공개 규격 19개를 HTTP 200으로 읽었습니다.
   현재 규격 응답에는 sampleTestYn 필드가 없습니다. 공개 페이지/스크립트의 과거 Sample UI를 재확인하지 못했습니다.
2. 12:15:30 KST 시작한 과거 Sample 설정 GET은 **HTTP 404, 671ms**였습니다.
   URL: `https://developers.hyundai.com/api/v1/sampleTest/getSampleTestInfo`.
   공개 설정을 얻지 못했고 토큰이나 차량 ID를 생성하지 않았습니다. 이는 차량 데이터 호출 실패와 다릅니다.
3. WSL 공식 문서/설정 조회는 **tls_error**입니다. 별도 Python 진단은
   `SSLCertVerificationError`, `unable to get local issuer certificate`, verify_code=20을 확인했습니다.
   시스템 인증서·DNS·프록시를 바꾸거나 TLS 검증을 끄지 않았습니다.
4. 12:22:28 KST에 Python CLI로 누적거리를 우선 실행했습니다.
   `configuration_missing`, 종료 코드 2, `network_attempted=false`, `http_status=null`입니다.
   `HYUNDAI_SAMPLE_TOKEN`, `HYUNDAI_SAMPLE_CAR_ID`가 비어 있었으므로 요청하지 않았습니다.
5. 12:23:02 KST WSL의 `dev.kr-ccapi.hyundai.com` 진단은 DNS/TCP/TLS 연결이 가능했고,
   인증정보 없는 **HEAD /**가 HTTP 404(116.78ms)를 반환했습니다. 이는 연결 확인이며 Sample 데이터 성공/실패가 아닙니다.

토큰 누락과 TLS 오류가 관찰됐으며, 실제 토큰 만료·권한 부족·429는 이번에 관찰되지 않았습니다.
401/403/429/5xx/timeout 등은 오프라인 Mock에서만 시험했습니다.

공유 가능한 원천 진단:

- [실행·Mock 요약 JSON](evidence/run-summary.json)
- [공식 공개 문서 조회 메타데이터](evidence/document-audit.json)
- [Sample 설정 조회 404](evidence/sample-settings-http.json)
- [WSL 설정 조회 TLS 분류](evidence/sample-info-diagnostic.json)
- [차량 API 호스트 연결 진단](evidence/network-diagnostic.json)

이 파일은 실제 도구 실행의 비밀값 없는 메타데이터를 옮긴 로컬 기록이며 공급자가 서명한 증명서는 아닙니다.
실제 차량 응답 fixture는 없습니다. 공식 예시나 Mock을 실제 수신 fixture로 옮기지 않았습니다.

## 실행 명령과 결과

아래 uv 명령은 `source scripts/enter.sh` 이후 프로젝트 폴더에서 실행했습니다.

| 명령 | 실제 결과 |
|---|---|
| bash scripts/setup.sh | 성공, 설치된 Python/잠금 의존성 재확인 |
| uv python install 3.11 | 프로젝트 .python-runtime에 3.11.17 설치 |
| uv lock | 기존 잠금 재사용, 16개 패키지 해결 |
| uv sync --locked | 성공, 전용 .venv 의존성 15개 설치/확인 |
| uv run pytest | 149 passed |
| uv run ruff check src scripts tests | 성공 |
| uv run hyundai-experiments mock 각 API | 10종 모두 mock_only_validated, 외부 요청 없음 |
| uv run hyundai-experiments sample odometer | 종료 2, 설정 누락, HTTP 요청 안 함 |
| uv run python scripts/import_official_sample.py | 종료 1, tls_error |
| uv run hyundai-experiments diagnose | 종료 0, HEAD / 404, API 성공 의미 아님 |
| uv run python scripts/verify_mock.py | 성공, 자체 Mock 누적거리 검증 |
| uv run python scripts/check_secrets.py | 78개 파일 검사, 발견 0, Git 제외 규칙 확인 |

추가 테스트 작성 중 모듈 import 경로 오류로 한 번 148 passed / 1 failed가 났으며
테스트 로더를 고친 뒤 149개가 통과했습니다. 성공으로 감춘 실패 명령은 없습니다.
Windows 기본 격리 환경의 문서 조회는 DNS 오류였고 허용된 네트워크 실행에서는 정상 조회됐습니다.
중간 문서 저장 시 Windows 경로 조합 오류도 수정했습니다. 이는 서버/API 실패가 아닙니다.
GitHub Actions는 설정만 작성했으며 push나 원격 CI 실행을 하지 않았습니다.

## 비밀정보와 Git 상태

실제 Sample 토큰·Client Secret을 가져오지 않았습니다. .env는 빈 템플릿으로 권한 600입니다.
원본 응답·계정 식별자·토큰을 로그나 문서에 저장하지 않았습니다.
검사 범위는 코드/문서/로컬 진단과 알려진 비밀 패턴입니다. 다른 저장소 전체 이력 검사 결과로 확대 해석하지 않습니다.
[최종 검사 결과](evidence/secret-scan.json)를 확인하세요.
새 프로젝트는 원격 연결/커밋 없는 로컬 Git 상태로 두었습니다. .env/.venv/.tools/output 제외를 확인했습니다.

## 다음에 필요한 조건

- 승인된 API 목록 또는 콘솔 화면의 항목명: 현재 공개 19개와 승인 19개를 실제로 대조할 근거.
- 현재 공식 Sample 제공 방식, 유효한 Sample 토큰과 차량 ID, 허용 요청 경로: 값을 채팅에 넣지 말고 로컬 .env에 설정.
- WSL 문서 호스트 TLS 체인 오류 해결: 신뢰 가능한 인증서 체인/환경 점검. 검증 비활성화 금지.
- 누적거리 실제 성공 이후에만 나머지 호출. 정확한 호출 제한·저장/캐시·외부 AI 조건은 별도 확인.

현재 미확인 기능을 성공으로 채우지 않은 상태이며, 구현·오프라인 검증·공유 문서까지 검토 가능한 상태입니다.

</details>
