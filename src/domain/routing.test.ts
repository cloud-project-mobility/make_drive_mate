import assert from 'node:assert/strict';
import test from 'node:test';
import { routeApplicationIssue, type AppliedRoute, type RouteInputs } from './routing';
const inputs: RouteInputs = {
  origin: '서울역',
  destination: '서울시청',
  arrivalAt: '2026-10-30T01:00:00Z',
  walkMinutes: 10,
  bufferMinutes: 10,
  selectionRevision: 0,
};
const applied: AppliedRoute = {
  inputs,
  distanceKm: 2.4,
  expiresAt: '2026-10-28T01:05:00Z',
  computedAt: '2026-10-28T01:00:00Z',
  source: 'mock',
};
const now = Date.parse('2026-10-28T01:00:00Z');
test('route result expires at five-minute boundary and invalid dates are never fresh', () => {
  assert.equal(routeApplicationIssue(applied, inputs, now), null);
  assert.equal(routeApplicationIssue(applied, inputs, now + 299999), null);
  assert.match(routeApplicationIssue(applied, inputs, now + 300000)!, /유효 시간/);
  assert.match(
    routeApplicationIssue({ ...applied, expiresAt: 'invalid' }, inputs, now)!,
    /유효 시간/,
  );
});
test('every route input invalidates the applied estimate; explicit manual entry can clear it', () => {
  for (const change of [
    { origin: '강남역' },
    { destination: '강남역' },
    { arrivalAt: '2026-10-30T02:00:00Z' },
    { walkMinutes: 20 },
    { bufferMinutes: 0 },
    { arrivalAt: null },
    { selectionRevision: 1 },
  ])
    assert.match(
      routeApplicationIssue(applied, { ...inputs, ...change }, now)!,
      /장소나 시간이 바뀌었어요/,
    );
  assert.equal(routeApplicationIssue(null, { ...inputs, destination: '강남역' }, now), null);
  assert.equal(routeApplicationIssue(applied, { ...inputs }, now), null);
});
