# Android 내부 설치용 APK

DriveMate는 Expo 57 / React Native 0.86.3 소스로 Android 앱과 웹 화면을 함께 만듭니다. 이 APK는 JavaScript 화면을 포함하는 `release` 빌드이며, 설치 후 PC나 Metro 개발 서버 없이 실행합니다. 기본 API 주소는 `https://d2a3l7qimjk3ir.cloudfront.net`입니다.

서명은 Expo가 생성한 **내부 테스트용 debug 키**입니다. Play Store 배포용 서명이나 새 개발자 계정을 만들지 않았습니다. APK와 서명 파일은 Git에 올리지 않습니다. 별도 빌드 환경에서 생성한 debug 키가 다르면 기존 앱 위에 업데이트 설치할 수 없으므로, 배포용 앱은 추후 별도의 안전한 서명 키 관리가 필요합니다.

## 빌드 조건

| 항목                 | 설정                                                |
| -------------------- | --------------------------------------------------- |
| 앱 ID / 버전         | `com.cloudprojectmobility.drivemate` / `1.0.0`      |
| 최소 Android         | API 24 / Android 7.0                                |
| compile / target SDK | API 36                                              |
| 포함 ABI             | `arm64-v8a`, `x86_64`                               |
| 도구                 | Node.js 24, JDK 21, Gradle wrapper 9.3.1            |
| Android 도구         | Build Tools 36.0.0, NDK 27.1.12297006, CMake 3.22.1 |

일부 네이티브 의존성은 Build Tools 35.0.0도 설치합니다. `app.json`은 화면 위에 표시하는 권한과 외부 저장소 읽기·쓰기 권한을 차단합니다. 위치 측정과 알림은 앱 기능에서 필요한 시점에 사용자 허용을 받습니다.

## 다시 만들기

공개 소스만 있는 작업 폴더에서 실행합니다. API 비밀키, `.env` 파일, 원본 자료, 모델, 계정 비밀번호를 앱 빌드에 넣지 않습니다. Android SDK와 라이선스를 준비하고 `JAVA_HOME` / `ANDROID_HOME`을 해당 설치 경로로 설정합니다.

```bash
npm ci
export EXPO_NO_DOTENV=1
export EXPO_NO_TELEMETRY=1
export CI=1
export EXPO_PUBLIC_API_BASE_URL=https://d2a3l7qimjk3ir.cloudfront.net
npx expo prebuild --platform android --no-install
cd android
./gradlew :app:assembleRelease --no-daemon --max-workers=2 \
  -PreactNativeArchitectures=arm64-v8a,x86_64
```

Windows PowerShell에서는 `export NAME=value` 대신 `$env:NAME='value'`, `./gradlew` 대신 `./gradlew.bat`를 사용합니다. 생성 파일은 `android/app/build/outputs/apk/release/app-release.apk`입니다. 생성된 native 폴더나 debug keystore를 공개 저장소에 추가하지 않습니다.

GitHub [Actions](https://github.com/cloud-project-mobility/make_drive_mate/actions)의 `android-apk.yml` 워크플로도 같은 빌드를 수행합니다. 워크플로 파일 자체의 변경 시 실행하며, 이후 앱 소스 변경분은 `Run workflow`로 명시적으로 빌드합니다. 성공한 실행에서 APK, SHA-256 목록, 빌드 요약을 artifact로 받아 사용하며 보관 기간은 7일입니다. 실행 성공 여부는 해당 Actions 기록으로 확인합니다.

검사에는 Android SDK의 `apksigner verify --verbose`와 `aapt dump badging`, `aapt dump permissions`를 사용합니다. APK의 `assets/index.android.bundle` 존재 및 AWS HTTPS 주소 포함을 확인하고, 압축을 푼 각 항목에 보관된 서버 비밀값의 UTF-8/UTF-16 원문이 없는지도 별도로 대조합니다.

## UI 03 빌드와 검증

2026-11-05 KST [UI 03 APK 실행](https://github.com/cloud-project-mobility/make_drive_mate/actions/runs/41861259652)의 빌드·검사·산출물 업로드·정리 단계가 모두 성공했습니다. 소스는 `9c50cfc982f7ca0fc8e87213b55a687fbfc37956`이며 현재 AWS에 배포한 UI 03과 같습니다. 확인 시점에는 GitHub의 작업 전체 상태가 `in_progress`로 남아 있어 전체 실행 완료 판정과 단계·산출물 검증을 구분합니다.

| 산출물  | 값                                                                 |
| ------- | ------------------------------------------------------------------ |
| 파일    | `drivemate-internal-release.apk`                                   |
| 크기    | 84,127,008바이트, 약 80.2MiB                                       |
| SHA-256 | `7d36a11df66ecb8c9f3569651b0ff3694db0a89ec845b7ab075d04e7e50a77bb` |

다운로드 ZIP의 GitHub 제공 SHA-256·크기와 APK의 빌드 요약을 대조했습니다. 서명, 비디버깅 release 설정, 앱 ID, 최소·대상 SDK, 두 ABI, 차단 권한 제거, 내장 JavaScript와 AWS 주소 검사가 통과했습니다. 압축 내부 1,304개 항목에서 보관된 서버 비밀값의 UTF-8/UTF-16 원문은 검출되지 않았습니다. 이는 검사한 값의 부재 확인이며 모든 형태의 정보 유출 가능성을 보장하는 검사는 아닙니다.

이전 APK와 앱 ID·서명 인증서가 같고 `versionCode`는 둘 다 `1`입니다. 실제 업데이트 설치를 시험한 것은 아닙니다. 새 APK를 실기기나 에뮬레이터에 설치하지 않았으며, 앱에서의 로그인·외부 API·GPS·알림·카카오맵 전환은 별도 확인이 필요합니다. 웹의 실제 상담 호출 성공을 Android 실행 검증으로 대신하지 않습니다. APK와 함께 제공한 `verification.json`, `secret-scan.json`, `signing-comparison.json`에 검사 범위를 기록했습니다.

## 이전 빌드 검증 기록

2026-11-04 [APK 빌드 실행](https://github.com/cloud-project-mobility/make_drive_mate/actions/runs/41839693866)이 성공했습니다. 소스는 `76ae3787a864d373c7ad333efa7a6f56807c5d9e`입니다.

| 산출물  | 값                                                                 |
| ------- | ------------------------------------------------------------------ |
| 파일    | `drivemate-internal-release.apk`                                   |
| 크기    | 84,085,088바이트, 약 80.2MiB                                       |
| SHA-256 | `cb909e2e62ff516f1c0550b6db279885fe7be930eb121078d5c3a1392161c7cd` |

다운로드 후 서명, 비디버깅 release 설정, 앱 ID, SDK·ABI, 권한 제거와 내장 AWS 주소를 확인했습니다. 압축 내부 1,304개 항목에서 보관된 서버 키와 초기 비밀번호의 UTF-8/UTF-16 원문이 검출되지 않았습니다.

Android API 37 x86_64 에뮬레이터에서 인터넷을 끈 뒤 설치·실행했고, 앱 프로세스 유지와 DriveMate 랜딩 화면 렌더링을 확인했습니다. 다만 두 번 모두 Android의 **System UI 응답 지연 경고**가 화면을 덮었습니다. 앱 자체의 크래시 증거는 수집한 제한된 로그에서 관찰되지 않았지만, 경고 없는 첫 화면 확인이 완료된 것으로 기록하지 않습니다. 경고창을 조작하지 않았으며 검증용 에뮬레이터와 ADB를 종료했습니다.

이 결과와 화면 이미지는 APK와 함께 제공하는 `verification.json` 및 검증 폴더에 기록했습니다. 실제 Android 휴대전화에서의 설치, 위치 수신, 알림 및 배터리 동작은 별도 확인이 필요합니다. APK에서 실제 서비스 로그인이나 외부 API 호출, 비밀번호 변경을 수행하지 않았습니다.

## 현재 기능 범위

동일 계정의 다른 기기로 위치를 중계하는 WebSocket 화면은 현재 **웹 전용**입니다. Android APK에 해당 기능을 추가한 것으로 안내하지 않습니다. 카카오 웹 지도 SDK를 네이티브 지도 SDK로 전환하지 않았습니다. 이동 계획의 **카카오맵에서 길안내**는 출발·도착 좌표가 있으면 카카오맵 자동차 경로를 열고, 좌표가 없으면 목적지 검색으로 연결합니다. DriveMate 내부의 음성·회전 안내는 제공하지 않습니다. 현대 차량 정보는 연결 준비 단계이며 실차 API 구현·차량 동의·실검증은 미완료입니다.

## 설치·접속

1. 위 성공한 GitHub Actions 실행의 artifact ZIP을 내려받고 APK를 추출합니다.
2. APK를 Android 휴대전화에 복사해 엽니다. 운영체제에서 별도 설치 허용을 요청하면 사용자가 직접 판단해 설정합니다.
3. 처음에는 **계정 만들기 → 내 차 등록**으로 진행합니다. 예시 차량으로 둘러보기를 시작했다면 **로그인 및 설정**에서 로그인·가입할 수 있습니다. 소유자 계정의 최초 비밀번호는 [계정 접근 안내](ACCOUNT-ACCESS.md)에 따라 사용자가 나중에 직접 설정합니다.

공식 참고: [Expo APK](https://docs.expo.dev/build-reference/apk/), [Expo 로컬 배포 빌드](https://docs.expo.dev/guides/local-app-production/), [Android SDK 도구](https://developer.android.com/tools/sdkmanager), [Android 빌드 JDK](https://developer.android.com/build/jdks).
