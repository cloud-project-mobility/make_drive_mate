/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { canFinishTripAt, createTripClock } from './tripClock';

test('forward and backwards wall-clock jumps do not inflate or decrease foreground duration', () => {
  let monotonic = 1_000;
  const clock = createTripClock(() => monotonic);
  const started = '2026-10-28T12:00:00.000Z';
  clock.resume();
  monotonic += 10_000;
  assert.equal(clock.elapsed(), 10);
  assert.equal(canFinishTripAt(started, clock.elapsed(), '2026-10-28T18:00:10.000Z'), true);
  assert.equal(clock.elapsed(), 10);
  monotonic += 5_000;
  assert.equal(canFinishTripAt(started, clock.elapsed(), '2026-10-28T11:00:15.000Z'), false);
  assert.equal(clock.pause(), 15);
  assert.equal(canFinishTripAt(started, clock.elapsed(), '2026-10-28T12:00:15.000Z'), true);
});

test('pause, resume, and restore only count measured foreground segments', () => {
  let now = 1_000;
  const clock = createTripClock(() => now);
  clock.reset(23);
  now += 60_000;
  assert.equal(clock.elapsed(), 23);
  clock.resume();
  now += 5_200;
  assert.equal(clock.pause(), 28);
  now += 3_600_000;
  assert.equal(clock.elapsed(), 28);
  clock.resume();
  now += 2_100;
  assert.equal(clock.elapsed(), 30);
  clock.reset(30);
  now += 99_000;
  assert.equal(clock.elapsed(), 30);
});

test('unsupported clocks fail before recording and invalid readings never erase elapsed time', () => {
  let now = Number.NaN;
  const clock = createTripClock(() => now);
  clock.reset(17);
  assert.throws(() => clock.resume(), /경과 시간/);
  assert.equal(clock.elapsed(), 17);
  now = 100;
  clock.resume();
  now += 10_000;
  assert.equal(clock.elapsed(), 27);
  now -= 6_000;
  assert.equal(clock.elapsed(), 27);
  now = Number.NaN;
  assert.equal(clock.pause(), 27);
});

test('end-time validation preserves the real timestamp and matches the persisted duration tolerance', () => {
  const start = '2026-10-28T12:00:00.000Z';
  assert.equal(canFinishTripAt(start, 10, '2026-10-28T12:00:07.999Z'), false);
  assert.equal(canFinishTripAt(start, 10, '2026-10-28T12:00:08.000Z'), true);
  assert.equal(canFinishTripAt(start, 0, '2026-10-28T11:59:59.999Z'), false);
  assert.equal(canFinishTripAt(start, 10, 'invalid'), false);
});
