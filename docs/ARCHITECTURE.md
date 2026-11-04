# DriveMate 서비스와 배포 흐름

이 그림은 구현된 코드와 배포 설정의 구조다. 실제 클라우드 가동·CI/CD 활성화 여부는 [인수 메모](DELIVERY-NOTES.md)의 확인표를 기준으로 한다.

```mermaid
flowchart LR
    Browser[웹 브라우저] -->|HTTPS| CDN[CloudFront]
    subgraph EC2[EC2 앱 서버]
        Web[Nginx: 웹 화면과 API 연결]
        API[Spring: 로그인·차량·분석·문서 권한]
        ML[Python: 가격 모델·근거 설명]
        RAG[Python: 문서 검색·출처 선택]
        Worker[데이터 갱신 작업자]
        Web --> API
        API --> ML
        API --> RAG
    end
    CDN -->|비공개 VPC 원본| Web
    API --> DB[(비공개 RDS PostgreSQL)]
    RAG -->|벡터 검색| Vectors[(RDS pgvector)]
    ML -->|요청 시 설명| OpenAI[OpenAI API]
    RAG -->|질문 임베딩·선택적 설명| OpenAI
    Timer[주간 실행 설정] --> Queue[SQS 작업 큐]
    Queue --> Worker
    Worker --> Onbid[온비드 API]
    Worker --> S3[(S3 원본·정제·평가·차트)]
    Worker -->|로컬 최신 성공 결과| API
```

Nginx는 EC2 안에서 실행되는 웹 서버다. Spring은 계정과 차량 정보를 처리하고, 가격 모델 및 문서 검색은 같은 EC2의 제한된 Python 작업으로 실행한다. pgvector는 별도 서버가 아니라 RDS PostgreSQL에 설치하는 벡터 검색 기능이다. 작업자는 분석 파일을 S3에 모두 보관한 다음 로컬 최신 성공 결과를 갱신하고, Spring은 그 결과를 읽는다.

```mermaid
flowchart LR
    Register[차량 정보 등록] --> Validate[입력·학습 범위 확인]
    Validate -->|지원 범위| Price[현재 공매 가격과 참고 범위]
    Validate -->|미학습·범위 밖| Defer[가격 판단 유보]
    Price --> Scenario[6·12개월 차령·주행거리 시나리오]
    Scenario --> Costs[보유비용 가정을 함께 비교]
    Costs --> Evidence[수치·비교 사례·주의점 설명]
    Question[프로젝트 문서 질문] --> Access[허용 계정 확인]
    Access --> Hybrid[벡터 검색 + 단어 검색]
    Hybrid --> Sources[출처와 원문 인용·근거 없으면 유보]
```

예측의 기준은 공매 낙찰가다. 미래 값은 시장 조건을 고정하고 차령과 주행거리를 바꾸는 시나리오이며, 미래 소비자 시세를 검증한 결과는 아니다. 문서 검색은 가격 계산을 대체하지 않는다.

```mermaid
flowchart LR
    Code[GitHub main 변경] --> CI[웹·Spring·Python 자동 검사]
    CI -->|통과| Package[코드 배포 파일·해시 생성]
    Package --> Button[배포 실행 버튼]
    Button --> OIDC[일회성 AWS 인증]
    OIDC --> Store[비공개 S3에 코드 업로드]
    Store --> SSM[고정된 SSM 배포 명령]
    SSM --> Replace[EC2 코드 교체·서버 재시작]
    Replace --> Health{정상 응답?}
    Health -->|예| Done[배포 완료]
    Health -->|아니오| Rollback[기존 코드로 복구]
```

배포는 승인된 main 검사 결과를 지정해서 실행한다. API 키·개인 문서·학습 데이터·모델은 코드 배포 파일에 넣지 않는다. 코드 교체 때 짧은 중단이 있으며, 의존성 변경과 데이터베이스 구조 변경은 별도 검증이 필요하다.

무료 플랜 유지 요청에 따라 RDS는 단일 서버와 1일 백업으로 구성한다. 다중 가용 영역 자동 전환 구성은 아니다. 주간 실행은 운영 환경에서 첫 데이터 갱신을 검증한 후 활성화한다.
