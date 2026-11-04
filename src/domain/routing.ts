import type { Coordinates, TripPlan } from './types';
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
  // Kakao's documented link formats use latitude first, unlike our coordinate object.
  // https://apis.map.kakao.com/web/guide/#routeurl
  if (validMapPoint(plan.originPoint) && validMapPoint(plan.destinationPoint)) {
    const origin = `${encodeURIComponent(plan.origin)},${plan.originPoint.latitude},${plan.originPoint.longitude}`;
    const destination = `${encodeURIComponent(plan.destination)},${plan.destinationPoint.latitude},${plan.destinationPoint.longitude}`;
    return `https://map.kakao.com/link/by/car/${origin}/${destination}`;
  }
  // An unselected place name cannot identify an exact route. Let the user select it in Kakao.
  return `https://map.kakao.com/link/search/${encodeURIComponent(plan.destination)}`;
}
function validMapPoint(point: Coordinates | undefined): point is Coordinates {
  return (
    !!point &&
    Number.isFinite(point.latitude) &&
    Math.abs(point.latitude) <= 90 &&
    Number.isFinite(point.longitude) &&
    Math.abs(point.longitude) <= 180
  );
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
