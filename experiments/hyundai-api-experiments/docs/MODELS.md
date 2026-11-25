# 응답 및 Python 모델

아래 JSON은 직접 작성한 Mock 또는 출력 형식 설명입니다. 2026-11-25 실제 Sample 수신 자료가 아닙니다.

## 5. API 반환 데이터

아래 JSON은 저장소의 [합성 Mock 데이터](../fixtures/mock_responses)를 사용한 **구조 설명용 예시**입니다.
현대 서버에서 받은 실제 본문이나 실차 측정값이 아닙니다. 현재 실행 결과는 [실행 보고서](RUN_REPORT.md)를 확인하세요.
필드 표의 필수·선택은 **현재 파서의 검증 기준**입니다. 공식 규격의 전체 확장 필드를 뜻하지 않습니다.

### HTTP 응답과 Python 객체는 다른 단계

모든 성공 응답의 최상위 JSON은 **object**입니다. 누적거리도 최상위는 object이고 그 안의 `odometers`가 배열입니다.
클라이언트는 JSON을 읽은 뒤 검증하고 API별 dataclass로 변환합니다. `run_sample()`이 JSON 문자열이나 dict를 그대로 반환하지는 않습니다.

| JSON에서 오는 타입 | JSON 파싱 직후 Python 타입 | 검증 후 사용하는 타입 |
|---|---|---|
| `object` | `dict` | API별 dataclass. 허용한 필드만 모델에 보관 |
| `array` | `list` | 누적거리 기록은 `tuple[OdometerReading, ...]` |
| `number` | 정수는 `int`, 소수는 `float` | 거리·SOC·잔여시간 값은 `Decimal(str(value))` |
| `number` 형식의 코드 | 코드가 정수이면 `int` | 거리·시간 단위는 `IntEnum`, 플러그 코드는 `int` |
| `boolean` | `bool` | `bool`. 숫자 `0`/`1`이나 문자열을 변환하지 않음 |
| `string` | `str` | ID·날짜 원문은 문자열 검증. 전송시각은 별도 `datetime`도 생성 |
| `null` | `None` | 검증 대상 필드의 null은 거부. 선택 필드 자체가 없을 때만 모델에 `None` 사용 |

공식 표에서 `date`/`datetime`이라고 부르는 값도 실제 JSON에서는 문자열입니다.
공식 표의 `unit`, `batteryPlugin`, `plugType` 타입은 `number`지만 현재 파서는 **정수 코드만** 허용합니다.
따라서 `unit: 1`은 통과하고 `unit: 1.0`, `unit: "1"`, `unit: true`는 거부합니다.
측정값은 정수·소수 모두 허용하지만, 원본 JSON 숫자를 먼저 `int`/`float`로 읽으므로 임의 정밀도 원문 숫자 보존까지 보장하는 구현은 아닙니다.
정의하지 않은 추가 필드는 무시하고 반환 모델에 보관하지 않습니다. 공급자 규격 전체를 검증하는 구현은 아닙니다.

### 공통 필드와 단위

| 필드·단위 | 자료형 / 의미 | 처리 방식 |
|---|---|---|
| `msgId` | 비어 있지 않은 string, 공급자 메시지 ID | 필수 확인 후 모델·로그에 보관하지 않음 |
| `timestamp` | string, `YYYYMMDDHHmmSS` 형식의 공급자 전송시각 | 경고등 6종에는 없음. 시간대를 임의로 UTC/KST로 지정하지 않음 |
| 거리 `unit` | integer: `0`=feet, `1`=km, `2`=meter, `3`=miles | 누적거리·주행 가능 거리 공통. 단위 자동 변환 없음 |
| 충전 시간 `unit` | integer: `0`=hour, `1`=min, `2`=msec, `3`=sec | `remainTime.unit`에만 적용. 거리 단위와 별개 |

숫자는 유한한 음수 아닌 값만 허용하고, SOC는 0~100% 범위도 검사합니다.
모르는 단위, 잘못된 날짜, 필수 필드 누락·null, 숫자 대신 boolean/string이 오면 검증 실패로 처리합니다.

### 누적 운행 거리 — `odometer`

```json
{
  "msgId": "synthetic-mock-message",
  "odometers": [
    {
      "date": "20261012",
      "timestamp": "20261012153000",
      "value": 45678,
      "unit": 1
    }
  ]
}
```

| JSON 필드 | JSON 타입 | Python 모델의 속성과 타입 | 의미 / 검증 |
|---|---|---|---|
| `odometers` | array of object | `readings: tuple[OdometerReading, ...]` | 필수, 비어 있지 않은 거리 기록 배열 |
| `odometers[].date` | string | 각 행의 `query_date_raw: str` | 필수, 조회일자 `YYYYMMDD` |
| `odometers[].timestamp` | string | 각 행의 `provider_timestamp_raw: str`, `provider_observed_at: datetime` | 필수, 공급자 전송시각 |
| `odometers[].value` | number | 각 행의 `value: Decimal` | 필수, 누적거리. 예시는 45,678km |
| `odometers[].unit` | 정수 number | 각 행의 `unit: DistanceUnit` | 필수, `0`/`1`/`2`/`3` |

공식 문서 표에는 `odometers`가 object로, 성공 예시에는 배열로 표시됩니다.
현재 구현은 공식 성공 예시의 배열 형태를 사용하며 객체가 오면 자동으로 바꾸지 않습니다.
여러 기록을 반환할 수 있으므로 첫 번째 행이 가장 최신이라고 가정하지 않습니다.
공식 설명의 누적거리 값은 소수점 절사 수치이며, 갱신 기준은 시동 종료입니다.
파서는 음수 아닌 유한 number를 허용하되 추가로 절사하지 않습니다.
[공식 누적거리 규격](https://developers.hyundai.com/web/v1/hyundai/specification/data/status_odometer)

### 주행 가능 거리 — `dte`

```json
{
  "timestamp": "20261012093000",
  "value": 321.5,
  "unit": 1,
  "msgId": "mock-dte"
}
```

| JSON 필드 | JSON 타입 | Python 모델의 속성과 타입 | 의미 / 검증 |
|---|---|---|---|
| `value` | number | `value: Decimal` | 필수, 주행 가능 거리. 예시는 321.5km |
| `unit` | 정수 number | `unit: DistanceUnit` | 필수, 거리 단위 코드 |
| `timestamp` | string | `provider_timestamp_raw: str`, `provider_observed_at: datetime` | 필수, 공급자 전송시각 |
| `phevTotalValue` | number | `phev_total_value`: `Decimal` 또는 `None` | 선택, PHEV의 배터리+엔진 총 주행 가능 거리 |
| `phevTotalUnit` | 정수 number | `phev_total_unit`: `DistanceUnit` 또는 `None` | 선택, PHEV 총 거리의 단위 |

선택 필드 `phevTotalValue`와 `phevTotalUnit`은 둘 다 없을 수 있지만, 하나가 오면 둘을 함께 요구합니다.
이 값은 누적 운행 거리와 별개이며, 운행한 거리로 합산하지 않습니다.
공식 문서는 시동 종료 기준 갱신 및 2개월 미운행 차량의 조회 제한을 설명합니다. 실차 제한 동작은 아직 검증하지 않았습니다.
[공식 주행 가능 거리 규격](https://developers.hyundai.com/web/v1/hyundai/specification/data/status_dte)

### 경고등 6종 — 공통 구조

`engine-oil`, `tire-pressure`, `brake-oil`, `low-fuel`, `washer-fluid`, `smart-key-battery`에 적용됩니다.
아래는 합성 타이어 공기압 경고 예시입니다.

```json
{
  "status": true,
  "msgId": "mock-tire"
}
```

| JSON 필드 | JSON 타입 | Python 모델의 속성과 타입 | 의미 / 검증 |
|---|---|---|---|
| `status` | boolean | `status: bool` | 필수, `true`=해당 경고, `false`=해당 경고 없음 |
| `msgId` | string | 검증만 수행, 모델 속성 없음 | 필수, 공급자 메시지 ID |

`0`, `1`, `"true"`, `null`을 boolean으로 바꾸지 않습니다.
이 구조에는 공급자 관측시각이 없어서 모델의 `provider_observed_at`은 `None`으로 유지합니다.
타이어 공기압 수치나 엔진오일 잔량을 반환하는 API가 아니라 해당 경고의 상태를 반환합니다.
`false`를 차량 전체 정상이나 정비 불필요로 해석하지 않습니다.
스마트키의 `true`는 전압 경고 상태, `false`는 해당 경고 기준의 정상 상태를 뜻하며 배터리 잔량(%)을 주는 값이 아닙니다.
주유 경고는 시동 종료, 나머지 요청한 경고는 시동 종료 또는 EV/PHEV 충전 종료가 공식 갱신 기준입니다.
[공식 스마트키 규격](https://developers.hyundai.com/web/v1/hyundai/specification/data/statuswarning_smartkeybattery),
[나머지 경고등별 규격 링크](API_MATRIX.md)

### EV 배터리 잔량 — `ev-battery`

```json
{
  "soc": 64,
  "timestamp": "20261012093000",
  "msgId": "mock-battery"
}
```

| JSON 필드 | JSON 타입 | Python 모델의 속성과 타입 | 의미 / 검증 |
|---|---|---|---|
| `soc` | number | `soc: Decimal` | 필수, 배터리 충전 잔량(%), 0~100. 예시는 64% |
| `timestamp` | string | `provider_timestamp_raw: str`, `provider_observed_at: datetime` | 필수, 공급자 전송시각 |

SOC(State of Charge)는 충전 잔량이며 배터리 노화·건강도(SOH)나 사용 가능한 에너지(kWh)와 다릅니다.
[공식 EV 배터리 규격](https://developers.hyundai.com/web/v1/hyundai/specification/data/status_evbattery)

### EV 충전 상태 — `ev-charging`

```json
{
  "batteryPlugin": 2,
  "batteryCharge": true,
  "soc": 64,
  "targetSOC": {"plugType": 1, "targetSOClevel": 90},
  "remainTime": {"value": 42, "unit": 1},
  "timestamp": "20261012093000",
  "msgId": "mock-charging"
}
```

| JSON 필드 | JSON 타입 | Python 모델의 속성과 타입 | 의미 / 검증 |
|---|---|---|---|
| `batteryPlugin` | 정수 number | `battery_plugin: int` | 필수, `0`=미연결, `1`=급속 충전기 연결, `2`=일반 충전기 연결 |
| `batteryCharge` | boolean | `battery_charge: bool` | 필수, `true`=충전 중, `false`=충전 중 아님 |
| `soc` | number | `soc: Decimal` | 필수, 현재 배터리 잔량(%), 0~100 |
| `remainTime` | object | 아래 두 속성으로 펼침 | 필수, 목표 충전까지의 예상 시간 |
| `remainTime.value` | number | `remain_value: Decimal` | 필수, 시간 수치. 예시는 `unit=1`이므로 42분 |
| `remainTime.unit` | 정수 number | `remain_unit: TimeUnit` | 필수, 위 충전 시간 단위 코드 |
| `timestamp` | string | `provider_timestamp_raw: str`, `provider_observed_at: datetime` | 필수, 공급자 전송시각 |
| `targetSOC` | object | `target_soc`: `TargetSoc` 또는 `None` | 선택, 충전 목표 설정 |
| `targetSOC.plugType` | 정수 number | `target_soc.plug_type`: `int` 또는 `None` | 선택, `0`=DC, `1`=240V AC, `2`=120V AC |
| `targetSOC.targetSOClevel` | number | `target_soc.target_soc_level`: `Decimal` 또는 `None` | 선택, 목표 잔량(%), 0~100. 예시는 90% |

현재 파서는 `targetSOC`가 오면 내부 두 필드 중 하나 이상을 요구하고, 제공된 필드를 각각 검증합니다.
`batteryPlugin`과 `targetSOC.plugType`은 서로 다른 코드이므로 같은 enum으로 취급하지 않습니다.
공식 문서상 `remainTime`은 **충전기 연결 상태에서는 잔여 충전 시간**, **미연결 상태에서는 240V로 충전할 경우의 잔여 시간**입니다.
따라서 미연결 상태에서 시간값이 있어도 실제 충전 중이라고 판단하지 않습니다. 연결 여부와 충전 여부는 각각의 필드로 확인합니다.
EV 배터리·충전 데이터의 실제 갱신 주기·지연은 이번에 검증하지 않았습니다.
[공식 EV 충전 규격](https://developers.hyundai.com/web/v1/hyundai/specification/data/status_evcharging)

### 실패 응답의 타입과 null 처리

공식 오류 응답은 `errCode: string`, `errMsg: string`, `errId: string` 필드를 설명합니다.
이 프로젝트는 HTTP 401/403/429/5xx를 구분하고, HTTP 200이어도 오류 필드가 있으면 정상 데이터로 사용하지 않습니다.
오류 설명과 ID는 로그에 남기지 않으며, 허용된 네 자리 형식의 오류 코드만 진단에 보관합니다.

예를 들어 `soc: null`은 `soc=0`으로 바꾸지 않고 구조 검증 실패로 처리합니다.
반면 선택 필드 `targetSOC`가 아예 없다면 정상 `ChargingResponse`에서 `target_soc=None`으로 표현합니다.
`targetSOC: null`과 `targetSOC: {}`는 현재 파서에서 거부합니다.

## 6. 프로그램 반환값과 실행 결과

### Python 코드에서 데이터 사용

`run_sample(settings, api)`는 `ExperimentResult`를 반환합니다.
HTTP·JSON·구조 검증을 통과하면 `result.data`에 아래 모델이 들어가고, 실패하면 `None`입니다.
거리·잔량·시간 측정값은 모델에서 `Decimal`로 보존합니다.

`ExperimentResult` 자체의 속성 타입은 다음과 같습니다. `None`은 값을 확인하지 못했거나 해당 단계까지 진행하지 않았다는 뜻이며 `0`이나 `False`와 구분합니다.

| 속성 | 정확한 Python 타입 | 의미 |
|---|---|---|
| `api` | `str` | `odometer` 등 요청한 API 이름 |
| `source` | `Literal["SAMPLE", "MOCK"]` | 실제 Sample 실행 경로인지 합성 Mock인지 구분. 설정 오류도 `SAMPLE`일 수 있음 |
| `status` | `Status` (`StrEnum`) | 검증·실패 분류. 문자열은 `status.value` |
| `validated` | `bool` 속성(property) | Sample 또는 Mock 구조 검증 성공 여부. 출처는 `source`로 별도 확인 |
| `data` | `ApiResponse` 또는 `None` | 아래 5가지 모델 중 하나. 검증 실패 시 `None` |
| `started_at` | `datetime` | UTC 시간대 정보를 가진 시도 시각 |
| `received_at` | `datetime` 또는 `None` | UTC 수신 시각. 설정·연결 실패 등 응답을 못 받으면 `None` |
| `network_attempted` | `bool` | 실제 Sample 요청을 시도했는지 여부. Mock·설정 오류는 `False` |
| `http_status` | `int` 또는 `None` | 수신한 HTTP 코드. 응답을 못 받으면 `None` |
| `provider_error_code` | `str` 또는 `None` | 형식 검사를 통과한 공급자 오류 코드. 정상 응답에서는 `None` |
| `elapsed_ms` | `float` 또는 `None` | 수행 시간(ms). 설정 검사에서 끝나면 `None` |
| `json_parsed` | `bool` 또는 `None` | JSON 파싱 성공·실패·미시도를 구분 |
| `structure_valid` | `bool` 또는 `None` | 필드 검증 성공·실패·미실시를 구분 |
| `issues` | `tuple[str, ...]` | 고정된 필드명·오류 사유. 성공 시 빈 튜플 |

`ApiResponse`는 `OdometerResponse`, `DistanceResponse`, `WarningResponse`, `BatteryResponse`, `ChargingResponse`의 합집합 타입입니다.
모델은 `frozen=True`인 dataclass이며, `msgId`나 원본 응답 전체를 담지 않습니다.

| API | `result.data` 타입 | 사용 가능한 주요 속성 |
|---|---|---|
| `odometer` | `OdometerResponse` | `readings` 튜플 → 각 행의 `value`, `unit`, `query_date_raw`, `provider_timestamp_raw`, `provider_observed_at` |
| `dte` | `DistanceResponse` | `value`, `unit`, `phev_total_value`, `phev_total_unit`, `provider_timestamp_raw`, `provider_observed_at` |
| 경고등 6종 | `WarningResponse` | `status`, `provider_observed_at`(항상 `None`) |
| `ev-battery` | `BatteryResponse` | `soc`, `provider_timestamp_raw`, `provider_observed_at` |
| `ev-charging` | `ChargingResponse` | `battery_plugin`, `battery_charge`, `soc`, `remain_value`, `remain_unit`, `target_soc`, `provider_timestamp_raw`, `provider_observed_at` |

모든 최상위 모델은 프로그램 수신시각 `received_at`을 별도로 가지며 UTC 시간대 정보가 있습니다.
`target_soc`가 있으면 `plug_type`, `target_soc_level` 속성으로 접근합니다.
공급자의 관측시각과 우리 프로그램의 수신시각을 서로 대체하지 않습니다.

아래 코드를 실행하면 공식 EV 배터리 Sample을 **1회 실제 호출**합니다.
검증된 잔량은 메모리에서 사용하고, 출력은 마스킹된 진단만 사용합니다.

```python
from hyundai_experiments.client import run_sample
from hyundai_experiments.config import Settings
from hyundai_experiments.status_models import BatteryResponse

settings = Settings.from_env_file()
result = run_sample(settings, api="ev-battery")
if result.validated and isinstance(result.data, BatteryResponse):
    soc_percent = result.data.soc
    observed_at = result.data.provider_observed_at
    received_at = result.data.received_at

print(result.safe_json(settings))
```

### 터미널·파일에 반환하는 진단

`output/`에 시각이 포함된 진단 JSON이 생깁니다. 이 폴더는 Git 제외 대상입니다.
`--no-save`를 Sample 명령 뒤에 붙이면 파일 저장 없이 진단만 출력합니다.
실제 공급자 응답의 거리값·시각·메시지 ID·차량 식별자·본문은 출력하거나 저장하지 않습니다.
검증된 응답 모델은 Python 메모리의 `ExperimentResult.data`에만 유지합니다.
직접 `run_sample()`을 호출하면 파일을 만들지 않습니다. `output/` 저장은 CLI와 검증 스크립트가 수행합니다.

성공 진단의 주요 필드 형식은 다음과 같습니다. **설명용 성공 형식이며 이번 실행 로그가 아닙니다. 이번 외부 누적거리 호출 결과는 HTTP 403입니다.**
위의 반환 JSON 예시와 달리 거리·잔량 등의 `data`는 포함하지 않습니다.

```json
{
  "api": "odometer",
  "source": "SAMPLE",
  "status": "sample_validated",
  "network_attempted": true,
  "http_status": 200,
  "provider_error_code": null,
  "json_parsed": true,
  "structure_valid": true,
  "issues": [],
  "response_body_saved": false
}
```

`source`는 Sample 실행 경로이면 `SAMPLE`, 합성 데이터면 `MOCK`입니다. 실제 요청 시도 여부는 `network_attempted`로 확인합니다.
`status`는 검증 결과 문자열입니다. `safe_json(settings)`의 반환 타입은 `str`이며, `diagnostic()`은 `dict[str, object]`입니다.
두 진단 모두 `data`를 포함하지 않고, `safe_json`은 알려진 로컬 비밀값도 추가 마스킹하므로 출력에 사용합니다.
경고등 응답의 boolean `status`와 진단의 문자열 `status`는 서로 다른 필드입니다.
전체 진단에는 요청·수신 시각, 응답시간, 차량 ID가 마스킹된 URL, 문서 링크, 미검증 범위도 포함됩니다.

| 결과 | 의미 |
|---|---|
| `sample_validated` | 공식 Sample HTTP 200 + JSON + 공개 예시의 필수 구조 통과 |
| `mock_only_validated` | 자체 Mock의 구조 검증 통과 |
| `http_json_received_schema_unverified` | HTTP/JSON 수신, 구조 검증 실패 또는 문서 차이 |
| `authentication_failed` / `permission_denied` | HTTP 401 / 403 |
| `rate_limited` / `provider_server_error` | HTTP 429 / 5xx |
| `provider_error` / `invalid_json` | 200 안의 오류 응답 / 파싱 실패 |
| `dns_error` / `tls_error` / `connection_error` / `timeout` | 네트워크 계층 실패 |
| `configuration_missing` / `configuration_invalid` | 설정 누락 / 잘못된 형식, 요청 안 함 |
| `redirect_not_followed` / `http_error` | 리다이렉트 차단 / 기타 HTTP 상태 |

`sample_unsupported_confirmed`는 공식적인 미지원 증거가 있을 때만 사용하도록 예약한 상태입니다.
이번에 어떤 API도 미지원으로 판정하지 않았습니다. 상세 검증 범위와 미확인 사항은
[응답 계약과 보안 메모](CONTRACT_AND_SECURITY.md)를 보세요.

CLI `sample`의 종료 코드는 `0`=검증 성공, `1`=전송·응답·구조 검증 실패,
`2`=설정 누락·잘못된 설정·로컬 파일 처리 오류입니다. `mock`의 의도한 오류 시나리오는 `1`을 반환합니다.

