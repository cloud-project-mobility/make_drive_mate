import { BackendClient, BackendError } from './backend';

export interface LivePosition {
  source_id: string;
  latitude: number;
  longitude: number;
  accuracy_m: number;
  observed_at: string;
  received_at: string;
}
export type LocationMessage =
  | (LivePosition & { type: 'position' })
  | { type: 'ready'; source_id: string }
  | { type: 'stopped'; source_id: string };
export const LOCATION_TTL_MS = 30_000;

function instant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
export function parseLocationMessage(raw: unknown, now = Date.now()): LocationMessage | null {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.source_id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.source_id)
  )
    return null;
  if (value.type === 'ready' || value.type === 'stopped')
    return { type: value.type, source_id: value.source_id };
  if (
    value.type !== 'position' ||
    typeof value.latitude !== 'number' ||
    !Number.isFinite(value.latitude) ||
    Math.abs(value.latitude) > 90 ||
    typeof value.longitude !== 'number' ||
    !Number.isFinite(value.longitude) ||
    Math.abs(value.longitude) > 180 ||
    typeof value.accuracy_m !== 'number' ||
    !Number.isFinite(value.accuracy_m) ||
    value.accuracy_m < 0 ||
    value.accuracy_m > 10_000 ||
    !instant(value.observed_at) ||
    !instant(value.received_at) ||
    now - Date.parse(value.received_at) > LOCATION_TTL_MS ||
    Date.parse(value.received_at) - now > 30_000 ||
    now - Date.parse(value.observed_at) > 120_000 ||
    Date.parse(value.observed_at) - now > 30_000
  )
    return null;
  return value as unknown as LocationMessage;
}

export function locationSocketUrl(apiBase: string, pageOrigin?: string): string {
  const base = new URL(apiBase);
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/')
    throw new Error('invalid_origin');
  if (pageOrigin) {
    const page = new URL(pageOrigin);
    if (page.protocol === 'https:' && page.origin !== base.origin)
      throw new Error('same_origin_required');
  }
  if (base.protocol === 'https:') base.protocol = 'wss:';
  else if (base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
    base.protocol = 'ws:';
  else throw new Error('secure_connection_required');
  base.pathname = '/api/v1/location/stream';
  return base.toString();
}

export async function locationTicket(client: BackendClient) {
  const value = await client.request<{ ticket?: unknown; expires_at?: unknown }>(
    '/location/ticket',
    { method: 'POST' },
  );
  if (
    !value ||
    typeof value.ticket !== 'string' ||
    !/^[A-Za-z0-9_-]{20,256}$/.test(value.ticket) ||
    !instant(value.expires_at) ||
    Date.parse(value.expires_at) <= Date.now()
  ) {
    throw new BackendError('위치 연결 인증을 확인하지 못했어요. 다시 연결해 주세요.');
  }
  return value.ticket;
}

export function locationErrorMessage(reason: string) {
  if (reason === 'permission_denied')
    return '위치 권한이 거부됐어요. 브라우저 사이트 설정에서 허용한 뒤 다시 시작해 주세요.';
  if (reason === 'timeout')
    return '위치 확인 시간이 초과됐어요. 위치 서비스와 신호를 확인한 뒤 다시 시작해 주세요.';
  if (reason === 'insecure_context') return '위치 전송에는 HTTPS 또는 localhost 연결이 필요해요.';
  return '기기 위치를 확인할 수 없어 전송을 멈췄어요. 위치 서비스와 브라우저 설정을 확인해 주세요.';
}
