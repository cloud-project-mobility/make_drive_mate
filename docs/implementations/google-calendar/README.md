# Google Calendar integration

DriveMate connects a user's primary Google Calendar with the single `calendar.events.readonly` permission. Google authorization is separate from DriveMate login. A selected event is copied into a local travel plan; later Google changes do not automatically update that plan, and DriveMate does not write events to Google.

The Spring backend owns OAuth state, PKCE, encrypted access/refresh tokens, refresh and revocation. Authorization returns a Google consent URL. The exact registered redirect is `/api/v1/integrations/google/callback` on the API's public origin (HTTPS, or HTTP loopback for local development). Query strings, fragments, credentials in the URL, and other paths are rejected as configuration errors.

The callback renders a Korean success or recovery page with a meaningful HTTP status, no caching, no referrer, and no scripts or external resources. It never reflects the authorization code, state, or raw provider response. Users return to the original app window, preserving the app's in-memory login. A new login flow or arbitrary callback redirect would introduce a separate identity/navigation contract and is deliberately not used.

Calendar retrieval follows pagination even when a page has no `items`, distinguishes malformed explicit collections from omitted empty collections, preserves all-day dates and timed-event instants, and excludes cancelled events. Google event locations remain free text until the user selects a route destination.

Reference: [Google web-server authorization](https://developers.google.com/identity/protocols/oauth2/web-server), [Calendar event listing](https://developers.google.com/workspace/calendar/api/v3/reference/events/list).

The settings and Calendar planning screens share `GoogleCalendar.tsx`. It distinguishes logged-out, disabled, mock, unconfigured, disconnected, connected and event-query outcomes. Returning to the foreground checks connection status; explicit refresh remains available. User-selected import preserves timed instants and all-day dates, while missing location/time requires manual input. Lists and authorization URLs are cleared on account/server changes, disconnect, refresh and new requests; obsolete responses cannot update the active view.

## Configuration and ownership

The dedicated Google Cloud project is `drivemate-calendar-20261109` (DriveMate Calendar), with the web client **DriveMate Calendar Web**. Calendar API is enabled, the app is in External / Testing mode, and the initially authorized tester is registered in the Google Auth Platform audience. Additional testers must be added explicitly. Production publication and Google verification have not been performed.

Registered callbacks:

- Local verification: `http://127.0.0.1:18085/api/v1/integrations/google/callback`
- Intended production origin: `https://d2a3l7qimjk3ir.cloudfront.net/api/v1/integrations/google/callback`

The repository's GitHub Actions secrets contain `DRIVEMATE_GOOGLE_CLIENT_ID`, `DRIVEMATE_GOOGLE_CLIENT_SECRET`, and `DRIVEMATE_GOOGLE_REDIRECT_URI`. The redirect secret is the production URL above; local verification overrides it with the registered loopback URL. This is secure storage for future deployment wiring, **not an update to the running ECS service**. Pull-request CI must remain independent of these credentials.

A future deployment must inject those three settings into Spring's runtime environment, set `DRIVEMATE_PROVIDER_MODE=live`, and provide the runtime's existing `DRIVEMATE_TOKEN_ENCRYPTION_KEY`. Spring expects a URL-safe Base64 encoding of 32 random bytes and encrypts grants with AES-GCM bound to the account. Preserve the deployed encryption key; replacing it makes existing encrypted grants unreadable. The live verification used a disposable database and an ephemeral key, not the production key. Never put Google secrets/tokens in `EXPO_PUBLIC_*`, web bundles, Git, PR text, or CI logs. GitHub secret existence alone does not configure AWS Secrets Manager or ECS.

## Repeatable automated verification

Use Java 17+ and the Node version specified by CI. Run from the repository root:

```sh
sh backend-spring/mvnw -f pom.xml -B verify
npm ci
npx expo install --check
npm run check
EXPO_NO_DOTENV=1 npm run export:web
DRIVEMATE_WEB_STATIC=1 npm run test:integrated -- tests/e2e/backend.spec.ts
DRIVEMATE_WEB_STATIC=1 npm run test:integrated -- tests/e2e/google-calendar.spec.ts
```

Each integrated invocation creates and cleans up a fresh Spring/H2 test backend. CI runs Calendar in its own invocation so automated sign-ups do not exhaust the unchanged production authentication rate limit. To run the entire browser suite without retries, use separate disposable backends for the two projects:

```sh
DRIVEMATE_WEB_STATIC=1 npm run test:integrated -- --project=desktop-chromium --retries=0
DRIVEMATE_WEB_STATIC=1 npm run test:integrated -- --project=mobile-chromium --retries=0
```

The local port registry reserves TCP 18085 for manual Spring verification, 18086 for the disposable integrated API, and 18087 for the exported web app. Check both registry ownership and listeners before launch. Stop on a conflict; never select a fallback port. The integrated runner stops its task-owned API/web processes automatically. Keep API credentials out of the isolated test runner, which intentionally clears provider settings.

`GoogleCalendarApiTest` uses real Spring controllers, DriveMate authentication, SQL state and encryption; only Google transport is replaced. Browser Calendar fixtures use the real app and DriveMate login while replacing Google-related HTTP endpoints. Neither establishes live-account access. Existing provider tests cover token races, malformed responses, scopes, pagination, all-day dates and time zones; browser regression also checks the repeated DST hour.

## Manual live-account verification

Use a separate disposable DriveMate account/database, with the registered OAuth client settings loaded privately into the backend process environment. Do not print or commit their values. Set the loopback redirect and `DRIVEMATE_CORS_ORIGINS=http://127.0.0.1:18087,http://localhost:18087`, then launch the Spring JAR on 127.0.0.1:18085. Serve the exported app with:

```sh
DRIVEMATE_LOCAL_API_TARGET=http://127.0.0.1:18085 node scripts/serve-web-test.cjs 18087
```

1. Open `http://127.0.0.1:18087`, use sample vehicles, and sign into the disposable DriveMate account.
2. Open **계정 및 설정 → 외부 서비스 연결 → Google 캘린더 연결 준비 → Google 인증 화면 열기**.
3. Approve only the displayed Calendar event read permission for an authorized test user. Return to the original DriveMate tab; the account session stays in memory and connection status refreshes.
4. Open **이동 계획 → 일정으로 계획 → Google 캘린더 일정 불러오기**. An empty primary calendar is a successful empty result. For non-empty cases, select an event, supply any missing time/location, review the plan, and save only when intended. This does not edit Google Calendar.
5. Disconnect with **Google 캘린더 연결 해제 → Google 연결 해제 확정**. Confirm the list disappears and DriveMate login/local plans remain. A remote revocation failure must be reported separately from successful local removal.
6. Stop the two task-owned foreground processes with Ctrl-C. Remove only the disposable test data; keep the OAuth client available for future authorized use.

## Observed evidence · 2026-11-09

The real-account check used the exported web UI, the Spring JAR, and the new web OAuth client at 14:55–14:56 Asia/Seoul (05:55–05:56 UTC). Consent returned the Korean success callback; returning to the original tab showed the connected account. The primary Calendar query returned HTTP 200 with `source=live` and **zero upcoming events**. The UI showed the empty-calendar guidance. The test did not create or modify Google events, and no event titles, locations, tokens or personal account identifiers are recorded here.

UI disconnect reported successful revocation. A subsequent status call returned `connected=false`, Calendar access returned HTTP 409 / `google_not_connected`, and the DriveMate account endpoint still returned HTTP 200. The temporary API and web services were stopped and their listeners were absent. The one-off test does not change the application's persistent `live_verified` status flag.

Automated coverage passed 80 Spring tests, 106 frontend tests plus TypeScript/lint, and 130 browser scenarios without retries (65 desktop + 65 mobile). Two pre-existing opt-in vehicle-catalog scenarios were skipped, one per viewport. Web, iOS and Android bundle exports passed; bundle export does not exercise physical-device behavior. Local tests used Node 22.23.2 / Java 21, while GitHub CI uses Node 24 / Java 17. The initial combined browser run hit the sign-up rate limit; separate fresh backends resolved that test-isolation issue. A viewport measurement now waits for React Native's asynchronous dimension update instead of reading an intermediate layout. The integrated runner waits for Node's child-exit state during cleanup; this avoids macOS errors from probing a disappearing process group after successful assertions.

After the initial CI run exposed five outdated SDK 57 patches, the prerequisite compatibility PR updated those patches without disabling the gate. Final dependency-aligned validation is recorded in [the evidence record](verification-2026-11-09.json). Real consent was checked before that dependency-only update; Calendar application/backend behavior was unchanged by it.

Limits: non-empty real Google imports and naturally expired real-token refresh were not observed in this account; those paths have synthetic integration coverage. No iOS/Android physical-device test, public Google verification, production deployment, or PR merge is claimed. Existing unrelated Hyundai work remains separate.
