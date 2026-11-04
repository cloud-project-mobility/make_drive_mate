# 외부 서비스 연동 (Spring)

기존 `/api/v1` 계약을 Java 서비스로 구현했다. Python HTTP 프록시는 사용하지 않는다.

| 서비스 | 기본 예시 모드 | 실제 연결 경로 | 검증 범위 |
|---|---|---|---|
| Kakao | 직접 만든 장소 3곳·경로 2종 | Local 검색, Mobility 길찾기 | 고정 HTTPS 목적지, 좌표·거리·시간·응답 검증 테스트 |
| Google Calendar | 직접 만든 일정 3종 | 계정별 OAuth 후 읽기 전용 일정 조회 | PKCE, 1회 state, 암호화 저장, 만료·갱신·권한 오류·해제 테스트 |
| Hyundai | 직접 만든 차량 상태 | 아직 제공하지 않음 | 단위 변환, 원천 시각 미확인 표시, 누적거리 합산 금지 테스트 |

고정 응답 테스트는 실제 Kakao 호출이나 Google 계정 동의 성공의 근거가 아니다. 예시 결과는 항상 `source=mock`, `is_mock=true`이며 연결/실차 인증으로 표시하지 않는다. Hyundai는 live 모드에서도 설정 미완료 오류를 반환한다. 운영 연결 여부는 배포 후 실제 요청으로 따로 확인한다.

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

## Kakao: 서버 키 방식

장소 검색은 `https://dapi.kakao.com/v2/local/search/keyword.json`, 자동차 길찾기는 `https://apis-navi.kakaomobility.com/v1/directions`를 호출한다. 두 API 모두 `Authorization: KakaoAK ...` 헤더로 인증한다. 별도의 사용자 로그인·OAuth callback은 필요하지 않다. 브라우저 지도 SDK의 JavaScript 키는 서버 REST 키와 다른 설정이다. [Local 공식 규격](https://developers.kakao.com/docs/ko/local/dev-guide), [Mobility 공식 규격](https://developers.kakaomobility.com/guide/navi-api/directions)

`GET /api/v1/integrations`의 Kakao 항목은 `auth_type=api_key`, `requires_user_consent=false`다. `configured`는 서버 키의 존재·형식만 확인하며 API 권한 승인을 보증하지 않는다. `connected=false`는 개인 계정 OAuth를 연결하지 않는다는 뜻이다. `capabilities.places`와 `capabilities.routes`의 `live_verified`·`last_verified_at`은 현재 서버 프로세스에서 실제 응답의 검증까지 성공했을 때만 갱신한다. 고정 응답 테스트와 mock 호출은 포함하지 않는다. 해당 기능의 제공자 요청이 실패하면 검증 상태를 지우며, 서버 재시작 시에도 초기화한다. UI는 카카오를 “계정 연결 전”으로 표현하지 않는다.

## Hyundai: 실차 연결 준비 범위

현재 실차 어댑터는 미구현이다. 로컬 파일의 `HYUNDAI_CLIENT_ID`·`HYUNDAI_CLIENT_SECRET`만으로 실차를 조회하지 않는다. `/integrations`는 `auth_type=oauth_vehicle_consent`, `requires_user_consent=true`, live 모드의 `reason=implementation_pending`를 반환한다. Google OAuth와 현대 OAuth는 토큰을 공유하지 않는다.

2026-11-04 확인 시 개발 프로젝트에 활성화된 검증 차량이 없고, 이용 가능한 본인 명의 CCS 계약 차량도 없어 실차 OAuth·데이터 조회는 검증하지 못했다. 이번 운영 배포에는 사용하지 않는 현대 비밀값을 주입하지 않는다. 실차가 연결됐다고 표시하거나 예시 응답을 실제 데이터로 바꾸지 않는다.

공식 가이드상 개발 실차 시험은 본인 명의 Bluelink(CCS) 계약 차량을 콘솔에서 활성화해야 한다. 일반 고객 서비스는 상용화 승인과 별도 프로젝트가 필요하다. 이어서 고객 로그인·차량 접근 동의, 토큰 교환, 개인정보 제3자 제공 동의, 차량 목록의 `carId` 확인을 거친다. [공식 콘솔 가이드](https://developers.hyundai.com/web/v1/hyundai/guide_console), [API 활용 가이드](https://developers.hyundai.com/web/v1/hyundai/guide_api)

다음은 구현 시 사용할 **예정 경로**이며 현재 동작하는 callback이 아니다.

| 콘솔 설정 | 예정 경로 | 용도 |
|---|---|---|
| 계정 API Redirect URL | `/api/v1/integrations/hyundai/callback` | `code`·1회 state 검증과 서버 토큰 교환 |
| 데이터 API Redirect URL | `/api/v1/integrations/hyundai/consent/callback` | 제3자 동의 결과·별도 state 확인 |
| 데이터 API Callback URL | `/api/v1/integrations/hyundai/events` | 계정·차량 삭제 및 동의 철회 처리 |

계정 토큰은 `prd.kr-ccapi.hyundai.com/api/v1/user/oauth2/token`에 Basic 인증과 form POST로 교환한다. 제3자 동의는 `/api/v1/car-service/terms/agreement`에 별도로 form POST한다. 데이터 API 개발/상용 호스트를 콘솔과 맞춰야 하며 임의 호스트를 입력받지 않는다. 공개 철회 알림 규격에는 서명·인증 방법이 명시되어 있지 않아 운영 전 제공자 확인이 필요하다. [토큰 규격](https://developers.hyundai.com/web/v1/hyundai/specification/account/account_token), [동의 규격](https://developers.hyundai.com/web/v1/hyundai/specification/data/service_agreement), [철회 알림 규격](https://developers.hyundai.com/web/v1/hyundai/specification/data/partner_deletecallback)

동의 없이 차량 API를 호출하지 않는다. 누적거리는 절대값으로 취급하며 앱 주행거리와 합산하지 않는다. 원천 시각의 시간대를 알 수 없으면 최신 실차 상태로 단정하지 않는다.

## 운영 경계

현재 토큰 갱신은 단일 애플리케이션 인스턴스 내 잠금과 DB revision 비교 갱신으로 보호한다. **여러 인스턴스로 수평 확장하기 전에는 DB 기반 갱신 임대/분산 잠금을 구현해야 한다.** 단일 인스턴스 배포를 기준으로 한다. Google consent 앱 검증·테스트 사용자·redirect URI 등록·할당량은 별도 제공자 설정이다.

일정은 90일 이내, offset 포함 시각만 받는다. 종일 일정의 끝 날짜는 exclusive로 유지한다. offset 없는 일정은 해당 경계에 명시된 시간대를 사용하고 DST 중복/누락 시각은 거절한다. 페이지 누락·반복 토큰·서로 다른 내용의 동일 event ID는 부분 성공으로 숨기지 않는다.

## 검사

```bash
./mvnw '-Dtest=ProviderTests,GoogleIntegrationTests' test
```

외부 네트워크를 호출하지 않는 고정 응답 테스트로 구현 계약을 검증한다. 이 테스트 결과는 실계정 연결 성공의 근거가 아니다.
