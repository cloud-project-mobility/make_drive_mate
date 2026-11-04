# 같은 계정의 실시간 위치 연결

현재 브라우저의 위치를 같은 계정으로 접속한 다른 화면에 전달한다. 차량의 원격 위치 조회가 아니다. 위치 권한과 전송 시작은 화면의 명시적인 사용자 동작으로 요청하며, 수신만 하는 화면은 위치 권한이 필요 없다.

## 연결 계약

1. 로그인 후 `POST /api/v1/location/ticket`을 Bearer 인증으로 호출한다. 브라우저의 `Origin`도 필요하다. 응답은 `{ticket, expires_at}`이다.
2. 같은 서버의 `/api/v1/location/stream`에 WebSocket을 연다. HTTPS 페이지는 `wss:`를 사용한다. 브라우저 생성자의 protocols 값은 `['drivemate.location.v1', 'ticket.' + ticket]`이다. 서버는 고정된 `drivemate.location.v1`만 응답한다.
3. 서버의 `{type: 'ready', source_id}`를 받은 뒤 송신한다. 연결에 사용한 인증표는 30초·1회용이며 계정, 로그인 세션, 발급 Origin에 묶인다. 재연결할 때 새 인증표를 발급한다. URL query에 인증 정보를 넣으면 연결을 거부한다.

메시지는 JSON 텍스트이며 다음 형식만 허용한다.

| 방향 | 형식 |
|---|---|
| 전송 | `{type: 'position', latitude, longitude, accuracy_m, observed_at}` |
| 전송 중지 | `{type: 'stop'}` |
| 위치 수신 | `{type: 'position', source_id, latitude, longitude, accuracy_m, observed_at, received_at}` |
| 위치 삭제 | `{type: 'stopped', source_id}` |

관측 시각은 ISO 8601이다. 위도 −90~90, 경도 −180~180, 정확도 0~10,000m, 관측 시각은 현재 기준 과거 2분~미래 30초 범위여야 한다. 추가 필드·중복 JSON 키·잘못된 좌표를 거부한다. 메시지는 최대 1KiB, 연결별 1초 구간당 최대 2개다. 화면은 초당 1개 이하로 보내고 위치 수집 중지·권한 거부·백그라운드 전환·오프라인을 구분해 표시한다.

송신 연결에는 자신의 좌표를 반향하지 않는다. 같은 계정의 다른 연결만 수신하며, 새 연결에는 유효한 최신 위치를 전달한다. 계정당 최대 3개 연결, 서버 전체는 최대 100개 연결이다. 인증표 발급은 계정별 분당 10회로 제한한다.

## 정리와 저장 범위

이 중계 경로는 좌표를 데이터베이스·파일·로그에 저장하지 않는다. 연결당 최신 위치 하나만 메모리에 두며 유효기간은 30초다. 만료된 값은 새 연결에 전달하지 않고 최대 5초 주기의 정리 작업에서 삭제하며 `stopped`를 보낸다. 중지·연결 종료에는 즉시 삭제한다. 인증표는 메모리에 해시만 보관한다. 기존 주행 기록 기능의 사용자 저장과는 별도다.

로그아웃은 해당 로그인 세션의 인증표와 연결을 종료하고, 계정 삭제는 해당 계정의 모든 연결을 종료한다. 연결 시 세션을 다시 확인하며 20초 heartbeat에서 서버 세션을 재검증한다. 60초 동안 pong이 없으면 종료한다. 세션 종료 코드는 4401, 잘못된 메시지·송신 제한 위반은 1008, 크기 초과는 1009, 연결 수 초과는 1013이다. 브라우저는 handshake 거부의 상세 HTTP 상태를 노출하지 않을 수 있으므로 연결 실패를 성공으로 표시하지 않는다.

## 운영 경로

Spring의 `/api/v1/location/stream` 앞에서 Nginx가 HTTP/1.1의 `Upgrade`와 `Connection` 헤더를 전달해야 한다. CloudFront는 `AllViewer`와 `CachingDisabled` 정책을 사용한다. Spring은 loopback에 바인딩하고, Nginx가 전달 헤더를 덮어쓰는 신뢰 경계에서만 `server.forward-headers-strategy=framework`를 사용한다.

Origin이 없거나 `null`이면 거부한다. 신뢰된 요청의 same-origin과 `DRIVEMATE_CORS_ORIGINS`의 명시적인 로컬 개발 Origin만 허용한다. Origin 검증은 인증을 대체하지 않는다. 운영 요청 경로에 좌표·인증표를 넣지 않으며 접근 로그에도 헤더나 메시지 본문을 추가하지 않는다.

단일 EC2 프로세스 내 중계이므로 재시작하면 좌표와 연결이 사라진다. 여러 서버로 확장하기 전에는 계정별 라우팅과 공유 중계 방식을 별도로 설계해야 한다. 현재 구현에는 Redis나 위치 이력 저장소가 없다.

## 검증

`LocationWebSocketTest`는 실제 임시 포트의 Tomcat WebSocket으로 계정 격리, 인증표 재사용·만료·Origin·query 차단, 로그아웃·계정 삭제, 크기·좌표·송신 제한, TTL·연결 수 제한, 서버 세션 만료와 운영 전달 헤더를 검사한다. `LocationOriginTest`는 로컬·same-origin 허용과 변형된 Origin 거부를 검사한다. 실제 AWS WSS와 브라우저 위치 권한 검증은 배포 후 별도로 확인한다.
