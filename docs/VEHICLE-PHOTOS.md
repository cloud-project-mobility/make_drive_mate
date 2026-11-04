# 차량 사진 UI

2026-11-04: 차량 선택을 사진 카드로 변경하고, 배경을 제거한 투명 PNG 10종을 연결했다. 선택한 차종의 사진을 가치 분석과 차량 정보 화면에도 동일하게 표시한다. 카탈로그에서 차종을 선택해 등록하면 `catalogId`로 사진을 연결하며, 로그인 상태에서는 차량 정보를 계정 DB에도 저장한다. 사용 방법과 API는 [차량 카탈로그·등록 안내](VEHICLE-CATALOG.md)를 참고한다.

- 현재 사진 제공 차종: 현대 아반떼·쏘나타·그랜저·아이오닉 5, 기아 K5·K8·쏘렌토·스포티지·니로·EV6. 지원 세대·연식·구동 방식은 카탈로그에 명시된 범위로 한정한다.
- 사진은 차종을 이해하기 위한 대표 자료다. 사용자 소유 차량이나 온비드 개별 매물의 실제 사진이 아니며 연식·색상·트림·판매 국가가 다를 수 있다.
- 모델을 식별할 수 없거나 사진이 로드되지 않으면 기존 구동 방식 이미지를 사용한다. 사진이 없는 모델에 다른 모델의 사진을 붙이지 않는다.
- 사진을 앱에 포함하고 서버에도 같은 PNG를 패키징한다. 서버 카탈로그 API와 안전한 이미지 API를 추가했으며, DB에는 이미지 바이너리 대신 출처·라이선스·객체 키를 저장한다. S3 객체 키는 `data/vehicle-catalog/{id}.png`다. 현재 이미지 API는 패키징된 파일을 제공하며 S3에서 임의 URL을 가져오지 않는다.
- 현재 수집한 온비드 원본에는 사진 URL이 없다. 매물별 실제 사진 자동 연결과 사용자 사진 업로드는 이번 변경에 포함되지 않는다.
- 사진 출처와 이용 조건은 앱의 ‘차량 사진 안내와 출처’에서 확인할 수 있다.

## 사진 출처

Wikimedia Commons 사진을 원본으로 사용하고, AI 이미지 편집 도구로 배경을 제거해 투명 PNG로 변환했다. 따라서 현재 표시되는 이미지는 원본 그대로가 아닌 편집본이다. 편집으로 차량 윤곽·세부 표현에 차이가 생길 수 있어 외관 참고용으로만 사용한다. 원저작자와 원본 링크, 라이선스, AI 배경제거 사실을 앱과 카탈로그 메타데이터에 함께 표시한다. 배경제거본에도 아래 원본별 라이선스를 유지한다.

앱 파일은 `assets/vehicles/cutouts/{id}.png`, 서버 파일은 `backend-spring/src/main/resources/vehicle-catalog/images/{id}.png`에 있다.

| 파일 ID | 저작자 | 라이선스 | 원본 및 사양 |
| --- | --- | --- | --- |
| `avante-cn7-pe` | Damian B Oh; 기존 Commons 크롭: Alex Neman | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | [아반떼 CN7 페이스리프트](https://commons.wikimedia.org/wiki/File:Hyundai_Avante_Inspiration_CN7_PE_Cyber_Gray_Metallic_(front).jpg), 2023-03-28 촬영 |
| `k5-dl3-pe` | Damian B Oh | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | [K5 DL3 HEV 페이스리프트](https://commons.wikimedia.org/wiki/File:Kia_K5_Hybrid_DL3_HEV_PE_Aurora_Black_Pearl_(5).jpg), 2023-12-10 촬영, 개별 연식 미명시 |
| `ioniq5-ne` | Elise240SX | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | [2024 아이오닉 5](https://commons.wikimedia.org/wiki/File:2024_Hyundai_IONIQ_5_Preferred_Long_Range_AWD_in_Cyber_Grey,_front_left,_2024-03-31.jpg), 캐나다 Preferred Long Range AWD 사양 |
| `sonata-dn8-pe` | Damian B Oh | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | [쏘나타 DN8 PE HEV](https://commons.wikimedia.org/wiki/File:Hyundai_Sonata_Hybrid_DN8_HEV_PE_Abyss_Black_Pearl_(1).jpg), 한국형 디 엣지 |
| `grandeur-gn7` | Damian B Oh | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | [그랜저 GN7 HEV](https://commons.wikimedia.org/wiki/File:Hyundai_Grandeur_Hybrid_Calligraphy_GN7_HEV_Nocturne_Gray_Metallic_(1).jpg), 한국형 캘리그래피 |
| `k8-gl3` | Damian B Oh | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | [K8 GL3 HEV](https://commons.wikimedia.org/wiki/File:Kia_K8_Hybrid_GL3_HEV_Snow_White_Pearl_(1)_(cropped).jpg), 기존 Commons 크롭, 부분변경 전 |
| `sorento-mq4-pe` | Damian B Oh | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | [쏘렌토 MQ4 PE HEV](https://commons.wikimedia.org/wiki/File:Kia_Sorento_Hybrid_MQ4_HEV_PE_Snow_White_Pearl_(5)_(cropped).jpg), 기존 Commons 크롭 |
| `sportage-nq5` | Damian B Oh | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | [스포티지 NQ5 HEV](https://commons.wikimedia.org/wiki/File:Kia_Sportage_Hybrid_NQ5_white_(1)_(cropped).jpg), 한국형 장축, 기존 Commons 크롭 |
| `niro-sg2` | Mr.choppers | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | [2023 니로 Hybrid EX](https://commons.wikimedia.org/wiki/File:2023_Kia_Niro_Hybrid_EX_in_Snow_White_Pearl,_front_right.jpg), 북미 사양 |
| `ev6-cv` | DieselFordMondeo | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | [2022 EV6 Air Long Range 2WD](https://commons.wikimedia.org/wiki/File:2022_Kia_EV6_Air_Long_Range_2WD_(Front).jpg), 영국 일반형 사양 |

사진 연결 기준은 `src/domain/vehiclePhoto.ts`와 `src/domain/vehicleCatalog.ts`, 렌더링은 `src/components/VehicleArt.tsx`에 있다. 차종을 추가할 때 출처를 확인한 자산, 앱·서버 카탈로그 JSON, 모델 매핑, 출처 표시를 함께 추가한다. 현재 라이선스와 세대별 주의사항의 기준 데이터는 `assets/vehicles/catalog.json`이며 서버 seed에도 동일하게 반영한다.

## 검증

현재 카탈로그·DB 등록 단계:

- Spring `VehicleCatalogApiTest` 9개와 `CoreApiTest` 11개, 총 20개 통과. 실제 PNG 10종을 포함해 실행했다.
- 전용 로컬 서버 `127.0.0.1:18742`에서 목록 10종·PNG 응답, 임시 계정 생성, 차량 등록·재조회·수정·삭제와 계정 정리를 HTTP로 확인했다.
- DB 검증은 PostgreSQL 호환 모드의 로컬 H2 파일 DB 기준이다. 운영 RDS 연결·마이그레이션·계정 저장은 아직 검증하지 않았다.
- S3에는 PNG 10개와 `catalog.json`, 총 11개 업로드 및 목록·크기 검증을 완료했다. 운영 API/RDS 배포는 별도 단계이며 아직 미검증이다. 현재 배포 범위와 남은 작업은 [차량 카탈로그·등록 안내](VEHICLE-CATALOG.md)에 기록한다.

초기 사진 카드 단계의 기존 검증 기록(현재 10종 카탈로그 변경 전체에 대한 검증 결과를 뜻하지 않음):

- `npm run check`: 타입 검사·ESLint·도메인 테스트 74개 통과.
- 관련 브라우저 검사 8개 통과: 데스크톱/모바일 차량 선택·등록, 사진 로딩, 선택 저장, 출처 안내, 미지원 모델 대체 이미지.
- 360px/1440px에서 가로 넘침 없음 및 실제 화면 캡처 확인.
- Expo 웹·iOS·Android export 통과. 실제 iOS/Android 기기 실행 검증을 의미하지 않는다.
- 병행 작업과 미리보기·검사 결과가 충돌하지 않도록 최종 브라우저 검사는 별도 포트 18741 및 별도 결과 폴더에서 실행했다.
- 화면 빌드를 막던 `ValueDashboard`의 중복 `OnbidValuation` import와 중복 렌더링을 하나로 정리했다.
