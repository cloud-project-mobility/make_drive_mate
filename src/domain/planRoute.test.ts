import assert from 'node:assert/strict';
import test from 'node:test';
import { isTripPlan } from './state';
import { mapsUrl } from './routing';
import type { TripPlan } from './types';

const plan: TripPlan = {
  id: 'test-plan',
  vehicleId: 'test-vehicle',
  origin: '동명 장소',
  destination: '동명 장소',
  driveMinutes: 8,
  walkMinutes: 10,
  bufferMinutes: 10,
  source: 'sample',
  createdAt: '2026-10-28T00:00:00Z',
  eventAt: '2026-10-30T10:00:00Z',
  distanceKm: 2.4,
  originPoint: { longitude: 126.9706, latitude: 37.5547 },
  destinationPoint: { longitude: 126.978, latitude: 37.5665 },
  route: { source: 'mock', computedAt: '2026-10-28T00:00:00Z', expiresAt: '2026-10-28T00:05:00Z' },
};
test('saved coordinates survive JSON roundtrip and external maps use the selected places', () => {
  const saved = JSON.parse(JSON.stringify(plan));
  assert.equal(isTripPlan(saved), true);
  const url = new URL(mapsUrl(saved));
  assert.equal(url.searchParams.get('origin'), '37.5547,126.9706');
  assert.equal(url.searchParams.get('destination'), '37.5665,126.978');
  assert.equal(url.searchParams.get('travelmode'), 'driving');
});
test('old plans keep name lookup while corrupt or misleading route provenance is rejected', () => {
  const { originPoint, destinationPoint, route, ...old } = plan;
  assert.equal(isTripPlan(old), true);
  assert.equal(new URL(mapsUrl(old)).searchParams.get('origin'), old.origin);
  for (const bad of [
    { originPoint: null },
    { destinationPoint: { latitude: 91, longitude: 0 } },
    { originPoint: undefined },
    { eventAt: undefined },
    { distanceKm: undefined },
    { source: 'manual' },
    { route: null },
    { route: { ...route, expiresAt: route!.computedAt } },
  ])
    assert.equal(isTripPlan({ ...plan, ...bad }), false);
  assert.equal(isTripPlan({ ...old, originPoint, destinationPoint }), true);
});
