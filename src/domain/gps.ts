export interface GpsPoint {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  timestamp: number;
}
export interface GpsAccumulator {
  lastPoint: GpsPoint | null;
  distanceMeters: number;
  acceptedPoints: number;
  rejectedPoints: number;
}
export interface GpsUpdate {
  accumulator: GpsAccumulator;
  accepted: boolean;
  reason?: 'invalid' | 'accuracy' | 'stale' | 'jump' | 'noise' | 'gap';
}
export const GPS_MAX_ACCURACY_METERS = 35;
export const GPS_MAX_SPEED_METERS_PER_SECOND = 70;
export const GPS_MAX_GAP_MS = 30_000;

export function createGpsAccumulator(distanceMeters = 0): GpsAccumulator {
  return { lastPoint: null, distanceMeters, acceptedPoints: 0, rejectedPoints: 0 };
}

export function haversineMeters(
  a: Pick<GpsPoint, 'latitude' | 'longitude'>,
  b: Pick<GpsPoint, 'latitude' | 'longitude'>,
): number {
  const radians = Math.PI / 180;
  const deltaLat = (b.latitude - a.latitude) * radians;
  const deltaLon = (b.longitude - a.longitude) * radians;
  const central =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(a.latitude * radians) * Math.cos(b.latitude * radians) * Math.sin(deltaLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(central), Math.sqrt(Math.max(0, 1 - central)));
}

export function addGpsPoint(accumulator: GpsAccumulator, point: GpsPoint): GpsUpdate {
  const reject = (reason: GpsUpdate['reason']): GpsUpdate => ({
    accumulator: { ...accumulator, rejectedPoints: accumulator.rejectedPoints + 1 },
    accepted: false,
    reason,
  });
  if (
    !Number.isFinite(point.latitude) ||
    Math.abs(point.latitude) > 90 ||
    !Number.isFinite(point.longitude) ||
    Math.abs(point.longitude) > 180 ||
    !Number.isFinite(point.timestamp) ||
    point.timestamp <= 0
  )
    return reject('invalid');
  if (
    point.accuracy === null ||
    !Number.isFinite(point.accuracy) ||
    point.accuracy < 0 ||
    point.accuracy > GPS_MAX_ACCURACY_METERS
  )
    return reject('accuracy');
  const previous = accumulator.lastPoint;
  if (!previous)
    return {
      accumulator: {
        ...accumulator,
        lastPoint: point,
        acceptedPoints: accumulator.acceptedPoints + 1,
      },
      accepted: true,
    };
  const delta = point.timestamp - previous.timestamp;
  if (delta <= 0) return reject('stale');
  // A gap creates a new baseline: never draw a fictitious line through a tunnel or paused interval.
  if (delta > GPS_MAX_GAP_MS)
    return {
      accumulator: {
        ...accumulator,
        lastPoint: point,
        acceptedPoints: accumulator.acceptedPoints + 1,
      },
      accepted: true,
      reason: 'gap',
    };
  const meters = haversineMeters(previous, point);
  if (meters / (delta / 1_000) > GPS_MAX_SPEED_METERS_PER_SECOND) return reject('jump');
  // Keep the previous baseline so slow real movement can accumulate past the noise threshold.
  if (meters < Math.max(5, Math.max(previous.accuracy ?? 0, point.accuracy) * 0.35))
    return reject('noise');
  return {
    accumulator: {
      ...accumulator,
      lastPoint: point,
      distanceMeters: accumulator.distanceMeters + meters,
      acceptedPoints: accumulator.acceptedPoints + 1,
    },
    accepted: true,
  };
}
