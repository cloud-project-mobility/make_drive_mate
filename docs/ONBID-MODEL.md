# 온비드 공매 가격 모델 실험

`backend/scripts/onbid_model.py`는 정제된 `passenger_clean.csv`로 가격 모델을 비교한다. 온비드 키나 LLM 키를 읽지 않는다. 원천 데이터와 모델 산출물은 Git에서 제외되는 `backend/data/onbid/`에 보관한다.

## 실행

Colab 또는 `backend/requirements-ml.txt`의 고정 버전을 설치한 Python 3.12 분석 환경에서 실행한다. 운영 서버는 Spring이 별도 Python worker를 호출하며, 분석 라이브러리는 해당 Python 환경에 설치한다.

```python
from onbid_model import train, load_bundle, build_evidence, FEATURES

metrics = train("passenger_clean.csv", "model_run", n_estimators=200)
bundle = load_bundle("model_run/model_bundle.joblib")
# 아래 입력은 훈련 행을 복사한 기능 점검용이며 독립 평가가 아니다.
vehicle = bundle["reference_train"].iloc[0][FEATURES].to_dict()
facts = build_evidence(bundle, vehicle, monthly_km=1000,
                       months=(0, 6, 12), monthly_upkeep_krw=150000)
```

```text
python backend/scripts/onbid_model.py train --input backend/data/onbid/RUN/processed/passenger_clean.csv --output-dir backend/data/onbid/RUN/model
python -m unittest discover -s backend/scripts -p test_onbid_model.py
```

출력 폴더가 이미 채워져 있으면 덮어쓰지 않고 중단한다. `joblib` 파일은 코드를 실행할 수 있으므로 직접 만든 신뢰할 수 있는 모델만 로드한다.

## 데이터와 검증

- 목표는 원화 단위 `price_krw`, 종류는 `auction_award`다. 소비자 소매가·딜러 매입가와 혼합하지 않는다.
- 입력은 근사 차령, 주행거리, 배기량, 제조사, 모델, 연료, 차량 분류다. 감정가, 최저입찰가, 낙찰가율, 입찰자 수 등 사후 정보나 소비자가 알기 어려운 공매 정보는 입력에서 제외한다.
- 실제 개찰 날짜의 전체 달력 기간을 60% 훈련, 15% 모델 선택, 10% 오차 보정, 15% 최종 테스트로 나눈다. 동일 물건관리번호가 여러 구간에 걸치면 그 그룹 전체를 제외하고 제외 내역을 저장한다. 날짜만 가진 연식 차령은 정확한 최초등록일 기준 나이가 아니다.
- 각 구간은 최소 80/20/20/20행, 전체 기간은 최소 60일이어야 한다. 이는 코드 실험을 위한 하한이며 실서비스 타당성을 보장하지 않는다. 1,000행·최종 테스트 150행 미달 여부도 기록한다.
- 수치의 중앙값 대체·결측 플래그와 범주의 희귀값 묶기·원핫 변환은 훈련 자료로만 학습한다.
- 전체 중앙값, 제조사·모델·3년 차령 구간 중앙값(5건 미만이면 모델/전체 중앙값), 로그 가격 Extra Trees, 로그 가격 Random Forest를 비교한다. 두 트리 앙상블은 부스팅 모델이 아니다. 선택 기준은 검증 구간 MAE다. 테스트 결과를 보고 모델을 바꾸지 않는다.
- 선택 모델을 훈련 구간에 학습한 그대로 유지한다. 보정 구간 절대오차의 유한 표본 순위값으로 명목 80% 참고 구간을 만든다. 시간에 따른 분포 변화에서는 포함률 보장이 없으므로 최종 테스트의 실제 포함률과 폭을 함께 기록한다.
- 평가 지표는 MAE(원·만원), 중앙 절대오차, RMSE, WAPE, 하위집단 건수다. 표본 30건 미만의 하위집단은 별도 표시한다.
- permutation importance는 검증 구간에서 계산한 모델 전체 의존도다. 한 차량의 가격 하락 원인이나 인과효과로 설명하지 않는다.

## 산출물

`metrics.json`, `subgroup_metrics.json`, `validation_feature_importance.csv`, `test_predictions.csv`, `split_assignments.csv`, `excluded_boundary_groups.csv`, `model_bundle.joblib`를 저장한다. 번들에는 선택 모델, 메타데이터, 훈련 구간의 설명용 차량 특성·가격 참조 행만 들어간다. API 키·차량번호·연락처·원문 제목은 넣지 않는다.

## 설명과 시나리오 계약

`build_evidence()`는 가격·참고 범위·검증 오차·같은 모델의 훈련 건수·유사 공매 3건·조건 변경 시나리오를 반환한다. LLM을 호출하지 않으며 `llm_status=not_called`다. 후속 설명기는 이 값만 근거로 사용해야 한다.

학습에 없는 모델/제조사 조합과 수치 훈련 범위 밖 입력은 가격을 만들지 않고 `status=deferred`로 반환한다. 같은 모델 10건 미만이나 미학습 연료·제조사 범주는 경고한다. 수치 범위는 전체 훈련 분포의 범위이므로 그 안의 모든 조합에 충분한 근거가 있다는 뜻은 아니다.

미래의 차령과 주행거리만 변경한 결과는 **시장 조건을 고정한 조건 비교**다. 나무 모델은 외삽과 매끄러운 장기 추세에 적합하지 않으며, 더 오래·많이 운행한 조건에서 예측 가격이 오를 수도 있다. 그런 경우 계산값을 강제로 내리지 않고 `non_monotonic_scenario_at_month` 경고를 남긴다. 참고 구간도 실제 미래 관측을 이용해 보정한 것이 아니다.

월 보유비는 사용자의 가정이며 자동 정비비 예측이 아니다. `assumed_combined_cost_krw`는 현재 조건 대비 예측값 차이와 월 보유비의 합이며, 대체 교통·다음 차 구매·대출·세금 등을 포함한 완전한 비용 최적화가 아니다.

제품 차별화 후보는 모델 이름 자체보다 ① 실제 공매 사례를 함께 보여주는 근거, ② 사용 조건에 따른 결과 비교, ③ 지원 데이터가 부족할 때 이유를 알려주는 판단 유보다. 경쟁사에 없는 유일한 기능이라고 주장하지 않는다.

## 공식 참고

- [ExtraTreesRegressor](https://scikit-learn.org/stable/modules/generated/sklearn.ensemble.ExtraTreesRegressor.html)
- [RandomForestRegressor](https://scikit-learn.org/stable/modules/generated/sklearn.ensemble.RandomForestRegressor.html)
- [전처리와 데이터 누수](https://scikit-learn.org/stable/common_pitfalls.html)
- [Permutation importance의 해석](https://scikit-learn.org/stable/modules/permutation_importance.html)
- [트리 모델의 외삽 한계](https://scikit-learn.org/stable/modules/tree.html)

## 2026-11-04 로컬 실행 검증

교정된 `onbid-normalized-v2` 승용차 데이터 **2,197행**으로 실행했다. 원본 5,268행에서 폐차·다대 차량·점검용 물건과 검토 대기 기록을 분리한 데이터다. 동일 차량이 시간 경계를 넘는 53개 그룹 122행을 제외해 훈련 839행, 검증 559행, 보정 336행, 최종 시험 341행을 사용했다.

| 모델 | 검증 MAE(만원) |
| --- | ---: |
| 전체 중앙값 | 206.05 |
| 모델·차령 중앙값 | 201.17 |
| Extra Trees(로그 가격) | 168.84 |
| Random Forest(로그 가격, 선택됨) | 153.11 |

선택 모델의 전체 최종 시험 MAE는 **236.15만원**, WAPE 40.70%, RMSE 1,356.00만원, 명목 80% 참고 구간의 실제 포함률은 76.83%였다. 미학습 페라리 등 큰 가격 차이를 가진 차량이 있어 RMSE가 크다. 시험 오차를 낮추기 위해 고가 차량을 삭제하지 않았다.

서비스가 처음부터 사용하던 지원 규칙(미학습 모델·제조사 조합과 수치 범위 이탈 시 유보)을 최종 시험에도 적용하면, 341행 중 262행(76.83%)에 가격을 제공하고 79행을 유보한다. 제공 대상의 조건부 MAE는 134.74만원, WAPE 31.08%, 참고 구간 실제 포함률은 82.06%다. **조건부 성능은 전체 성능을 대신하지 않는다. 제공률과 전체 시험 결과를 함께 보고한다.** 지원 규칙을 최종 시험 결과에 맞춰 튜닝하지 않았다.

최종 산출물 경로는 `backend/data/onbid/model-20261104-v2-validated/`다. 전체·조건부 평가, 시험 행별 유보 사유, 실제 호출 기록이 남아 있다. `model_bundle.joblib`은 약 4.33MB다.

검증 과정에서 선택 입력인 배기량 `NaN`을 허용하지 않던 추론 오류를 고쳤다. 핵심 수치 입력의 불리언은 거절하며, 선택 배기량의 `None`·결측치는 훈련 전용 대체 규칙을 사용한다.

## Spring JSON worker

`backend/scripts/onbid_worker.py`는 요청 한 건을 표준입력으로 받고 표준출력에 JSON 한 건만 반환한다. Python 3.12 환경에 `backend/requirements-ml.txt`를 설치한다. 로컬 격리 환경은 Git에서 제외되는 `backend/data/onbid/.venv-ml/`에 만들었다.

```text
python backend/scripts/onbid_worker.py --model-bundle /server/model/model_bundle.joblib
```

입력 예시:

```json
{
  "vehicle": {
    "make": "현대자동차",
    "model": "쏘나타",
    "fuel": "휘발유",
    "vehicle_category": "승용차",
    "age_years": 7,
    "odometer_km": 100000,
    "engine_cc": 1999
  },
  "monthly_km": 1000,
  "months": [0, 6, 12],
  "monthly_upkeep_krw": 150000,
  "use_llm": false
}
```

- 정상 응답: `{"ok": true, "api_version": "onbid-worker-v1", "evidence": {...}, "explanation": {...}}`와 종료 코드 0. 지원하지 않는 차량도 정상 처리된 판단 유보로 반환한다.
- 잘못된 요청: `{"ok": false, "error": {"code": "INVALID_INPUT", "message": "..."}}`와 종료 코드 2. 잘못된 JSON, 중복 JSON 키, 비유한 수치, 초대형 수치, 미지원 필드, 32KiB 초과 요청을 거절한다.
- 서버 모델·설정 오류: 같은 오류 형식과 종료 코드 3. 원시 예외, 서버 파일 경로, API 응답 본문, 키는 오류 출력에 넣지 않는다.
- 모델 경로는 서버가 지정하는 `--model-bundle` 또는 `DRIVEMATE_MODEL_BUNDLE`이다. 선택적으로 `--model-sha256` 또는 `DRIVEMATE_MODEL_SHA256`으로 무결성을 확인한다. 요청 본문은 파일 경로·모델 ID·외부 URL·키를 지정할 수 없다.
- LLM 요청은 `use_llm=true`와 서버의 `--allow-llm`이 모두 있어야 한다. 키는 서버 환경변수 `OPENAI_API_KEY` 또는 서버 고정 인자 `--env-file`에서 읽는다. 모델은 서버 `OPENAI_MODEL` 설정이며 요청자가 변경하지 못한다.
- LLM 공급자 오류 또는 근거 선택 검증 실패 시 명시적인 템플릿 설명과 `fallback_reason`을 반환한다. `evidence.llm_status`와 `explanation.provider_call`은 호출·토큰 사용 여부를 구분하며 키나 프롬프트는 담지 않는다.
- 프로세스 실행은 셸 문자열 조합이 아닌 고정 인자 배열을 사용하고, 요청 JSON을 stdin으로 전달한 뒤 입력을 닫는다. Spring은 정상·오류 종료 코드를 확인하고 전체 시간 제한을 둔다. LLM 요청 제한 90초를 포함해 프로세스 제한 125초를 권장한다.

2026-11-04 실제 worker 검증에서 템플릿은 3.04초, OpenAI `gpt-6-astra` 근거 선택 호출은 15.15초였다. 두 경우 모두 종료 코드 0, stderr 0바이트, 단일 JSON 응답을 확인했다. 실제 LLM 요청 한 건은 입력 1,253·출력 118·합계 1,371토큰을 사용했고 검증된 카드만 선택했다. 이는 로컬 단일 요청 관측이며 배포 성능 보장은 아니다.

## 재현 및 한계

실행 성공 여부와 최신 성능은 해당 실행의 `metrics.json`, `worker_validation.json`, 테스트 출력으로 확인한다. Colab 샘플 입력을 JSON으로 만들 때 pandas 행은 먼저 `row[FEATURES].to_dict()`로 변환해 NumPy 정수가 남지 않도록 한다. 실제 판매가격의 정확도나 미래 가격 경로는 이 시험으로 검증하지 않았다.
