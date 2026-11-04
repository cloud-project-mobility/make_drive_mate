import type { TripPlan } from './types';
/** The route result is valid only for the exact inputs and provider expiry it was computed for. */
export interface RouteInputs {
  origin: string;
  destination: string;
  arrivalAt: string | null;
  walkMinutes: number | null;
  bufferMinutes: number | null;
  selectionRevision: number;
}
export interface AppliedRoute {
  inputs: RouteInputs;
  distanceKm: number;
  expiresAt: string;
  computedAt: string;
  source: 'mock' | 'live';
}
export function mapsUrl(
  plan: Pick<TripPlan, 'origin' | 'destination' | 'originPoint' | 'destinationPoint'>,
): string {
  const origin = plan.originPoint
    ? `${plan.originPoint.latitude},${plan.originPoint.longitude}`
    : plan.origin;
  const destination = plan.destinationPoint
    ? `${plan.destinationPoint.latitude},${plan.destinationPoint.longitude}`
    : plan.destination;
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&travelmode=driving`;
}
export function routeApplicationIssue(
  applied: AppliedRoute | null,
  current: RouteInputs,
  now: number,
): string | null {
  if (!applied) return null;
  const before = applied.inputs;
  if (
    before.origin !== current.origin ||
    before.destination !== current.destination ||
    before.arrivalAt !== current.arrivalAt ||
    before.walkMinutes !== current.walkMinutes ||
    before.bufferMinutes !== current.bufferMinutes ||
    before.selectionRevision !== current.selectionRevision
  )
    return '경로 계산 후 장소나 시간이 바뀌었어요. 경로를 다시 계산하거나 예상 운전 시간을 직접 입력해 주세요.';
  const expiry = Date.parse(applied.expiresAt);
  if (!Number.isFinite(expiry) || now >= expiry)
    return '경로 계산 결과의 유효 시간이 지났어요. 다시 계산하거나 예상 운전 시간을 직접 입력해 주세요.';
  return null;
}
