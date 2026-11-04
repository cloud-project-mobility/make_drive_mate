# DriveMate 모델 비교 노트북

`DriveMate_Onbid_Model_Comparison.ipynb`는 GitHub에 검토·반영할 수 있도록 **코드와 설명만** 담았다. 데이터·임베딩·모델·API 키·base64 묶음·실행 출력은 포함하지 않는다. 알고리즘을 노트북에 복제하지 않고 `backend/scripts/onbid_data.py`, `onbid_model.py`, `onbid_explain.py`를 불러온다.

## 실행 준비

1. 코드 공개 대상은 `cloud-project-mobility/make_drive_mate`다. 해당 저장소에 반영된 코드를 준비하고 `REPO_ROOT`를 실제 체크아웃 폴더로 지정한다. 공개 코드와 비공개 학습 자료는 별도로 준비한다. GitHub 토큰을 노트북 코드나 출력에 넣지 않는다.
2. Python 3.12 환경에 저장소의 고정 의존성을 설치한다. 로컬에서는 격리 환경에서 `python -m pip install -r backend/requirements-ml.txt`를 실행하고 그 커널을 선택한다. Colab에서는 저장소 경로를 맞춘 뒤 해당 커널에 `%pip install -r /content/make_drive_mate/backend/requirements-ml.txt`를 실행할 수 있다. 이미 불러온 패키지 버전이 변경됐다면 런타임을 다시 시작한다. 노트북 자체는 설치나 외부 API 호출을 자동 실행하지 않는다.
3. 사용·보관 권한이 있는 온비드 수집 폴더를 별도로 준비한다. 수집기의 `manifest.json`과 여기에 기록된 원본 페이지 파일이 함께 있어야 한다. ZIP을 별도 제공받았다면 비공개 작업 공간에 풀고 `manifest.json`이 있는 폴더를 선택한다. 임의 JSON/CSV를 원본 수집 폴더처럼 지정하지 않는다.
4. 첫 코드 셀의 `REPO_ROOT`, `RAW_RUN_DIR`를 실제 위치로 바꾼다. 결과는 기본적으로 Git에서 제외되는 `backend/data/onbid/notebook-results/`에 새 실행별 폴더로 저장한다. 전처리는 선택한 수집 폴더의 `processed/` 결과를 다시 생성한다.
5. 위에서부터 실행한다. 전처리 → 기준선/Extra Trees/Random Forest 비교 → 전체/조건부 평가 → 조건 시나리오 → 기본 설명 순서다. 원본 불완전·해시 불일치·표본 부족은 오류로 중단한다. CPU로 실행하며 T4 선택이 GPU 학습을 의미하지 않는다.

이 노트북에는 온비드·OpenAI 키가 필요하지 않다. 이미 수집한 파일을 사용하고, 설명은 템플릿으로만 만든다. 새 수집과 선택적 GPT 호출은 기존 별도 스크립트·서비스의 권한 및 비용 설정을 따른다.

## 두 노트북의 차이

| 구분 | GitHub 코드 전용 버전 | 별도 Colab 실행용 버전 |
|---|---|---|
| 파일 | `notebooks/DriveMate_Onbid_Model_Comparison.ipynb` | 로컬 전달물 `DriveMate_Onbid_ExtraTrees.ipynb` |
| 원본 자료 | 포함하지 않음. 사용자가 별도 폴더 지정 | 실제 원본·코드 ZIP을 base64로 내장 |
| 모델 구현 | 저장소 `backend/scripts` 재사용 | 전달 시점의 Python 코드 묶음 내장 |
| 설명 | API 호출 없는 기본 템플릿 | 기본 템플릿, 사용자가 켜는 선택적 GPT 셀 |
| Git 반영 | 출력·개인 경로·비밀값을 확인한 코드만 반영 | 원본 데이터가 내장되어 있으므로 그대로 커밋하지 않음 |

별도 Colab 실행용 파일은 이번 코드 전용 사본 생성에서 변경하지 않았다. 파일명의 ExtraTrees는 채택 모델 보장이 아니다. 두 버전 모두 후보를 검증 MAE로 비교하며, 기존 정제본 2,197행 실험에서는 Random Forest가 선택됐다. 새 데이터를 지정하면 결과는 달라질 수 있다.

## 저장과 공유

노트북을 실행한 뒤에는 저장하기 전에 **모든 실행 출력과 execution count를 지우고**, 셀에 입력한 개인 경로·토큰·차량 식별정보가 없는지 확인한다. `backend/data/`의 원본·정제 CSV·제외 사유·모델 joblib·예시 근거 JSON은 코드 저장소에 커밋하지 않는다. `.gitignore`는 이미 추적된 파일을 자동으로 제거하지 않으므로 변경 파일 목록도 확인한다.

현재 이 파일을 생성하고 코드 셀 구문·빈 출력·데이터/키 불포함을 검사했다. 원격 GitHub 업로드나 현재 Colab 런타임 실행을 완료했다는 의미는 아니다. 실제 실험 방법·성능·한계는 [모델 문서](../docs/ONBID-MODEL.md)를 기준으로 한다.
