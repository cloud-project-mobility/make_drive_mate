# 자동 검사와 ECS 배포 연결

`ci.yml`은 main push와 PR을 검사한다. `deploy.yml`은 성공한 `DriveMate CI`의 main push 완료를 받아 **기존 ECS Fargate API 서비스만** 자동 갱신하도록 준비되어 있다. 성공한 main CI 실행 번호를 지정하는 수동 실행도 유지한다. 대상은 [cloud-project-mobility/make_drive_mate](https://github.com/cloud-project-mobility/make_drive_mate)다. 소스 준비, 원격 CI 성공, AWS 권한 연결, 실제 배포 완료를 구분한다. 로컬 회귀 검사만으로 AWS 배포 성공을 주장하지 않는다.

**현재 AWS OIDC 배포 연결은 완료되지 않았다.** 조직 정책의 OIDC 조회 거절로 provider와 배포 역할을 확인하지 못했으며, 확인 전에는 `AWS_ROLE_ARN`을 추정하여 등록하지 않는다. 해당 변수가 없으면 자동 배포 job은 건너뛴다. 수동 실행은 첫 검증 단계에서 연결 누락을 명시하며 실패한다. 다른 5개 변수를 설정하거나 workflow가 등록된 것만으로 자동 배포가 작동한다고 보지 않는다.

조회 거절은 provider나 역할이 존재하지 않는다는 증거가 아니다. AWS Builder ID 간편 프로젝트 모드라면 AWS가 관리하는 조직 정책의 제한인지 먼저 확인하고, AWS Settings 및 [공식 고급 기능 활성화 안내](https://docs.aws.amazon.com/accounts/latest/reference/activate-advanced-features.html)에서 필요한 전환 조건을 확인한다. 공식 안내상 [Paid Plan 업그레이드](https://docs.aws.amazon.com/accounts/latest/reference/upgrade-account.html)가 선행되어야 하고, 고급 기능 활성화는 되돌릴 수 없으며 기존 지출 한도를 제거하고 다시 설정할 수 없게 한다. 단순 CD 설정 승인과 계정 모드·요금제 전환 승인을 구분하며, 이런 영향에 대한 사용자 확인 전에는 전환하지 않는다. 모드 확인 및 권한 해결 뒤 기존 provider·배포 역할을 실제 조회하고 신뢰 조건을 검증한다.

자동 실행이 등록되지 않은 경우 CI를 `gh workflow run ci.yml --repo cloud-project-mobility/make_drive_mate --ref main`으로 수동 시작할 수 있다. 수동 CI는 검증용이며 release job을 건너뛴다. CD는 계속 **성공한 main push 실행만** 허용하므로 수동 CI 실행 번호로 배포할 수 없다.

## CI 산출물

- Java 17에서 Spring Maven verify 후 JAR를 보관한다.
- Python 3.12의 고정 의존성으로 ML·전처리·RAG·AWS·컨테이너 단위 테스트를 수행한다. 실제 OpenAI·온비드 호출은 하지 않는다.
- Node 24에서 npm ci/check, Expo 의존성 검사와 웹 export를 수행한다. 선택 Playwright 검사가 임시 Spring/H2와 내보낸 웹 산출물을 검증한다.
- 모두 통과한 main push만 `code-release-<소스 SHA>` artifact를 만든다. ZIP 파일별 해시, ZIP SHA-256 및 소스 SHA를 포함한다.

`EXPO_PUBLIC_KAKAO_JAVASCRIPT_KEY`는 GitHub Actions **변수**로 웹 빌드에 전달하는 공개 브라우저 키다. REST/Admin/OpenAI 키를 넣지 않는다. 카카오 도메인 등록과 지도 활성화는 별도다. 로컬 키 변경 후 export는 Metro 캐시 제거를 위해 `npm run export:web -- --clear`로 실행한다.

공개 저장소·코드 ZIP·컨테이너 context에는 개인 문서, 데이터, 모델, RAG 본문/색인, 계정 설정, 환경 파일을 넣지 않는다. CI는 재학습·임베딩·운영 모델 승격을 하지 않는다. 컨테이너 코드는 검증한 동일 SHA checkout에서, JAR/dist는 그 CI 실행 artifact에서 가져온다.

## AWS 연결 계약

`ecs-foundation.json` 및 `ecs-service.json`으로 필요한 인프라를 먼저 구성한다. `cicd-ecs.json`은 기존 ECR/ECS 출력과 **기존 GitHub OIDC Provider ARN**으로 배포 역할만 만든다. 계정 정책이나 서비스 연결 역할 생성 권한을 우회하지 않는다. 실제 권한 연결과 최초 배포는 별도 확인 사항이다.

| GitHub Actions 변수 | cicd-ecs.json 출력 |
|---|---|
| `AWS_ROLE_ARN` | `RoleArn` |
| `AWS_REGION` | `Region` |
| `ECR_REPOSITORY` | `RepositoryName` |
| `ECS_CLUSTER` | `ClusterName` |
| `ECS_SERVICE` | `ServiceName` |
| `ECS_API_TASK_FAMILY` | `ApiTaskFamily` (일반적으로 서비스 스택 이름 + `-api`) |

장기 AWS 키는 GitHub에 저장하지 않는다. 신뢰 조건은 audience `sts.amazonaws.com`과 실제 확인한 불변 subject `repo:cloud-project-mobility@341333303/make_drive_mate@1445282042:ref:refs/heads/main`의 정확한 일치다. subject가 달라질 수 있는 workflow `environment:` 설정은 현재 넣지 않는다.

역할은 지정 ECR 저장소의 조회·업로드, API task family의 revision 등록, 지정 서비스의 조회·갱신만 허용한다. PassRole은 execution/API role 두 개를 ECS tasks에 전달하는 것으로 제한한다. cycle 역할, 임의 RunTask, Secrets Manager·S3 데이터·DB·SSM 권한은 없다. `ecr:GetAuthorizationToken`, `ecs:DescribeTaskDefinition`은 AWS 권한 모델 때문에 Resource `*`를 사용한다. task에는 비밀값 대신 런타임 참조를 둔다.

코드 배포자는 실행 코드를 통해 애플리케이션 역할 권한을 사용할 수 있으므로 높은 신뢰가 필요하다. main 보호·리뷰·배포 실행 권한을 운영자가 제한해야 한다.

## 배포와 복구

1. 확인된 `AWS_ROLE_ARN`을 포함한 6개 변수가 설정되면 main push의 `DriveMate CI` 성공 완료가 자동 배포를 시작한다. 자동 실행은 이벤트의 CI 실행 번호를 사용하고, GitHub API로 같은 저장소·main push·정확한 ci.yml·성공 완료를 다시 검증한다. 현재 main SHA와 다르면 오래된 실행의 자동 배포를 거절한다. PR·수동 CI·실패 CI는 자동 배포하지 않는다. 수동 배포는 `Deploy reviewed DriveMate ECS release`에 성공한 main push CI 번호를 입력하며, 기존처럼 승인한 과거 실행을 선택할 수 있다.
2. 해당 소스 SHA로 checkout하고 그 실행의 artifact만 받아 ZIP 정체성·허용 경로·전체/파일 해시를 검사한다.
3. `deploy_ecs.py stage`는 JAR/dist만 새 checkout에 꺼낸다. 기존 파일은 덮어쓰지 않는다. `prepare_context.py`가 허용된 코드만 새 context로 모은다.
4. OIDC로 인증하여 linux/amd64 이미지를 빌드하고 ECR에 소스 SHA 태그로 올린다. 저장소는 제외 규칙 없는 IMMUTABLE이어야 한다. 같은 SHA가 이미 있으면 재사용하며, 실행에는 `repository@sha256:...` digest를 사용한다. Docker 인증은 임시 config에만 저장한다.
5. 빌드 뒤 OIDC 자격 증명을 다시 받아 배포·복구 시간을 확보한다. 서비스가 안정된 단일 task인지, API family·Fargate·awsvpc·api/nginx 두 health check·회로 차단기 rollback·0/100 배포 비율인지 확인한다.
6. 자동 모드는 이미지 빌드·업로드 뒤 ECS 배포 직전에도 main SHA를 다시 조회한다. 준비 중 main이 바뀌면 ECS 갱신을 시작하지 않는다. 수동 모드에는 이 최신 SHA 제한을 적용하지 않는다. 현재 task의 런타임 역할·비밀 참조·환경·볼륨·CPU/메모리 등을 유지하고 두 이미지 값만 같은 digest로 교체한 revision을 등록한다. 준비 중 서비스가 바뀌면 중단한다.
7. 새 revision으로 갱신하고 최대 약 20분 안정화를 기다린다. waiter가 성공해도 **기대한 새 revision이 COMPLETED인지** 재확인한다. 회로 차단기가 이전 revision으로 복구한 경우는 배포 실패다.
8. 실패하면 이번/이전 revision일 때만 이전 revision 복구 및 안정화를 확인한다. 다른 운영자 revision이 관찰되면 덮어쓰지 않는다. 복구 미확인은 재시도 전에 ECS를 점검한다. 비밀 없는 image.json/ecs-deployment.json을 artifact로 남긴다.

위치 중계가 단일 프로세스 메모리를 사용하므로 task 1개, minimumHealthyPercent 0 / maximumPercent 100의 **중단 배포**를 유지한다. 연결이 끊기면 사용자가 다시 공유를 시작해야 한다. workflow는 같은 배포를 직렬화하지만 콘솔/다른 도구를 잠그지 않으므로 배포 중 수동 갱신을 병행하지 않는다.

모델/RAG/개인 데이터는 이미지에 없다. 컨테이너는 현재 task의 비공개 release 위치와 SHA를 유지해 허용된 데이터 파일만 가져온다. CD는 이 위치나 운영 모델을 변경하지 않는다. 의존성은 새 이미지에서 고정 requirements로 설치·검사한다. DB 스키마·모델 인터페이스는 별도 호환성 검토가 필요하며 이미지 rollback은 DB 변경을 취소하지 않는다.

**cycle은 이번 CD 대상이 아니다.** 현재 one-shot task definition만 있고 실행 일정은 없다. cycle 이미지 변경은 별도 검토 후 CloudFormation ImageUri 갱신으로 수행한다. API의 CLI 갱신은 CloudFormation과 task revision 차이를 만들므로 후속 스택 갱신 시 현재 승인한 ImageUri를 지정하고 변경 세트를 검토한다. 오래된 ImageUri를 다시 적용하지 않는다.

## 검증 범위와 이전 경로

합성 AWS 클라이언트 테스트는 runtime 설정 보존, 불안정 서비스 거절, 기대 revision 확인, 자동 rollback을 성공으로 오인하지 않음, 복구/동시 변경 보호, 제한된 artifact 추출, 불변 이미지 재사용, OIDC/IAM 계약을 검증한다. 실제 ECR push, ECS 안정화·복구, OIDC 연결은 별도 실환경 검증이 필요하다.

```bash
python -m unittest discover -s infra/aws -p test_deploy_ecs.py -v
python -m unittest discover -s infra/aws -p test_cycle_worker.py -v
node --test scripts/test-deploy-workflow.cjs
cfn-lint --format json --regions ap-northeast-2 -t infra/aws/cicd-ecs.json
```

기존 cicd.json 및 deploy_release.py publish/apply는 EC2/SSM 경로로 보존하며 현재 deploy.yml은 호출하지 않는다. deploy_release.py의 ZIP 생성·검사는 계속 사용한다. quality.yml은 FastAPI 시절 수동 검사다.

공식 근거: [서비스 갱신](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_UpdateService.html), [회로 차단기와 rollback](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-circuit-breaker.html), [task 등록](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_RegisterTaskDefinition.html), [ECS 권한 범위](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ecs.html), [ECR 업로드 권한](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-push-iam.html), [GitHub AWS OIDC](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws).


## Expo compatibility prerequisite · 2026-11-09

Calendar verification found that the existing SDK 57 dependency set failed Expo's online compatibility check before browser tests could run. Update only the five reported patches: Expo 57.0.32, constants/location 57.0.23, notifications 57.0.25, and router 57.0.30, together with the lockfile. Keep `npx expo install --check` enabled in CI. This is a patch compatibility prerequisite, not an SDK upgrade or deployment. See the [Expo CLI installation guidance](https://docs.expo.dev/more/expo-cli/#install).
