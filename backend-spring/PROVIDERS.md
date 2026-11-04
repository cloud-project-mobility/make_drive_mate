# 외부 서비스 연동 (Spring)

기존 `/api/v1` 계약을 Java 서비스로 구현했다. Python HTTP 프록시는 사용하지 않는다.

| 서비스 | 기본 예시 모드 | 실제 연결 경로 | 검증 범위 |
|---|---|---|---|
| Kakao | 직접 만든 장소 3곳·경로 2종 | Local 검색, Mobility 길찾기 | 고정 HTTPS 목적지, 좌표·거리·시간·응답 검증 테스트 |
| Google Calendar | 직접 만든 일정 3종 | 계정별 OAuth 후 읽기 전용 일정 조회 | PKCE, 1회 state, 암호화 저장, 만료·갱신·권한 오류·해제 테스트 |
| Hyundai | 직접 만든 차량 상태 | 아직 제공하지 않음 | 단위 변환, 원천 시각 미확인 표시, 누적거리 합산 금지 테스트 |

실제 Kakao 키 및 Google 계정 동의를 사용한 실연동 검증은 수행하지 않았다. 예시 결과는 항상 `source=mock`, `is_mock=true`이며 연결/실차 인증으로 표시하지 않는다. Hyundai는 live 모드에서도 설정 미완료 오류를 반환한다.

## 설정

기본 `DRIVEMATE_PROVIDER_MODE=mock`. `disconnected`에서는 제공자 호출을 차단한다. `live`에서만 다음 설정을 사용한다.

- `DRIVEMATE_KAKAO_REST_KEY`
- `DRIVEMATE_KAKAO_MOBILITY_KEY` (생략하면 REST 키 사용)
- `DRIVEMATE_GOOGLE_CLIENT_ID`
- `DRIVEMATE_GOOGLE_CLIENT_SECRET`
- `DRIVEMATE_GOOGLE_REDIRECT_URI` — 등록된 HTTPS callback 또는 로컬 개발 loopback HTTP callback
- `DRIVEMATE_TOKEN_ENCRYPTION_KEY` — 무작위 32바이트의 URL-safe Base64

키는 서버 환경으로 주입한다. 프런트·저장소에 넣지 않는다. 접근 토큰/갱신 토큰은 브라우저에 반환하지 않는다. Spring 토큰 저장은 AES-256-GCM이며 사용자 ID를 인증 부가 데이터로 결합한다. **기존 Python Fernet 암호문을 자동 이관하지 않는다. 기존 연결은 새 서버에서 다시 동의해야 한다.**

OAuth callback: `/api/v1/integrations/google/callback`. state는 해시로 보관하고 PKCE verifier도 암호화한다. 10분 만료·1회 소비·계정 소유권을 확인하며 연결 해제/새 동의가 진행 중 callback을 무효화한다. 액세스 토큰은 만료 60초 전 갱신한다. Calendar 401은 한 번만 갱신/재시도하며, 403은 갱신 근거로 쓰지 않는다. 연결 해제와 계정 삭제는 로컬 토큰을 지우고 가능한 경우 Google에 폐기를 요청한다.

HTTP는 목적지를 고정하고 리다이렉트를 따르지 않는다. 연결 5초, 응답 전체 10초, 본문 2MB를 제한한다. OAuth 토큰 응답은 추가로 128KB를 제한한다. 제공자 응답 본문·인증 헤더·토큰 포함 URL은 오류 로그에 넣지 않는다.

## 운영 경계

현재 토큰 갱신은 단일 애플리케이션 인스턴스 내 잠금과 DB revision 비교 갱신으로 보호한다. **여러 인스턴스로 수평 확장하기 전에는 DB 기반 갱신 임대/분산 잠금을 구현해야 한다.** 단일 인스턴스 배포를 기준으로 한다. Google consent 앱 검증·테스트 사용자·redirect URI 등록·할당량은 별도 제공자 설정이다.

일정은 90일 이내, offset 포함 시각만 받는다. 종일 일정의 끝 날짜는 exclusive로 유지한다. offset 없는 일정은 해당 경계에 명시된 시간대를 사용하고 DST 중복/누락 시각은 거절한다. 페이지 누락·반복 토큰·서로 다른 내용의 동일 event ID는 부분 성공으로 숨기지 않는다.

## 검사

```bash
./mvnw '-Dtest=ProviderTests,GoogleIntegrationTests' test
```

외부 네트워크를 호출하지 않는 고정 응답 테스트로 구현 계약을 검증한다. 이 테스트 결과는 실계정 연결 성공의 근거가 아니다.
