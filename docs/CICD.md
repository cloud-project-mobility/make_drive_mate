# 자동 검사와 수동 배포

`.github/workflows/ci.yml`은 main push와 pull request를 자동 검사한다. `.github/workflows/deploy.yml`은 성공한 main CI 실행 번호를 입력하고 버튼을 눌렀을 때만 배포한다. 현재 공개 반영 대상은 사용자가 지정한 [cloud-project-mobility/make_drive_mate](https://github.com/cloud-project-mobility/make_drive_mate)이며 쓰기·관리 권한을 확인했다. 코드 업로드와 실제 CI 실행 검증은 진행 중이다. **AWS 실행 대상이 없어 CD는 활성화하지 않는다.** 파일 작성, 원격 CI 성공, 실제 AWS 배포를 구분한다.

## 검사와 산출물

- Java 17에서 Spring Boot 4.1.2 Maven `verify`를 실행하고 JAR를 보관한다.
- Python 3.12의 고정 의존성으로 ML·전처리·RAG·AWS 어댑터 단위 테스트를 실행한다. 키를 받지 않으며 실제 OpenAI/온비드 호출을 하지 않는다.
- Node 24에서 `npm ci`, `npm run check`, Expo 의존성 검사, 실제 키 없는 Spring/H2를 붙인 선택 Playwright 테스트, 웹 export를 실행한다.
- 모두 통과한 main push만 JAR·웹·런타임 Python 코드의 `code-release.zip`과 SHA-256, Git 소스 리비전을 만든다.

기존 `quality.yml`은 FastAPI 시절 검사를 수동 실행으로 보존했다. 새 Spring 경로의 자동 게이트는 `DriveMate CI`다. Native 기기 검증이나 실제 AWS 실행을 CI 결과로 주장하지 않는다. 사용한 GitHub Actions는 공식 태그가 가리키는 전체 커밋 SHA로 고정했다. 변경할 때 공식 릴리스를 다시 확인한다.

배포 ZIP에는 `dist`, 고정 Spring JAR, `backend/scripts`의 런타임 Python, ML/RAG/AWS requirements, cycle/secret-refresh/deploy 코드만 들어간다. `.env`, `backend/data`, `model`, 원본 문서, DB 비밀번호는 허용 목록에 없다. 공개 저장소에도 원본 Office 문서·원시/정제 데이터·학습 모델·RAG 본문/색인·키·계정 설정을 올리지 않는다. ZIP 각 파일과 전체 ZIP의 해시를 검사한다. 앱 비밀값은 서버의 기존 환경과 Secrets Manager에 남는다. CI 모델 재학습, 새 RAG 임베딩, 운영 모델 자동 승격은 하지 않는다.

## AWS 연결

`infra/aws/cicd.json`은 기존 비공개 배포 버킷과 EC2를 입력으로 받아 OIDC 역할 및 고정 SSM 문서를 만든다. 기존 GitHub OIDC Provider ARN을 받으므로 같은 계정에 중복 Provider를 만들지 않는다. 실제 AWS 생성은 별도의 배포 작업이다.

| GitHub Actions 변수 | CloudFormation 출력 |
|---|---|
| `AWS_ROLE_ARN` | `RoleArn` |
| `AWS_REGION` | `Region` |
| `AWS_S3_BUCKET` | `ArtifactBucket` |
| `AWS_INSTANCE_ID` | `InstanceId` |
| `AWS_SSM_DOCUMENT` | `DocumentName` |

장기 AWS 키는 GitHub에 저장하지 않는다. 새 공개 대상의 GitHub API에서 확인한 불변 subject prefix는 `repo:cloud-project-mobility@341333303/make_drive_mate@1445282042`다. 신뢰 조건은 STS audience와 `repo:cloud-project-mobility@341333303/make_drive_mate@1445282042:ref:refs/heads/main` subject의 정확한 일치다. 환경 기반 subject로 바뀌지 않도록 workflow에 `environment:`를 넣지 않았다. main의 보호 규칙과 리뷰 권한은 운영자가 설정한다. 기존 `FE-test`는 로컬 코드의 출발점이며 새 배포 역할이 신뢰하는 원격 저장소가 아니다. 현재는 AWS 대상 호스트가 없으므로 이 역할·SSM 연결을 활성화하지 않는다.

역할은 `releases/code/*`에 업로드하고, 지정 EC2에서 지정 custom SSM 문서만 실행할 수 있다. Secrets Manager, DB, 임의 `AWS-RunShellScript` 실행 권한은 없다. `GetCommandInvocation`은 AWS 권한 모델 때문에 Resource `*`를 사용한다. 소스 코드 배포 권한은 결국 서버에서 실행될 코드를 바꿀 수 있는 높은 권한이므로 main과 배포 실행 권한을 신뢰할 수 있는 사람에게 제한해야 한다.

## 배포 흐름

1. main에서 `Deploy reviewed DriveMate release`의 Run workflow를 선택하고 성공한 `DriveMate CI` 실행 번호를 입력한다.
2. GitHub API로 해당 실행이 같은 저장소·main push·정확한 CI 파일·성공 완료인지 확인한다. PR 산출물은 배포하지 않는다.
3. 해당 실행의 코드 ZIP을 받아 소스 SHA, 내부 파일 해시, ZIP SHA와 허용 경로를 검사한 뒤 OIDC 자격증명을 요청한다.
4. `releases/code/<소스 SHA>/<ZIP SHA>.zip`에 암호화된 비공개 객체로 올린다.
5. SSM 문서에는 40자리 소스 SHA와 64자리 ZIP SHA만 전달한다. `allowedPattern`과 `ENV_VAR` 보간을 사용하며 호출자가 명령·파일 경로·버킷을 바꿀 수 없다.
6. 서버의 고정 `/opt/drivemate/infra/aws/deploy_release.py`가 파일 잠금을 잡고 다운로드·해시·허용 목록을 검사한다. requirements가 현재 서버와 다르면 서비스를 멈추기 전에 거부한다.
7. cycle/API/Nginx를 멈추고 코드 경로만 같은 파일시스템 안에서 백업·교체한다. API `/api/v1/health`와 Nginx를 통한 상태 검사를 통과하면 서비스를 다시 연다. 실패하면 기존 코드를 복원하고 이전 API 상태를 확인한다.

이 방식은 한 대의 기존 서버를 사용하는 짧은 중단 배포다. 무중단이나 DB 스키마 롤백을 보장하지 않는다. 서버 프로세스가 강제로 종료되어 `updating`에 남으면 자동으로 덮어쓰지 않고 운영자 복구를 요구한다. 작업 중인 데이터 수집은 서비스 종료로 중단될 수 있으며 원본/호출 예산/재시도 기록은 그대로 보존한다. 모델 파일, RAG active pointer, `backend/data`, venv, `/etc/drivemate`는 교체하지 않는다.

의존성, JVM 옵션, DB 스키마 변경이나 모델 호환성 변경은 이 코드 배포만으로 처리하지 않는다. 기존 데이터와 호환되는 마이그레이션을 검토하고 서버 환경을 별도 갱신해야 한다. 이전 ZIP을 다시 넣는 것만으로 DB 변경이 취소되지는 않는다. 백업은 `/opt/drivemate/.releases/`에 남으며 용량을 검토한 뒤 운영자가 정리한다.

최초 bootstrap의 release 허용 목록에 `infra/aws/deploy_release.py`가 포함되어 있어야 한다. 이 파일은 root 소유여야 하며 애플리케이션 계정이 수정할 수 없어야 한다. 오래된 SSM Agent가 `ENV_VAR` 보간을 지원하지 않으면 배포를 중단하고 Agent를 갱신한다. 보간을 shell 문자열로 완화하지 않는다.

## 로컬 검증

배포 패키지·해시·경로·비밀값 검사와 requirements 변경 거부, 상태 검사 실패 시 실제 임시 파일 복원, 확인된 불변 OIDC subject 일치를 검증하는 테스트 7개를 통과했다. 실제 빌드된 JAR와 웹을 사용한 로컬 패키지 시험은 44개 파일, 약 31.4 MB였으며 private data 제외를 확인했다. 이 시험은 예시 리비전으로 만든 로컬 산출물이며 배포하지 않았다.

`cfn-lint 1.59.0`에서 `cicd.json` 오류가 없었다. 고정된 공식 AWS Guard 규칙 중 IAM 신뢰 정책·와일드카드 Action·PassRole·관리자 정책·NotResource 관련 6개 제어가 모두 PASS였다. 이것은 해당 규칙 범위의 검증이며 전체 계정 보안 감사는 아니다. GitHub Actions 실행, 계정별 CloudFormation 사전 배포 검증, 실제 SSM 배포·복구는 활성화 후 별도 검증해야 한다.

```bash
python -m unittest discover -s infra/aws -p test_deploy_release.py -v
.venv-infra/bin/cfn-lint -t infra/aws/cicd.json
```

공식 근거: [GitHub AWS OIDC](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws), [워크플로 실행 이벤트](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), [SSM Command 문서와 ENV_VAR 보간](https://docs.aws.amazon.com/systems-manager/latest/userguide/documents-command-ssm-plugin-reference.html).
