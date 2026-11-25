# 공식 API 목록과 검증 범위

조회일: 2026-11-25. 공식 HTML 메뉴에서 링크를 추출해 공개 규격 19개를 실제 HTTP 200으로 읽었습니다.
**사용자가 제공한 DriveMate 콘솔 승인 목록 19개를 공개 규격 식별자와 대조해 19/19가 일치함을 확인했습니다.** 아래 표는 콘솔 순서입니다.
문서 API는 본문의 prd 호스트를 newDomain으로 치환해 화면에 표시합니다. 아래 주소는 그 렌더링 규칙을 반영했습니다.
비로그인 공개 규격 JSON에는 sampleTestYn이 없습니다. 로그인한 DriveMate 콘솔에서 차량 상태 4개, 경고등 7개, 커넥티드 서비스 가입일/무료 종료일에 테스트 표시를 확인했습니다. 누적거리는 공식 cURL과 실제 응답까지 확인했습니다. [누적거리 콘솔](https://console.developers.hyundai.com/web/v1/project/detail/1992/prod/specification/data/status_odometer) · [경고등 콘솔](https://console.developers.hyundai.com/web/v1/project/detail/1992/prod/specification/data/statuswarning_lowfuellight) · [차량 데이터 콘솔](https://console.developers.hyundai.com/web/v1/project/detail/1992/prod/specification/data/carprofile_carlist)
과거 공개 Sample 설정 GET은 404입니다. 이것만으로 전체 Sample 폐지나 미지원을 단정하지 않습니다.

## DriveMate 우선 항목 11개

아래 모두 GET, Authorization: Bearer 사용자 접근 토큰입니다. 차량별 데이터에는 carId 경로 인자가 필수이고 carlist에는 별도 경로/쿼리 인자가 없습니다.
시각이 있는 필드는 차량 전송시각이며 시간대는 명시 확인되지 않았습니다. 모든 성공 응답은 msgId를 검사합니다.

| 항목 / 공식 문서 | 현재 데이터 API 요청 경로 | 필수 파라미터 | 응답·단위·시각 의미 | 현재 Sample 지원 / 구현 |
|---|---|---|---|---|
| [내 차량 리스트 조회](https://developers.hyundai.com/web/v1/hyundai/specification/data/carprofile_carlist) | `GET /api/v1/car/profile/carlist` | 없음 | cars 내 carId, carNickname, carType(GN/EV/HEV/PHEV/FCEV), carName, carSellname; msgId. 거리 단위·관측시각 없음. | 현재 콘솔에 Sample 버튼 없음. 외부 Sample 경로 미확인 |
| [누적 운행 거리 조회](https://developers.hyundai.com/web/v1/hyundai/specification/data/status_odometer) | `GET /api/v1/car/status/:carId/odometer` | carId | odometers[]: date(조회일 YYYYMMDD), timestamp(차량 전송 YYYYMMDDHHmmSS), value(소수점 절사 설명), unit; msgId. 시동 종료 기준. | 콘솔 Sample Test·cURL 확인. 외부 Python 실제 HTTP 403 |
| [주행 가능 거리 조회](https://developers.hyundai.com/web/v1/hyundai/specification/data/status_dte) | `GET /api/v1/car/status/:carId/dte` | carId | value, unit, timestamp(차량 전송), msgId; 선택 phevTotalValue/phevTotalUnit. 시동 종료 기준, 2개월 미운행 조회 불가. | 콘솔 테스트 표시 확인. 누적거리 실패로 미호출 |
| [엔진 오일 경고등 상태 조회](https://developers.hyundai.com/web/v1/hyundai/specification/data/statuswarning_engineoil) | `GET /api/v1/car/status/warning/:carId/engineOil` | carId | status(boolean), msgId. 시동/EV·PHEV 충전 종료 기준. 오일 잔량·수명 수치 아님. | 콘솔 테스트 표시 확인. 누적거리 실패로 미호출 |
| [타이어 공기압 경고등 상태 조회](https://developers.hyundai.com/web/v1/hyundai/specification/data/statuswarning_tirepressurelamp) | `GET /api/v1/car/status/warning/:carId/tirePressure` | carId | status(boolean), msgId. 시동/EV·PHEV 충전 종료 기준. 타이어별 압력 수치 아님. | 콘솔 테스트 표시 확인. 누적거리 실패로 미호출 |
| [브레이크 오일 경고등 상태 조회](https://developers.hyundai.com/web/v1/hyundai/specification/data/statuswarning_breakoil) | `GET /api/v1/car/status/warning/:carId/breakOil` | carId | status(boolean), msgId. 시동/EV·PHEV 충전 종료 기준. 실제 오일 양 아님. | 콘솔 테스트 표시 확인. 누적거리 실패로 미호출 |
| [주유 경고등 상태 조회](https://developers.hyundai.com/web/v1/hyundai/specification/data/statuswarning_lowfuellight) | `GET /api/v1/car/status/warning/:carId/lowFuel` | carId | status(boolean), msgId. 시동 종료 기준. 연료량 리터 아님. | 콘솔 테스트 표시 확인. 누적거리 실패로 미호출 |
| [워셔액 경고등 상태 조회](https://developers.hyundai.com/web/v1/hyundai/specification/data/statuswarning_washerfluid) | `GET /api/v1/car/status/warning/:carId/washerFluid` | carId | status(boolean), msgId. 시동/EV·PHEV 충전 종료 기준. | 콘솔 테스트 표시 확인. 누적거리 실패로 미호출 |
| [스마트키 배터리 상태 조회](https://developers.hyundai.com/web/v1/hyundai/specification/data/statuswarning_smartkeybattery) | `GET /api/v1/car/status/warning/:carId/smartKeyBattery` | carId | status(boolean), msgId. 시동/EV·PHEV 충전 종료 기준. true 전압 경고, 잔량 % 아님. | 콘솔 테스트 표시 확인. 누적거리 실패로 미호출 |
| [전기차 배터리 잔량 조회](https://developers.hyundai.com/web/v1/hyundai/specification/data/status_evbattery) | `GET /api/v1/car/status/:carId/ev/battery` | carId | soc(%), timestamp(차량 전송), msgId. SOC이며 SOH 아님. 상세 갱신 간격 미확인. | 콘솔 테스트 표시 확인. 누적거리 실패로 미호출 |
| [전기차 충전 상태 조회](https://developers.hyundai.com/web/v1/hyundai/specification/data/status_evcharging) | `GET /api/v1/car/status/:carId/ev/charging` | carId | batteryPlugin(0 미연결/1 급속/2 일반), batteryCharge(boolean), soc(%), remainTime.value/unit, timestamp, msgId. 선택 targetSOC.plugType/targetSOClevel. | 콘솔 테스트 표시 확인. 누적거리 실패로 미호출 |

데이터 조회 기본 호스트: `https://dev.kr-ccapi.hyundai.com`. 위 표의 `/api/v1/`는 실차/개발 데이터 API 규격이며 Sample 호출 성공을 뜻하지 않습니다.
거리 unit은 0 feet, 1 km, 2 meter, 3 miles입니다. 충전 remainTime.unit은 0 hour, 1 min, 2 msec, 3 sec입니다.
명세의 누적거리 필드 표는 `odometers`를 object로 기재하고 예시 JSON은 배열로 제시합니다. 클라이언트는 예시의 비어 있지 않은 배열을 검증합니다. 공식 성공 응답의 형태는 미확인입니다.
경고등 6종에는 관측시각 필드가 없어 공급자 시각을 None으로 둡니다. false는 해당 경고가 없다는 뜻만 갖습니다.
EV targetSOC.plugType은 0 DC, 1 240V AC, 2 120V AC로 batteryPlugin과 다른 코드입니다.
remainTime은 연결 시 잔여 충전시간, 미연결 시 240V 충전 가정 시간입니다. 시간값만으로 충전 중이라 판단하지 않습니다.

## 인증·동의·접근 수명주기 (데이터 조회와 분리)

| 항목 | 메서드·주소 | 인증·주요 입력 / 역할 |
|---|---|---|
| [로그인 인증 요청](https://developers.hyundai.com/web/v1/hyundai/specification/account/account_authorize) | `GET https://prd.kr-ccapi.hyundai.com/api/v1/user/oauth2/authorize` | response_type=code, client_id, redirect_uri, state. 브라우저 로그인/차량 접근 승인 후 code·state 반환. |
| [사용자 토큰 발급/갱신/삭제 요청](https://developers.hyundai.com/web/v1/hyundai/specification/account/account_token) | `POST https://prd.kr-ccapi.hyundai.com/api/v1/user/oauth2/token` | HTTP Basic Client ID:Secret, form-urlencoded. grant_type에 따라 code+redirect_uri / refresh_token / access_token. 발급·갱신·삭제를 하나의 규격에서 설명. 개인 access token 24시간, refresh token 1년; Sample 정책으로 전용 금지. |
| [사용자 정보 조회](https://developers.hyundai.com/web/v1/hyundai/specification/account/account_profile) | `GET https://prd.kr-ccapi.hyundai.com/api/v1/user/profile` | Bearer 사용자 토큰. 계정 프로필 조회이며 차량 상태 API 아님. |
| [개인정보 제공 동의 요청](https://developers.hyundai.com/web/v1/hyundai/specification/data/service_agreement) | `POST https://dev.kr-ccapi.hyundai.com/api/v1/car-service/terms/agreement` | form-urlencoded token(Bearer 값), state. 개인정보 제3자 제공 동의 페이지/redirect. |
| [개인정보 제공 철회 요청](https://developers.hyundai.com/web/v1/hyundai/specification/data/service_termreject) | `GET https://dev.kr-ccapi.hyundai.com/api/v1/car-service/terms/reject` | Bearer 사용자 토큰. 미동의 전환 정보를 업데이트하는 요청. GET이어도 상태 변경이므로 본 실험에서 호출하지 않음. |
| [데이터 조회 불가 상태 알림](https://developers.hyundai.com/web/v1/hyundai/specification/data/partner_deletecallback) | `POST https://callback_url` | 현대 → 서비스 등록 callback_url POST. 사용자/차량 조회 불가 통지. 데이터 조회용 호출 URL 아님. |

로그인 응답은 redirect에 담긴 `code`와 `state`입니다. 토큰 발급 응답은 `access_token`, 선택 필드 `refresh_token`, `token_type`, `expires_in`(초)입니다. 프로필 GET은 별도 파라미터 없이 `id`, `email`, `name`, `mobileNum`, `birthdate`, `lang`, `social`을 반환합니다. 생년월일은 계정 속성입니다. 개인정보 제공 동의 redirect에는 `userId`와 `state`가 있고 철회 응답에는 `msgId`가 있습니다. 알림 콜백의 본문에는 `type`(account/vehicle/agreement), `action`(delete/reject)과 선택적인 `userId`, `carId`, 권한이 있는 서비스의 `vin`이 있습니다. 콜백의 발신 인증·서명 검증 방식은 확인이 필요합니다. 이 여섯 규격에 대한 콘솔 Sample 지원은 미확인이며 차량 관측시각과 거리 단위는 해당하지 않습니다.

### 우선순위 밖의 승인 차량 조회 두 건

| 공식 문서 | 메서드·일반 경로 | 인증·필수 입력 | 응답·시각과 단위 | Sample |
|---|---|---|---|---|
| [커넥티드 서비스 가입일/무료 종료일](https://developers.hyundai.com/web/v1/hyundai/specification/data/carprofile_contract) | `GET /api/v1/car/profile/:carId/contract` | Bearer 사용자 토큰, 경로 carId | `subscribeDate` 가입일, 선택 `endDate` 무료 종료일, `msgId`. 날짜는 YYYYMMDD | 콘솔 테스트 표시 확인. 외부 미호출 |
| [Lamp wire 경고등](https://developers.hyundai.com/web/v1/hyundai/specification/data/statuswarning_lampwire) | `GET /api/v1/car/status/warning/:carId/lampWire` | Bearer 사용자 토큰, 경로 carId | `status` 경고등 boolean, `msgId`. 시동 종료 또는 EV/PHEV 충전 종료 기준, 관측시각 필드 없음 | 콘솔 테스트 표시 확인. 외부 미호출 |

개인 인증/동의/철회/콜백은 구현·실행하지 않았습니다. Sample 조회에 Client Secret을 전송하지 않습니다.

## 현재 공개 문서 전체 19개

| 번호 | 공식 항목 | 구분 | 메서드·요청 경로 | 프로젝트 승인 |
|---|---|---|---|---|
| 1 | [로그인 인증 요청](https://developers.hyundai.com/web/v1/hyundai/specification/account/account_authorize) | 인증·동의·접근 | `GET https://prd.kr-ccapi.hyundai.com/api/v1/user/oauth2/authorize` | 승인 |
| 2 | [사용자 토큰 발급/갱신/삭제 요청](https://developers.hyundai.com/web/v1/hyundai/specification/account/account_token) | 인증·동의·접근 | `POST https://prd.kr-ccapi.hyundai.com/api/v1/user/oauth2/token` | 승인 |
| 3 | [사용자 정보 조회](https://developers.hyundai.com/web/v1/hyundai/specification/account/account_profile) | 인증·동의·접근 | `GET https://prd.kr-ccapi.hyundai.com/api/v1/user/profile` | 승인 |
| 4 | [개인정보 제공 동의 요청](https://developers.hyundai.com/web/v1/hyundai/specification/data/service_agreement) | 인증·동의·접근 | `POST https://dev.kr-ccapi.hyundai.com/api/v1/car-service/terms/agreement` | 승인 |
| 5 | [개인정보 제공 철회 요청](https://developers.hyundai.com/web/v1/hyundai/specification/data/service_termreject) | 인증·동의·접근 | `GET https://dev.kr-ccapi.hyundai.com/api/v1/car-service/terms/reject` | 승인 |
| 6 | [내 차량 리스트 조회](https://developers.hyundai.com/web/v1/hyundai/specification/data/carprofile_carlist) | 차량 데이터 | `GET https://dev.kr-ccapi.hyundai.com/api/v1/car/profile/carlist` | 승인 |
| 7 | [커넥티드 서비스 가입일/무료 종료일 조회](https://developers.hyundai.com/web/v1/hyundai/specification/data/carprofile_contract) | 차량 데이터 | `GET https://dev.kr-ccapi.hyundai.com/api/v1/car/profile/:carId/contract` | 승인 |
| 8 | [주행 가능 거리 조회](https://developers.hyundai.com/web/v1/hyundai/specification/data/status_dte) | 차량 데이터 | `GET https://dev.kr-ccapi.hyundai.com/api/v1/car/status/:carId/dte` | 승인 |
| 9 | [누적 운행 거리 조회](https://developers.hyundai.com/web/v1/hyundai/specification/data/status_odometer) | 차량 데이터 | `GET https://dev.kr-ccapi.hyundai.com/api/v1/car/status/:carId/odometer` | 승인 |
| 10 | [전기차 충전 상태 조회](https://developers.hyundai.com/web/v1/hyundai/specification/data/status_evcharging) | 차량 데이터 | `GET https://dev.kr-ccapi.hyundai.com/api/v1/car/status/:carId/ev/charging` | 승인 |
| 11 | [전기차 배터리 잔량 조회](https://developers.hyundai.com/web/v1/hyundai/specification/data/status_evbattery) | 차량 데이터 | `GET https://dev.kr-ccapi.hyundai.com/api/v1/car/status/:carId/ev/battery` | 승인 |
| 12 | [주유 경고등 상태 조회](https://developers.hyundai.com/web/v1/hyundai/specification/data/statuswarning_lowfuellight) | 차량 데이터 | `GET https://dev.kr-ccapi.hyundai.com/api/v1/car/status/warning/:carId/lowFuel` | 승인 |
| 13 | [타이어 공기압 경고등 상태 조회](https://developers.hyundai.com/web/v1/hyundai/specification/data/statuswarning_tirepressurelamp) | 차량 데이터 | `GET https://dev.kr-ccapi.hyundai.com/api/v1/car/status/warning/:carId/tirePressure` | 승인 |
| 14 | [Lamp wire 경고등 상태 조회](https://developers.hyundai.com/web/v1/hyundai/specification/data/statuswarning_lampwire) | 차량 데이터 | `GET https://dev.kr-ccapi.hyundai.com/api/v1/car/status/warning/:carId/lampWire` | 승인 |
| 15 | [스마트키 배터리 상태 조회](https://developers.hyundai.com/web/v1/hyundai/specification/data/statuswarning_smartkeybattery) | 차량 데이터 | `GET https://dev.kr-ccapi.hyundai.com/api/v1/car/status/warning/:carId/smartKeyBattery` | 승인 |
| 16 | [워셔액 경고등 상태 조회](https://developers.hyundai.com/web/v1/hyundai/specification/data/statuswarning_washerfluid) | 차량 데이터 | `GET https://dev.kr-ccapi.hyundai.com/api/v1/car/status/warning/:carId/washerFluid` | 승인 |
| 17 | [브레이크 오일 경고등 상태 조회](https://developers.hyundai.com/web/v1/hyundai/specification/data/statuswarning_breakoil) | 차량 데이터 | `GET https://dev.kr-ccapi.hyundai.com/api/v1/car/status/warning/:carId/breakOil` | 승인 |
| 18 | [엔진 오일 경고등 상태 조회](https://developers.hyundai.com/web/v1/hyundai/specification/data/statuswarning_engineoil) | 차량 데이터 | `GET https://dev.kr-ccapi.hyundai.com/api/v1/car/status/warning/:carId/engineOil` | 승인 |
| 19 | [데이터 조회 불가 상태 알림](https://developers.hyundai.com/web/v1/hyundai/specification/data/partner_deletecallback) | 인증·동의·접근 | `POST https://callback_url` | 승인 |

토큰 발급·갱신·삭제를 별도 3개로 부풀려 세지 않았습니다. 위 표는 공식 문서 항목 수입니다.
추가 데이터 항목은 커넥티드 서비스 가입/무료 종료일과 Lamp wire 경고입니다. 현재 요청 범위를 넘어 구현하거나 Sample URL을 추정하지 않았습니다.

## 과거 Sample 요청 근거와 현재 제약

기존 로컬 실험의 catalog.py는 2026-10-13 공식 UI가 제공했던 도메인과 10개 경로를 기록합니다.
기본 주소 `https://dev.kr-ccapi.hyundai.com/api_sample/v1`에 이어지는 고정 경로는 현 src/hyundai_experiments/catalog.py에 있습니다.
누적거리 `/car/status/{car_id}/odometer`, 브레이크 오일 `/car/status/warning/{car_id}/breakOil` 등 대소문자/철자는 과거 자료와 현재 데이터 규격을 대조했습니다.
누적거리의 Sample 주소와 Bearer 헤더는 현재 콘솔의 cURL과 일치합니다. 다른 9개 우선 항목은 콘솔에 테스트 표시가 있고 이번 외부 호출은 보류했습니다. 내 차량 리스트에는 Sample Test 버튼이 보이지 않아 외부 Sample 주소를 확정할 수 없습니다.
설정 조회의 404는 차량 데이터 endpoint의 HTTP 실패가 아닙니다. 이번에는 로그인 콘솔의 Sample Test에서 테스트 요청 설정을 확인했습니다.

누적거리 콘솔은 테스트 차량 다섯 개 중 하나를 선택하는 방식입니다. 2026-11-25 13:46 KST 첫 번째 차량을 선택해 공식 cURL과 같은 외부 GET을 보냈습니다. [인증정보를 제외한 실행 증거](evidence/sample-odometer-20261125.json)
