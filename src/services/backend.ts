import type { AppState, Powertrain } from '../domain/types';
import { isAppState } from '../domain/state';

export type ProviderSource = 'mock' | 'live';
export interface BackendUser {
  id: string;
  email: string;
}
export interface BackendSession {
  access_token: string;
  token_type: 'bearer';
  user: BackendUser;
  expires_at: string;
}
export interface BackendHealth {
  status: 'ok';
  provider_mode: 'mock' | 'disconnected' | 'live';
}
export interface ServerSnapshot {
  revision: number;
  state: AppState | null;
  updated_at: string | null;
}
export interface Place {
  id: string;
  name: string;
  address: string;
  longitude: number;
  latitude: number;
}
export interface RouteEstimate {
  source: ProviderSource;
  distance_m: number;
  duration_s: number;
  departure_at: string;
  arrival_at: string;
  computed_at: string;
  expires_at: string;
}
export interface CalendarEvent {
  id: string;
  title: string;
  start_at: string | null;
  end_at: string | null;
  start_date: string | null;
  end_date: string | null;
  all_day: boolean;
  location: string | null;
}
export interface VehicleStatus {
  source: ProviderSource;
  odometer_km: number;
  range_km: number | null;
  battery_percent: number | null;
  warnings: Record<string, boolean>;
  observed_at: string | null;
  provider_timestamp_raw?: string;
  provider_timezone?: string | null;
  received_at: string;
}
export interface IntegrationStatus {
  provider_mode: 'mock' | 'disconnected' | 'live';
  providers: Record<
    'kakao' | 'google_calendar' | 'hyundai',
    {
      mode: 'mock' | 'disconnected' | 'live';
      configured: boolean;
      connected: boolean;
      live_verified: boolean;
      auth_type?: string;
      requires_user_consent?: boolean;
      reason?: string;
      capabilities?: Record<'places' | 'routes', {
        configured: boolean;
        live_verified: boolean;
        last_verified_at: string | null;
      }>;
    }
  >;
}
export class BackendError extends Error {
  constructor(
    message: string,
    public readonly status = 0,
    public readonly code = 'network_error',
  ) {
    super(message);
  }
}

type ObjectData = Record<string, unknown>;
function object(value: unknown): value is ObjectData {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, max = 4000): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
function number(value: unknown, max = Number.MAX_SAFE_INTEGER, min = 0): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}
function instant(value: unknown): value is string {
  return (
    text(value, 100) &&
    /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function day(value: unknown): value is string {
  return (
    text(value, 10) &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}
function source(value: unknown): value is ProviderSource {
  return value === 'mock' || value === 'live';
}
function validPlace(value: unknown): value is Place {
  return (
    object(value) &&
    text(value.id) &&
    text(value.name) &&
    typeof value.address === 'string' &&
    number(value.longitude, 180, -180) &&
    number(value.latitude, 90, -90)
  );
}
function validEvent(value: unknown): value is CalendarEvent {
  if (
    !object(value) ||
    !text(value.id) ||
    !text(value.title) ||
    !(value.location === null || text(value.location)) ||
    typeof value.all_day !== 'boolean'
  )
    return false;
  return value.all_day
    ? value.start_at === null &&
        value.end_at === null &&
        day(value.start_date) &&
        day(value.end_date) &&
        value.end_date > value.start_date
    : instant(value.start_at) &&
        instant(value.end_at) &&
        Date.parse(value.end_at) > Date.parse(value.start_at) &&
        value.start_date === null &&
        value.end_date === null;
}
function validSnapshot(value: unknown): value is ServerSnapshot {
  return (
    object(value) &&
    number(value.revision) &&
    Number.isInteger(value.revision) &&
    (value.state === null || isAppState(value.state)) &&
    (value.updated_at === null || instant(value.updated_at))
  );
}

export function normalizeBackendUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new BackendError('서버 주소를 http:// 또는 https://로 입력해 주세요.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  )
    throw new BackendError(
      '서버 주소에는 호스트와 포트만 입력해 주세요. 계정 정보나 경로는 포함할 수 없어요.',
    );
  const host = url.hostname;
  const privateIpv4 =
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) &&
    (/^(127|10)\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host));
  const privateHttp =
    host === 'localhost' || host === '[::1]' || host.endsWith('.local') || privateIpv4;
  if (url.protocol === 'http:' && !privateHttp)
    throw new BackendError(
      'HTTP 테스트 서버는 이 기기나 같은 사설 네트워크 주소만 사용할 수 있어요. 외부 서버에는 HTTPS를 사용해 주세요.',
    );
  return url.origin;
}

export class BackendClient {
  readonly url: string;
  constructor(
    url: string,
    private readonly token?: string,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
    private onUnauthorized?: () => void,
  ) {
    this.url = normalizeBackendUrl(url);
  }
  setUnauthorizedHandler(handler: (() => void) | undefined) {
    this.onUnauthorized = handler;
  }
  async request<T>(path: string, options: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 12_000);
    try {
      const response = await this.fetcher(`${this.url}/api/v1${path}`, {
        method: options.method ?? 'GET',
        headers: {
          Accept: 'application/json',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
        credentials: 'omit',
        redirect: 'error',
      });
      if (response.status === 204) return undefined as T;
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new BackendError(
          '서버 응답을 읽지 못했어요. DriveMate API 주소인지 확인해 주세요.',
          response.status,
          'invalid_response',
        );
      }
      if (!response.ok) {
        const error = data && typeof data === 'object' && 'error' in data ? data.error : null;
        const detail =
          error && typeof error === 'object' ? (error as Record<string, unknown>) : null;
        if (response.status === 401 && this.token && detail?.code === 'unauthorized')
          this.onUnauthorized?.();
        throw new BackendError(
          typeof detail?.message === 'string'
            ? detail.message
            : `서버 요청을 처리하지 못했어요. (${response.status})`,
          response.status,
          typeof detail?.code === 'string' ? detail.code : 'server_error',
        );
      }
      return data as T;
    } catch (error) {
      if (error instanceof BackendError) throw error;
      throw new BackendError(
        controller.signal.aborted
          ? '서버 응답 시간이 초과됐어요. 서버 상태를 확인하고 다시 시도해 주세요.'
          : '서버에 연결하지 못했어요. 주소, 서버 실행 상태와 네트워크를 확인해 주세요.',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  private async validated<T>(
    path: string,
    check: (value: unknown) => value is T,
    options: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const value = await this.request<unknown>(path, options);
    let valid = false;
    try {
      valid = check(value);
    } catch {
      /* malformed data must not escape into a screen */
    }
    if (!valid)
      throw new BackendError(
        '서버 응답 형식이 올바르지 않아요. 현재 데이터는 변경하지 않았어요.',
        502,
        'invalid_response',
      );
    return value as T;
  }
  health() {
    return this.validated(
      '/health',
      (value): value is BackendHealth =>
        object(value) &&
        value.status === 'ok' &&
        ['mock', 'live', 'disconnected'].includes(String(value.provider_mode)),
    );
  }
  authenticate(mode: 'register' | 'login', email: string, password: string) {
    return this.validated(
      `/auth/${mode}`,
      (value): value is BackendSession =>
        object(value) &&
        text(value.access_token, 4096) &&
        value.token_type === 'bearer' &&
        object(value.user) &&
        text(value.user.id) &&
        text(value.user.email, 254) &&
        instant(value.expires_at),
      {
        method: 'POST',
        body: { email: email.trim(), password },
      },
    );
  }
  logout() {
    return this.request<void>('/auth/logout', { method: 'POST' });
  }
  async changePassword(currentPassword: string, newPassword: string) {
    const value = await this.request<unknown>('/auth/password', {
      method: 'POST',
      body: { current_password: currentPassword, new_password: newPassword },
    });
    if (!object(value) || value.ok !== true || value.reauthentication_required !== true)
      throw new BackendError(
        '비밀번호 변경 결과를 확인하지 못했어요. 다시 로그인해 계정 상태를 확인해 주세요.',
        502,
        'invalid_response',
      );
    return { ok: true, reauthentication_required: true } as const;
  }
  snapshot() {
    return this.validated('/state', validSnapshot);
  }
  upload(state: AppState, revision: number) {
    return this.validated('/state', validSnapshot, {
      method: 'PUT',
      body: { state, expected_revision: revision },
    });
  }
  places(query: string) {
    return this.validated(
      `/places?q=${encodeURIComponent(query.trim())}`,
      (value): value is { source: ProviderSource; places: Place[] } =>
        object(value) &&
        source(value.source) &&
        Array.isArray(value.places) &&
        value.places.length <= 100 &&
        value.places.every(validPlace),
    );
  }
  route(
    origin: Place,
    destination: Place,
    arrivalAt: string,
    walkMinutes: number,
    bufferMinutes: number,
  ) {
    return this.validated(
      '/routes',
      (value): value is RouteEstimate =>
        object(value) &&
        source(value.source) &&
        number(value.distance_m, 10_000_000) &&
        number(value.duration_s, 86400, 1) &&
        instant(value.departure_at) &&
        instant(value.arrival_at) &&
        instant(value.computed_at) &&
        instant(value.expires_at),
      {
        method: 'POST',
        body: {
          origin: { longitude: origin.longitude, latitude: origin.latitude },
          destination: { longitude: destination.longitude, latitude: destination.latitude },
          arrival_at: arrivalAt,
          walk_minutes: walkMinutes,
          buffer_minutes: bufferMinutes,
        },
      },
    );
  }
  calendar() {
    return this.validated(
      '/calendar/events',
      (value): value is { source: ProviderSource; events: CalendarEvent[] } =>
        object(value) &&
        source(value.source) &&
        Array.isArray(value.events) &&
        value.events.length <= 50000 &&
        value.events.every(validEvent),
    );
  }
  vehicleStatus(powertrain: Powertrain) {
    return this.validated(
      `/vehicles/status?powertrain=${powertrain}`,
      (value): value is VehicleStatus =>
        object(value) &&
        source(value.source) &&
        number(value.odometer_km, 10_000_000) &&
        (value.range_km === null || number(value.range_km, 10000)) &&
        (value.battery_percent === null || number(value.battery_percent, 100)) &&
        object(value.warnings) &&
        Object.values(value.warnings).every((warning) => typeof warning === 'boolean') &&
        (value.observed_at === null || instant(value.observed_at)) &&
        instant(value.received_at),
    );
  }
  integrations() {
    return this.validated(
      '/integrations',
      (value): value is IntegrationStatus =>
        object(value) &&
        ['mock', 'live', 'disconnected'].includes(String(value.provider_mode)) &&
        object(value.providers) &&
        ['kakao', 'google_calendar', 'hyundai'].every((name) => {
          const provider = (value.providers as ObjectData)[name];
          return (
            object(provider) &&
            ['mock', 'live', 'disconnected'].includes(String(provider.mode)) &&
            typeof provider.configured === 'boolean' &&
            typeof provider.connected === 'boolean' &&
            typeof provider.live_verified === 'boolean' &&
            (provider.auth_type === undefined || text(provider.auth_type, 80)) &&
            (provider.requires_user_consent === undefined || typeof provider.requires_user_consent === 'boolean') &&
            (provider.reason === undefined || text(provider.reason, 80)) &&
            (provider.capabilities === undefined || (object(provider.capabilities) &&
              ['places', 'routes'].every((capability) => {
                const value = (provider.capabilities as ObjectData)[capability];
                return object(value) && typeof value.configured === 'boolean'
                  && typeof value.live_verified === 'boolean'
                  && (value.last_verified_at === null || instant(value.last_verified_at));
              })))
          );
        }),
    );
  }
  authorizeGoogle() {
    return this.validated(
      '/integrations/google/authorize',
      (value): value is { authorization_url: string } => {
        if (!object(value) || !text(value.authorization_url, 8192)) return false;
        const url = new URL(value.authorization_url);
        return (
          url.origin === 'https://accounts.google.com' &&
          url.pathname === '/o/oauth2/v2/auth' &&
          !url.username &&
          !url.password
        );
      },
      { method: 'POST' },
    );
  }
  disconnectGoogle() {
    return this.validated(
      '/integrations/google',
      (value): value is { connected: false; provider_revoked: boolean | null } =>
        object(value) &&
        value.connected === false &&
        (value.provider_revoked === null || typeof value.provider_revoked === 'boolean'),
      { method: 'DELETE' },
    );
  }
}
export function backendMessage(error: unknown): string {
  return error instanceof Error ? error.message : '요청을 처리하지 못했어요. 다시 시도해 주세요.';
}
