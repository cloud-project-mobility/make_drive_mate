# 웹 실시간 위치

이동 계획 화면에서 같은 계정의 다른 기기 위치를 확인합니다. 연결과 내 위치 전송은 각각 사용자가 시작합니다. 브라우저의 위치 권한을 거부하면 전송하지 않습니다. 로그아웃·연결 종료 시에는 해당 연결을 정리합니다. 이 기능은 접속한 기기의 위치를 사용하며 현대 차량 텔레매틱스 연동이 아닙니다.

## 동작 범위

- 로그인한 같은 계정만 위치를 주고받습니다. 타 계정 공유·공개 추적 링크는 없습니다.
- 서버는 최근 좌표를 메모리에만 유지하고 30초가 지나면 만료시킵니다. 위치 이력·좌표를 DB나 요청 로그에 저장하지 않습니다.
- 한 계정의 동시 연결은 최대 3개입니다. 현재 한 대의 Spring 서버 구성이며 서버를 재시작하면 위치 상태가 사라집니다.
- 화면을 닫거나 브라우저가 백그라운드 실행을 제한하면 지속적인 추적을 보장하지 않습니다. 재연결 상태를 확인하고 필요하면 다시 시작합니다.
- 주행 기록은 별도 기능입니다. 실시간 위치 수신만으로 차량 주행거리나 백업에 기록을 추가하지 않습니다.

## 연결 계약

1. 기존 Bearer 로그인으로 `POST /api/v1/location/ticket`을 호출해 30초 수명의 1회용 티켓을 발급받습니다.
2. 같은 API 주소의 `/api/v1/location/stream`에 WebSocket을 연결합니다. HTTPS 웹은 `wss`를 사용합니다.
3. `Sec-WebSocket-Protocol`에 `drivemate.location.v1`, `ticket.<발급값>`을 전달합니다. 장기 로그인 토큰과 티켓을 URL에 넣지 않습니다. 서버는 고정 프로토콜만 응답합니다.
4. Origin과 로그인 세션을 검증한 연결만 `ready`를 받은 뒤 위치를 주고받습니다. 만료·재사용 티켓, 다른 Origin, 잘못된 좌표·과도한 요청은 거부합니다.

카카오 지도는 사용자가 지도 연결을 선택한 뒤에만 SDK를 불러옵니다. 지도 연결 시 표시할 좌표가 카카오 지도 서비스에 전달될 수 있습니다. 공개 JavaScript 키·허용 도메인 설정과 연결 실패 처리는 [웹 지도 안내](LIVE-MAP.md)를 따릅니다.

## 운영 설정

Nginx는 `/api/v1/location/stream`의 HTTP/1.1 `Upgrade`와 `Connection`을 Spring으로 전달합니다. CloudFront는 캐시 비활성화·AllViewer 정책을 유지합니다. 현재 VPC origin의 WebSocket 지원은 [AWS 공식 발표](https://aws.amazon.com/about-aws/whats-new/2026/05/amazon-cloudfront-websockets-vpc-origins/)와 [헤더 전달 안내](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.websockets.html)를 기준으로 합니다.

검증에는 합성 위치만 사용합니다. 계정 간 격리, 티켓 재사용·만료, Origin, 로그아웃, 위치 만료, 권한 거부와 중지를 확인합니다. 실제 휴대전화의 GPS 정확도·백그라운드 실행은 별도 실기기 검증 대상입니다.
