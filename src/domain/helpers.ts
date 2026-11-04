import type { TripPlan } from './types';

let sequence = 0;
/** IDs are local identifiers, not authentication credentials. */
export function createId(prefix = 'id'): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.randomUUID) return `${prefix}_${cryptoObject.randomUUID()}`;
  sequence += 1;
  return `${prefix}_${Date.now().toString(36)}_${sequence.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export type NumberResult = { ok: true; value: number } | { ok: false; error: string };

/** Accept a decimal number, not Number('') == 0, scientific notation, or malformed commas. */
export function parseNonNegativeNumber(raw: string, label = '값', max = 2_000_000): NumberResult {
  const text = raw.trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) {
    return { ok: false, error: `${label}에 0 이상의 숫자를 입력해 주세요.` };
  }
  const value = Number(text.replace(/,/g, ''));
  if (!Number.isFinite(value) || value > max)
    return { ok: false, error: `${label}은 ${max.toLocaleString('ko-KR')} 이하여야 해요.` };
  return { ok: true, value };
}

export function departureAt(
  plan: Pick<TripPlan, 'eventAt' | 'driveMinutes' | 'walkMinutes' | 'bufferMinutes'>,
): Date | null {
  if (!plan.eventAt) return null;
  const timestamp = Date.parse(plan.eventAt);
  const minutes = [plan.driveMinutes, plan.walkMinutes, plan.bufferMinutes];
  if (!Number.isFinite(timestamp) || minutes.some((value) => !Number.isFinite(value) || value < 0))
    return null;
  return new Date(timestamp - minutes.reduce((total, value) => total + value, 0) * 60_000);
}

/** A full local date is required; this prevents silently choosing the wrong day. */
export function parseLocalDateTime(dateText: string, timeText: string): Date | null {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText.trim());
  const time = /^(\d{2}):(\d{2})$/.exec(timeText.trim());
  if (!date || !time) return null;
  const [, year, month, day] = date.map(Number);
  const [, hour, minute] = time.map(Number);
  const value = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    value.getFullYear() !== year ||
    value.getMonth() !== month - 1 ||
    value.getDate() !== day ||
    value.getHours() !== hour ||
    value.getMinutes() !== minute
  )
    return null;
  return value;
}

export function formatDistance(value: number): string {
  return value.toLocaleString('ko-KR', { maximumFractionDigits: 1 });
}

export function formatDateTime(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return date.toLocaleString('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
