# ECS 주기 작업 스케줄

`ecs-cycle-schedule.json`은 앱 서비스와 분리된 선택적 스택이다. 기본 `EnableSchedule=DISABLED`이며 이 파일 작성 과정에서 AWS 배포나 활성화는 실행하지 않았다. 기존 주간 SQS 메시지 생성 규칙과 큐를 변경하지 않는다.

실제 `cycle` task가 승인된 데이터로 성공하고 집계·S3 완료 마커·SQS 삭제가 확인된 뒤, 운영 담당자가 이 스케줄과 기존 주간 enqueue 규칙을 각각 활성화한다. 주간 규칙은 일요일 17:00 UTC(월요일 02:00 KST)에 메시지를 넣고, 새 규칙은 매시 05분 UTC/KST에 한 작업을 실행한다. 첫 정기 소비 예상 시점은 월요일 02:05 KST다. 실제 시작은 스케줄/용량 지연이 있을 수 있다.

입력은 ECS stack의 `ClusterArn`, 정확한 revision을 포함한 `CycleTaskDefinitionArn`, `ExecutionRoleArn`, `CycleTaskRoleArn`, `TaskSubnetIds`, `TaskSecurityGroupId`와 고유 `RuleName`이다. 잘못된 cycle revision을 API CI가 자동 교체하지 않는다. cycle 이미지를 갱신한 경우 검증된 새 revision으로 이 스택의 파라미터도 명시적으로 갱신해야 한다.

실행 역할은 이 규칙의 정확한 ARN/계정만 신뢰한다. 권한은 지정한 cluster에서 지정한 task revision을 실행하고 두 기존 역할을 넘기는 것뿐이다. 비밀값이나 데이터를 읽는 권한은 없다. task는 기존 비공개 진입 제한을 유지하고 public IP를 외부 HTTPS 호출에만 사용한다. 빈 큐는 20초 long poll 뒤 종료하며 상시 worker 서비스는 만들지 않는다.

EventBridge의 최대 event age 3600초/재시도 2회는 **RunTask 호출 전달 실패**에 대한 제한이다. 이미 시작한 컨테이너의 처리 실패를 두 번 재실행한다는 뜻은 아니다. `FailedInvocations` alarm도 전달 재시도 소진만 감지한다. 알람 동작과 SNS 연결을 넣지 않았으므로 콘솔에서만 보인다. 이 구분은 [EventBridge 모니터링 문서](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-monitoring-events-best-practices.html)에 따른다.

작업 처리 중 SQS visibility는 900초이며 heartbeat가 갱신한다. 작업이 실패하면 메시지를 삭제하지 않고, 마지막 갱신의 visibility가 끝난 뒤 다음 시간대 task가 다시 받을 수 있다. 기존 redrive `maxReceiveCount=3`을 넘기는 메시지는 DLQ로 이동한다. 복구는 최대 약 한 시간 이상 늦을 수 있으며, 전체 작업 제한 1800초·잔여 API 호출 예산·완료 마커 검증을 그대로 유지한다. Fargate의 임시 파일은 다음 task에 남지 않아 로컬 raw 재사용은 보장하지 않는다.

정규 실행 간격은 한 시간이고 작업 제한은 30분이다. 그래도 지연된 전달 재시도나 수동 RunTask는 겹칠 수 있다. SQS visibility는 같은 메시지의 동시 수신을 줄이지만 분산 전역 잠금은 아니다. 운영자는 수동 작업과 중복 스케줄을 겹쳐 시작하지 않고, 예약 활성화 전에 중복 실행 검증을 해야 한다. 이 스택은 메시지를 생성하지 않으므로 worker 전달 실패 시 기존 업무 메시지가 유실되지는 않는다.

비용 계획은 task 실행 시간으로 계산한다. 30일 동안 720회 실행되고 매번 이미지 준비·시작·20초 poll·종료까지 1~2분 걸린다고 가정하면 월 12~24 task-hour다. 1 vCPU/3 GiB의 합산 단가를 예산 계산용으로 시간당 약 USD 0.064로 놓으면 빈 큐 확인의 compute는 약 USD 0.77~1.54다. 이는 실제 청구 견적이 아니며 초기화가 더 오래 걸리면 증가한다. 실제 수집/학습 실행 시간, public IPv4, 로그·알람·S3 요청 비용도 별도로 더해진다. Fargate는 이미지 다운로드부터 종료까지 사용량을 계산하고 Linux의 최소 청구 시간은 1분이다. [공식 Fargate 과금 기준](https://aws.amazon.com/fargate/pricing/)

빈 큐 비용을 더 낮추려면 다음 개선에서 `cycle` 시작 전 모델/원본 ZIP 다운로드를 생략할 수 있는지 검증한다. 현재 worker는 이미지의 pipeline으로 새 자료를 수집하므로 빈 큐 확인에 모델 파일은 필요하지 않다. 이 최적화는 현재 검증된 런타임과 서비스 이미지를 변경하지 않기 위해 별도 후속 작업으로 남긴다.
