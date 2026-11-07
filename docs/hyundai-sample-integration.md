# 현대 Sample 누적거리 → 계정 차량 저장

기준 소스: `cloud-project-mobility/make_drive_mate`, `fcad7a64f1e5341550e42e7a99c0b1cab545cf40`.

## 구현 범위

- 기존 DriveMate 로그인 세션을 사용한다. 새 소셜 로그인은 이번 변경에 포함하지 않는다.
- `POST /api/v1/vehicles/hyundai-sample?powertrain=ICE|HYB|EV`: 샘플 누적거리 조회가 성공하면 로그인한 계정에 차량과 상태를 원자적으로 저장한다.
- `GET /api/v1/vehicles/hyundai-sample`: 외부 호출 없이 해당 계정에 저장된 결과를 반환한다. 없으면 404.
- 동일 계정의 재요청은 동일 UUID의 샘플 차량을 갱신한다. 일반 차량은 변경하지 않고 기존 최대 3대 제한을 지킨다.
- 차량/계정 삭제 시 샘플 상태도 삭제된다. 서로 다른 계정은 서로 다른 차량 UUID를 사용한다.
- 화면에서 현대 샘플 가져오기와 저장된 샘플 조회를 제공한다. 기존 계정 차량 목록을 다시 불러오면 기기에도 추가할 수 있다.

## 데이터의 의미

이번에 확인된 요청 경로는 이전 사용자 콘솔 curl 실험의 다음 누적거리 GET뿐이다.

`https://dev.kr-ccapi.hyundai.com/api_sample/v1/car/status/{carId}/odometer`

인증은 Sample Bearer Token이다. Client ID/Client Secret은 이 요청에 보내지 않는다. 호출 대상은 코드에 고정하며 임의 URL을 입력받거나 자동 재시도/리다이렉트/로컬 mock fallback을 하지 않는다.

기존 `HyundaiProvider.normalizeOdometer`의 응답 계약(`msgId`, `odometers`, `date`, `timestamp`, `value`, `unit`)과 단위 변환을 재사용한다. `source=hyundai_sample`, `is_sample=true`, `is_mock=true`는 원격 샘플 데이터임을 뜻하며 실차 인증이 아니다. 테스트 transport는 `transport_verified=false`다. 원천 시각의 시간대를 추측하지 않는다.

2026-11-07 공식 누적거리 규격과 필드/단위(0 feet, 1 km, 2 meter, 3 miles)를 대조했다: https://developers.hyundai.com/web/v1/hyundai/specification/data/status_odometer . 일반 개발 API와 샘플 전용 경로는 구분하며, 샘플 전용 경로의 최신 동작은 실제 자격 정보로 별도 확인해야 한다.

차종과 구동 방식은 누적거리 API가 제공하지 않는다. 화면에서 고르는 구동 방식은 앱의 분류용이며 `vehicle_profile_source=user_selected_app_category`로 기록한다. 모델명은 차종 미확인으로 표시한다. 배터리, 잔여거리, 경고 상태, GPS는 이 응답에서 만들어 넣지 않는다. 원천 Sample Car ID와 토큰은 응답/DB에 저장하지 않는다.

## 배포와 현재 검증 한계

설정은 [배포 안내](hyundai-sample-deployment.md)를 따른다. 기본 비활성이다. 샘플 기능 활성화는 Kakao/Google 전역 모드를 바꾸지 않는다. 전역 disconnected에서는 외부 호출이 차단된다.

이전 실험 문서(2026-10-13)는 실제 Sample 호출이 DNS_ERROR로 끝났음을 기록한다. 이번 환경에도 실제 Sample Token/Car ID가 없고 대상 서버 네트워크가 제한되어 있으므로, 실제 현대 응답 성공이나 운영 DB 저장 완료를 주장하지 않는다. 제공자 응답 구조가 달라지면 오류로 끝내며 가짜 데이터로 대체하지 않는다.

현재 세션에서는 서버 Maven 환경이 없어 새 Spring 테스트 실행이 불가능하다. 배포 전에 다음 검사와 실제 Sample 호출을 수행해야 한다.

```sh
cd backend-spring
./mvnw '-Dtest=HyundaiSampleApiTest,HyundaiSampleProviderTest,VehicleCatalogApiTest,ProviderTests' test
cd ..
npm run check
npm run export:web
```

회귀 검증: 로그인하지 않은 요청 거절, 두 계정 분리, 로그아웃/재로그인 후 조회, 반복/동시 가져오기 중복 방지, 제공자 실패 시 DB 보존, 3대 제한, 삭제 cascade, 고정 호스트/토큰 전달, 설정 누락 및 잘못된 응답 거절.

GPS·ML·GPT 연결과 새 로그인 페이지는 후속 작업이다. 이 변경은 샘플 누적거리 수집·계정 저장·조회·배포 설정을 준비하는 첫 단계다.
