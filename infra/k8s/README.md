# Kubernetes 전환용 기본 설정

현재 실제 운영 대상은 ECS Fargate다. 이 디렉터리는 같은 컨테이너 이미지를 Kubernetes에서 검토할 수 있도록 준비한 Kustomize base이며, 클러스터 생성이나 배포는 실행하지 않았다. 설정값과 비밀 연결을 채우기 전에는 기동되지 않는다.

`api`와 `nginx`는 같은 Pod에서 실행해 루프백 `18085`와 외부 제공 포트 `8080` 계약을 그대로 쓴다. 위치 중계가 프로세스 메모리에 있으므로 replica는 1, 배포 방식은 `Recreate`다. 업데이트 중 서비스가 잠시 중단되고 위치 연결을 다시 시작해야 한다. HPA나 두 번째 replica를 추가하려면 먼저 외부 공유 중계 저장소와 인증·TTL 처리를 설계해야 한다.

Pod는 UID/GID 10001과 `fsGroup: 10001`을 사용한다. 비관리자 init container가 각 `emptyDir` 쓰기 권한을 실제 확인하고 실패하면 시작을 막는다. API만 런타임 데이터를 쓰며 Nginx는 정적 웹 공유 볼륨을 읽기 전용으로 사용한다. 루트 파일시스템은 읽기 전용이고 Linux capability는 제거한다. 볼륨 그룹 권한의 근거는 [Kubernetes 보안 컨텍스트 문서](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/)다.

Kubernetes의 컨테이너 재시작에서는 `emptyDir`가 남으므로 API 시작 명령이 고정된 두 임시 볼륨의 내용을 초기화한 뒤, S3 무결성 검증과 정적 웹 게시를 다시 수행한다. DB·S3 원본·이미지 코드는 삭제하지 않는다. 이 두 경로를 PVC나 영구 데이터 경로로 바꾸면 안 된다. 재시작 중에는 readiness가 서비스 진입을 막는다.

환경별 overlay에서 다음을 설정한다.

1. `drivemate-runtime` 이미지를 실제 검증된 ECR `repository@sha256:digest`로 바꾼다. API, Nginx, init container 모두 같은 digest를 사용한다.
2. ConfigMap의 버킷·정확한 release/pointer key·SHA256·RDS 호스트를 지정한다. 원본 문서·모델·색인·키를 ConfigMap이나 이미지에 넣지 않는다.
3. 기존 비밀 관리 체계로 `drivemate-api-secrets`의 네 key를 공급한다. 저장소에는 `Secret` 값이나 생성 명령을 포함하지 않는다. master 비밀번호·초기 계정 비밀번호·bootstrap token은 공급하지 않는다.
4. `drivemate-api` ServiceAccount를 환경별 워크로드 IAM에 연결한다. EKS에서는 Pod Identity 또는 IRSA를 구성한다. API 권한은 ECS의 `ApiTaskRole`과 같은 정확한 S3 객체 읽기 및 `data/cycles/latest.json` prefix 확인만 필요하다. 이미지 pull은 클러스터의 kubelet/ECR 권한을 별도로 확인한다. 정적 AWS 키를 Pod에 넣지 않는다.
5. 기존 RDS 스키마·pgvector·소유자 등록이 끝난 상태에서 TLS 연결과 네트워크 접근을 허용한다. 이 Pod는 DB를 초기화하지 않는다. 네임스페이스 네트워크 정책은 선택한 CNI·DNS·Ingress 구성에 맞춰 추가한다.
6. 환경에 맞는 HTTPS Ingress/ALB를 연결한다. 기본 Service는 `ClusterIP`이고 외부 주소를 만들지 않는다. 실제 viewer Host/Authorization/WebSocket upgrade를 보존하고, 인증 응답을 캐시하지 않으며, 요청 제한시간은 CloudFront 120초/앱 worker 115초 계약에 맞춘다. Nginx는 신뢰한 HTTPS 입구 뒤에서만 사용한다.

설정 검토용 렌더링은 로컬에서만 실행할 수 있다.

```bash
kubectl kustomize infra/k8s/base
```

API/DB 준비 상태는 기존 healthcheck로 확인한다. Nginx는 정적 웹 게시와 API 준비가 끝날 때까지 기다린다. DB의 일시적인 장애가 불필요한 프로세스 재시작을 만들지 않도록 liveness는 로컬 포트 연결만 검사하고 readiness가 실제 API/DB 상태를 검사한다.

cycle는 이 base에 포함하지 않았다. 추후 별도 ServiceAccount와 `Job`으로 분리하고 SQS 소비·`data/cycles/*` 쓰기 권한만 부여해야 한다. 현재 `--once` 방식은 메시지가 없으면 20초 후 종료하므로 enqueue 순서와 작업 중복 방지부터 구성한다. Kubernetes에서 실제 실행·롤백·위치 중계가 검증됐다는 의미는 아니다.
