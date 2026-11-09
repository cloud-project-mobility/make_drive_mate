# Google Calendar integration

DriveMate connects a user's primary Google Calendar with the single `calendar.events.readonly` permission. Google authorization is separate from DriveMate login. A selected event is copied into a local travel plan; later Google changes do not automatically update that plan, and DriveMate does not write events to Google.

The Spring backend owns OAuth state, PKCE, encrypted access/refresh tokens, refresh and revocation. Authorization returns a Google consent URL. The exact registered redirect is `/api/v1/integrations/google/callback` on the API's public origin (HTTPS, or HTTP loopback for local development). Query strings, fragments, credentials in the URL, and other paths are rejected as configuration errors.

The callback renders a Korean success or recovery page with a meaningful HTTP status, no caching, no referrer, and no scripts or external resources. It never reflects the authorization code, state, or raw provider response. Users return to the original app window, preserving the app's in-memory login. A new login flow or arbitrary callback redirect would introduce a separate identity/navigation contract and is deliberately not used.

Calendar retrieval follows pagination even when a page has no `items`, distinguishes malformed explicit collections from omitted empty collections, preserves all-day dates and timed-event instants, and excludes cancelled events. Google event locations remain free text until the user selects a route destination.

Reference: [Google web-server authorization](https://developers.google.com/identity/protocols/oauth2/web-server), [Calendar event listing](https://developers.google.com/workspace/calendar/api/v3/reference/events/list).

The settings and Calendar planning screens share `GoogleCalendar.tsx`. It distinguishes logged-out, disabled, mock, unconfigured, disconnected, connected and event-query outcomes. Returning to the foreground checks connection status; explicit refresh remains available. User-selected import preserves timed instants and all-day dates, while missing location/time requires manual input. Lists and authorization URLs are cleared on account/server changes, disconnect, refresh and new requests; obsolete responses cannot update the active view.
