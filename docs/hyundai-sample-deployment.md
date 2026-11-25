# 현대 Sample 설정과 배포

이번 경로는 현대 Sample Test의 누적거리 응답을 조회한다. `HYUNDAI_CLIENT_ID`와
`HYUNDAI_CLIENT_SECRET`은 이 Sample Bearer 요청에 사용하지 않는다.

## 운영 설정

1. 현대 콘솔 Sample Test가 제공한 유효한 토큰과 샘플 차량 ID를 준비한다.
2. AWS Secrets Manager JSON 비밀에 다음 두 필드를 저장한다. 값은 채팅·Git·이미지에 넣지 않는다.
   - `HYUNDAI_SAMPLE_TOKEN`: `Bearer ` 접두어를 제외한 Sample 토큰
   - `HYUNDAI_SAMPLE_CAR_ID`: 콘솔에서 제공한 샘플 차량 UUID
3. ECS **execution role**에 해당 비밀 ARN의 `secretsmanager:GetSecretValue`를 허용한다.
   사용자 관리 KMS 키를 사용한다면 해당 키의 `kms:Decrypt` 권한도 필요하다.
   기존 AppSecretArn에 두 JSON 필드를 추가하면 기존 execution role의 해당 ARN 권한을 활용할 수 있다.
4. GitHub Actions Repository Variables를 설정한다.

| 변수 | 값 |
|---|---|
| `DRIVEMATE_HYUNDAI_SAMPLE_ENABLED` | `true` |
| `HYUNDAI_SAMPLE_SECRET_ARN` | 2번 비밀의 전체 ARN. JSON 키 접미사는 넣지 않음 |

배포는 API 컨테이너의 ECS `secrets`에 두 JSON 키 참조를 추가한다. 토큰과 차량 ID의 평문은
GitHub Actions, 컨테이너 이미지, task definition의 `environment`에 넣지 않는다.
서버 프로세스 시작 시 ECS가 비밀을 환경변수로 주입한다. nginx 컨테이너에는 전달하지 않는다.
전역 `DRIVEMATE_PROVIDER_MODE`와 Kakao/Google 설정은 유지한다.

두 배포 변수가 모두 비어 있으면 현재 task 설정을 유지한다. `true`와 유효한 ARN을 함께 지정해야
새 설정이 적용된다. 끄려면 `DRIVEMATE_HYUNDAI_SAMPLE_ENABLED=false`로 바꾸고 ARN 변수를 비운다.
이 경우 API 컨테이너에서 두 샘플 secret 참조도 제거한다. 설정만 바뀌어도 새 task revision이 배포된다.

Fargate Linux platform 1.4.0 이상과 Secrets Manager에 접근할 수 있는 네트워크가 필요하다.
이미 실행 중인 task는 비밀을 자동 갱신하지 않는다. 토큰 값만 교체한 경우 같은 이미지·같은 ARN으로
배포를 다시 실행하면 `already_deployed`가 될 수 있으므로 별도로 새 task 배포를 수행해야 한다.

현재 변경은 배포 코드 준비이며 AWS 비밀 생성, IAM 변경, 실제 task 배포 또는 현대 호출 성공을
의미하지 않는다. 기존 GitHub Client ID/Secret만 등록한 상태에서는 Sample 요청을 실행할 수 없다.

공식 ECS 주입 규격:
https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html
