# DriveMate maintenance notes

- The app is React Native / Expo SDK 57. Preserve iOS, Android, and web compatibility. Use `npx expo install` with versions matching SDK 57 for native packages.
- User-facing copy is Korean. Keep sample data, estimated routes, local storage, and disconnected integrations explicit. Never simulate a successful cloud login or a live GPS fix.
- Business invariants live in `src/domain/`; UI must use `useApp` and validated actions. Never mutate state directly or start GPS without a user action.
- Root owns the recording lifecycle so navigation cannot silently lose a session. Background transitions pause recording. Completed trip distance is added to its bound vehicle once.
- When removing plans or vehicles, cancel associated native notifications before deleting data. Restore/reset require explicit confirmation and cannot replace an active recording.
- Keep decorative icons hidden from accessibility. Provide text labels and at least 44px interactive targets. Verify 360px and desktop layouts.
- Run `npm run check`, relevant Playwright cases, and Expo export after material changes. Do not claim native device verification from browser tests or bundle export alone.
- Preserve source provenance and evidence in `docs/`. Do not commit generated bundles, credentials, local data, or test traces with private user input.
- Google Calendar is account-scoped, read-only event import. Keep OAuth credentials and tokens server-side; callback pages must never echo callback parameters or raw provider errors. Use the exact `/api/v1/integrations/google/callback` redirect path. Follow `docs/implementations/google-calendar/README.md` for the integration contract.
- Reuse `src/screens/GoogleCalendar.tsx` for Calendar connection controls. Preserve account/server remounting, stale-response guards, foreground status refresh, and explicit user selection before importing an event.

- Keep Expo SDK patch dependencies and `package-lock.json` aligned with `npx expo install --check`. Fix compatibility failures with SDK-matched patch updates; do not bypass the CI check or exclude mismatched packages.
