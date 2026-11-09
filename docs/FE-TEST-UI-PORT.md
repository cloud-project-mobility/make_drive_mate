# FE-test UI 개선 선별 반영

기준일: 2026-11-09 (Asia/Seoul). [FE-test PR #5](https://github.com/cloud-project-mobility/FE-test/pull/5)의 머지 커밋 `df1ba8388e6ca9a4e9589b8e8c23abb20451bff4`를 `make_drive_mate`의 `fcad7a64f1e5341550e42e7a99c0b1cab545cf40` 기준 코드에 맞춰 반영했다.

## 반영 범위

| 개선                | 현재 앱에 맞춘 적용                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 입력 오류·힌트 연결 | `Field`에 안정적인 ID와 설명 연결, 오류 상태, 네이티브 힌트, 선택적 input ref를 추가했다.                        |
| 분석 적용·취소      | `/analysis`의 **오프라인 가정 계산**에서만 미적용 안내·명시적 취소·첫 오류 포커스·적용 완료 포커스를 연결했다.   |
| 결과 위치           | 공매 ML 분석과 통계의 높이를 포함해 오프라인 결과 시작점을 측정한다. 적용 후 다른 분석 영역으로 이동하지 않는다. |
| 선택·모바일         | 초기 비교 시점은 해당 차량의 제안과 맞춘다. 웹 선택 상태, 360px 비용식, 긴 차량 선택 이름 줄바꿈을 보강했다.     |
| 주행 저장 실패      | 종료 확인 모달 안에 오류와 복구 동작을 표시한다. 재시도 성공 뒤 이전 오류는 지우며 동일 기록은 한 번만 저장한다. |

계정 만들기→차량 등록, 홈/AI 상담/이동 계획/내 차의 4개 탭, 파란색 테마, 카탈로그·사진, 공매 분석·계정별 캐시·실시간 위치·카카오맵 흐름은 현재 구현을 사용한다. FE-test의 가입 없는 온보딩이나 전체 차고 화면은 옮기지 않았다. 오프라인 입력 변경은 차량 정보나 ML·AI 요청을 변경하지 않는다.

SDK 호환성 검사에 필요한 5개 패치는 기존 [호환성 PR #5](https://github.com/cloud-project-mobility/make_drive_mate/pull/5)의 `61e44a00d4b7b14c5cdb7911e1222c956284af0e`에 있는 `package.json`과 lockfile을 재사용했다. 기존 Expo 호환성 검사 단계는 유지했다. 다른 미병합 기능 PR은 포함하지 않았다.

## 검증

- TypeScript·ESLint·도메인 테스트 106개 통과.
- Spring 테스트 71개 통과.
- 정적 export와 임시 Spring API를 연결한 데스크톱·모바일 브라우저 검사 126개 모두 통과(16개 파일, 건너뛴 검사 없음).
- 배포 워크플로 단위 검사 4개 통과.
- SDK 57 호환성 검사 통과.
- 웹·iOS·Android export 성공. 생성한 번들·JAR은 커밋하지 않는다.
- 새 회귀 검사는 입력 설명/오류/키보드, 긴 차량명과 선택 상태, 미적용/취소/적용/차량·견적 전환, 오프라인 결과 위치, 시각 역행 후 기록 보존과 1회 저장을 확인한다.
- CI의 정적 웹+임시 Spring API 검사에 새 회귀와 기존 가입·AI 상담 검사를 추가했다.
- 통합 실행기가 카탈로그의 계정 저장 검사에도 같은 임시 서버 주소를 제공하도록 연결했다.
- 360px 오프라인 분석 영역의 적용 완료·입력 오류 상태에서 axe WCAG 2 A/AA 및 2.1 A/AA 위반 0건. [검사 범위와 결과](evidence/2026-11-09/fe-test-ui-port/accessibility.json)는 해당 영역 두 상태로 한정한다.

실행 명령:

```sh
npm run check
JAVA_HOME=/usr/lib/jvm/java-17-openjdk npm run check:backend
JAVA_HOME=/usr/lib/jvm/java-17-openjdk npm run build:backend
node --test scripts/test-deploy-workflow.cjs
npx expo install --check
CI=1 EXPO_NO_DOTENV=1 EXPO_NO_TELEMETRY=1 npx expo export --platform all --max-workers 2
DRIVEMATE_WEB_STATIC=1 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:integrated -- --workers=2
```

검토한 예시 화면:

- [데스크톱 홈](evidence/2026-11-09/fe-test-ui-port/home-desktop.png)
- [360px 차량 선택](evidence/2026-11-09/fe-test-ui-port/vehicle-picker-360.png)
- [360px 분석 적용 완료와 결과 이동](evidence/2026-11-09/fe-test-ui-port/offline-applied-360.png)
- [360px 첫 입력 오류 포커스](evidence/2026-11-09/fe-test-ui-port/offline-invalid-360.png)

검사는 합성 계정·센서·API 응답 또는 임시 H2 서버를 사용하며 실제 유료 AI·모델 정확도·실차 GPS·운영 배포를 검증한 결과와 구분한다. 번들 생성은 모바일 실기기 시험이 아니다.
