# 작업 환경과 자료 출처

확인일: 2026-11-25 (Asia/Seoul).

- 최초 작업 폴더 `/home/hyuksu/projects/drivemate_hyundai_developers`는 비어 있었고 Git 저장소가 아니었습니다. 제공 ZIP과 설정 파일도 이 폴더에는 없었습니다.
- WSL은 접근 가능했습니다. 기본 격리 환경의 WSL 접근 오류 후 허용된 실행으로 Ubuntu에서 파일·실행 환경을 확인했습니다.
- DriveMate 실제 폴더: `/home/hyuksu/projects/cloud-project-mobility-20261104-Af613H/make_drive_mate`.
- 사용자 요청으로 `origin/main`을 `fcad7a6`에서 `dde036b`로 fast-forward pull했습니다. 새 커밋 9개, 기존 수정/미추적 파일 15개는 전후 SHA-256 비교로 보존을 확인했습니다. 처음 pull은 전역 rebase 기본 설정 때문에 거절됐고 이번 명령에만 `--no-rebase --ff-only`를 적용했습니다. 사용자 Git 설정은 변경하지 않았습니다.
- 로컬 웹 주소 `http://127.0.0.1:8081`, Spring API `http://127.0.0.1:18085`. 확인 당시 WSL에서 두 포트 모두 서비스가 실행 중이지 않았습니다. 카카오 검증 시에는 별도의 임시 루프백 포트에서 Spring을 실행하고 종료했습니다.
- 같은 상위 폴더의 `hyundai_devloper_api_experiments`에서 추적된 파일 40개를 새 프로젝트로 복사했습니다. 참조 커밋 `9949aa1ea49d00690135defd8baa0e6d280b6096`.
- 재사용: httpx 클라이언트, dataclass 파서, CLI, Mock fixture, 기존 테스트 141개, uv.lock, 설치/검사 스크립트. 원본 코드·가상환경·.env·Git 기록은 변경/복사하지 않았습니다.
- 추가/변경: WSL 전용 설치, 결과 상위 분류, 본문 success=false 거절, 설정 조회의 TLS 오류 분류, 추가 회귀 테스트, CI 플랫폼 구성, 현행 규격 대조, 문서 전체 갱신.
- 기존 실험 README의 10월 성공 주장과 DriveMate 원격 Sample 브랜치의 실패 서술이 일치하지 않았습니다. 당시 원본 실행 증거를 이번 환경에서 검증할 수 없어 어느 쪽도 이번 성공 증거로 채택하지 않았습니다.
- 원격 `feat/hyundai-sample-account-vehicles`를 격리 사본에서 점검했습니다. 외부 HTTP를 대체한 공급자 테스트와 H2 저장 회귀 검사를 실행했습니다.
- 현대 실험은 이 독립 프로젝트에 있습니다. 카카오 경로 폴링은 별도 DriveMate 앱 작업본에 적용했습니다. GitHub push·PR 생성·공개 게시·메시지 전송은 하지 않았습니다.

## 환경

WSL 시스템 Python은 3.12.3, 별도 설치된 3.11.15도 확인했습니다. 이번 실행은 둘을 변경하지 않고
프로젝트 안에 uv 0.12.23과 관리형 Python 3.11.17을 설치해 사용했습니다.
Windows Python 3.12는 읽기/문서 작성 도구에만 사용했고 패키지를 설치하지 않았습니다.
Windows의 공식 문서 조회는 PowerShell HTTPS를 사용했습니다. 이 조회를 Python Sample 데이터 성공으로 분류하지 않습니다.
