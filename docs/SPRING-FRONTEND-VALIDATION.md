# Spring 연결 화면 검증 · 2026-11-04

## 구현 범위

- 기본 HTTP 서버 실행/검증 명령을 Spring JAR로 전환했다. Python은 데이터·모델 작업에 사용한다.
- 가치 화면에 실제 공매 모델 요청, 데이터 품질·모델 평가 집계, 문서 근거 검색 카드를 연결했다.
- 공매 낙찰가와 소비자 시세를 구분하고, 전체 시험 평균 오차와 제공 조건을 충족한 부분집합 오차·제공률을 함께 표시한다.
- 기존 합성 가격 계산은 `오프라인 가정 계산`으로 분리했다.
- 문서 카드는 계획/보고서 내용/공식 출처/현재 코드 확인 상태를 구분한다. 원본 파일 경로를 화면에 노출하거나 다운로드 링크로 만들지 않는다. 403은 허용 계정 안내로 처리한다.
- 문서 검색 자체의 임베딩 비용과 GPT 추가 호출, 서버 전체 하루 20회 공유 한도를 안내한다.
- HTTPS 웹은 환경 변수 미지정 시 같은 출처의 API를 사용한다. 모바일·로컬 실행의 기본 주소는 별도로 관리한다.
- 서버/계정/차량이 바뀌면 이전 분석 결과와 입력 범위를 초기화한다.

## 실행한 검사

- 공식 Node 24.22.2 Linux 배포본을 SHA-256 검증 후 설치했다. 애플리케이션 의존성은 기존 잠금 파일로 `npm ci`를 실행했다.
- `npm run check`: TypeScript, ESLint, 도메인/경계 검사 **76개 통과**.
- 추가한 정적 미리보기 스크립트와 최종 변경 검증 파일도 개별 ESLint/TypeScript 검사 통과.
- `npm run export:web`: **성공**. 최신 실제 화면 974개 모듈을 포함한다.
- Spring 실제 HTTP + 정적 배포본 + Chromium에서 `backend.spec.ts`, `valuation.spec.ts`, `onbid.spec.ts` **34개 시나리오**를 검증했다. 전체 실행에서 33개 통과 후, 화면 크기 전환 중 숨겨지는 모바일 탭을 선택하던 1개 테스트의 표시 대기를 수정했다. 이후 관련 `onbid.spec.ts` **10개 모두 통과**하여 해당 실패도 해소했다.
- 360px/1440px에서 수평 넘침, 44px 이상 주요 버튼, 계정 로그아웃 후 결과 제거, 원/만원 단위, 잘못된 분석 응답 거부, 문서 접근 권한 안내를 확인했다.
- 가격·문서·집계 UI 응답은 명시적인 합성 계약 fixture를 사용했다. 이 테스트는 모델 정확도·실제 문서 검색 품질의 증거가 아니며 유료 LLM/임베딩을 호출하지 않는다. 계정·백업·외부 연동 mock은 실제 Spring HTTP를 사용했다.

재현 명령(Linux/WSL, Node 24 + Java 17 이상):

```sh
npm ci
npm run build:backend
npm run check
npm run export:web
DRIVEMATE_WEB_STATIC=1 npm run test:integrated -- tests/e2e/backend.spec.ts tests/e2e/valuation.spec.ts tests/e2e/onbid.spec.ts --workers=2
```

Chromium 설치가 필요하면 `npx playwright install chromium`을 실행한다. 이번 검증에서는 설치된 Chrome을 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome`으로 지정했다. 정적 검증 서버는 `127.0.0.1:18087`, 임시 Spring 서버는 `127.0.0.1:18086`이며 종료 후 임시 DB와 프로세스를 정리한다. 정적 서버는 `/settings` 같은 SPA 경로 새로고침에 `index.html`을 제공한다.

## 개발 서버 파일 경계

개발 번들이 루트의 서버용 `.env` 파일을 변환하면서 실패하고, 진단 응답에 파일 내용이 포함되는 현상을 관측했다. Router 경로는 `src/app`으로 설정되어 있었다. Metro resolver의 `blockList`에 비밀 파일 및 서버·문서·도구 폴더를 명시하고 직접 HTTP 접근도 별도로 차단했다. 구성 방식은 [Expo Metro 안내](https://docs.expo.dev/versions/latest/config/metro/)와 [Metro blockList 설정](https://metrobundler.dev/docs/configuration/#blocklist)을 따른다.

- 수정 후 개발 번들 200 응답과 첫 화면 렌더링을 확인했다.
- `.env` 원본/번들 URL 및 backend 경로 요청은 404로 확인했다. 인코딩된 경로 차단도 회귀 검사한다.
- 개발 번들과 최종 `dist`에서 실제 인증키 문자열을 검색한 결과 0건이었다. 검사 결과에는 키 값을 출력하지 않았다.
- 이후 개발 검증 서버는 `--localhost`로 실행하고 `127.0.0.1` 바인딩을 확인했다. 이전 개발 서버의 외부 접근자 부재는 접근 로그가 없어 증명하지 않는다.
- 개발 서버 지연으로 글꼴 로딩에 22초가 걸리고 Expo의 12초 타임아웃이 발생한 실행은 성공으로 집계하지 않았다. 최종 UI 검증은 생성된 배포 파일을 제공하는 정적 서버에서 수행했다.

## 남은 검증 경계

브라우저 검증과 웹 export는 iOS/Android 실기기 검증이 아니다. Google/Kakao의 실계정 호출과 현대 실차 연결을 검증했다고 주장하지 않는다. 문서 검색의 실데이터 임베딩·회수 품질과 모델 성능은 별도 데이터/모델/RAG 보고서에서 확인한다.

## 추가 차량 기능을 포함한 통합본 재검증

2026-11-04 06:55 UTC에 다른 사용자가 추가한 차량 카탈로그·서버 차량 화면을 포함한 현재 소스를 다시 검사했다. 기존 배포 entry 생성 시각은 06:24 UTC, 최신 차량 카탈로그 소스는 06:52 UTC여서 배포본이 오래된 상태였다. 다른 사용자 소스는 수정하지 않았다.

- Node 24에서 `npm run check`: TypeScript·ESLint·**90개 테스트 통과**.
- `npm run export:web`: **986개 모듈, 37개 파일, 22,879,233바이트**, 성공.
- 생성된 entry: `entry-a5f1b3bb83a41a7ec953a8adb5dcc382.js`.
- 해당 entry SHA-256: `5f4153b3282cb12da4c12a861575db8f74888afef733ca2bd9540808597d8f1b`.
- 생성 직후 소스 수정 시각보다 최신임을 확인했고, 실제 키 문자열 검사 결과는 0건이었다.

배포 담당자에게 새 `dist`로 최종 산출물을 재패키징하도록 전달했다. 위의 34개 브라우저 시나리오는 초기 연결 화면 검증이며, 이번 추가 차량 기능의 실제 배포 브라우저 검증까지 대신하지 않는다.
