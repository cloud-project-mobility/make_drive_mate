/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { addGpsPoint, createGpsAccumulator, haversineMeters } from './gps';
import { departureAt, parseLocalDateTime, parseNonNegativeNumber } from './helpers';
import { getMaintenanceItems, getMaintenanceStatus } from './maintenance';
import {
  appReducer,
  createDemoState,
  createInitialState,
  isAppState,
  parseStoredState,
} from './state';
import type { ActiveTrip, Trip, Vehicle } from './types';

const vehicle = (id: string, odometerKm = 100): Vehicle => ({
  id,
  name: '내 차',
  model: '현대 아반떼 2023',
  powertrain: 'ICE',
  odometerKm,
  createdAt: '2026-10-21T00:00:00.000Z',
});
function withVehicle() {
  return appReducer(
    appReducer(createInitialState(), { type: 'COMPLETE_ONBOARDING', demo: false }),
    { type: 'ADD_VEHICLE', vehicle: vehicle('car') },
  );
}

test('new installations start empty; examples are explicitly requested with consistent mileage', () => {
  assert.equal(createInitialState().onboarded, false);
  assert.equal(createInitialState().vehicles.length, 0);
  const demo = createDemoState(new Date('2026-10-21T10:00:00Z'));
  assert.deepEqual(
    demo.vehicles.map((value) => value.odometerKm),
    [48_250, 26_340, 31_780],
  );
  assert.equal(demo.demoMode, true);
  assert.equal(isAppState(demo), true);
  assert.throws(() => appReducer(demo, { type: 'COMPLETE_ONBOARDING', demo: false }));
});

test('number validation rejects blanks, infinity, negatives and partial/ambiguous values', () => {
  for (const value of ['', ' ', '-1', 'Infinity', 'NaN', '1e3', '25km', '1,2', '1.2.3', '.5'])
    assert.equal(parseNonNegativeNumber(value).ok, false, value);
  assert.deepEqual(parseNonNegativeNumber('48,250.5'), { ok: true, value: 48_250.5 });
  assert.deepEqual(parseNonNegativeNumber('0'), { ok: true, value: 0 });
  assert.equal(parseNonNegativeNumber('181', '도보', 180).ok, false);
});

test('maximum three vehicles and selected vehicle survive deletion consistently', () => {
  let state = withVehicle();
  state = appReducer(state, { type: 'ADD_VEHICLE', vehicle: vehicle('two') });
  state = appReducer(state, { type: 'ADD_VEHICLE', vehicle: vehicle('three') });
  assert.throws(() => appReducer(state, { type: 'ADD_VEHICLE', vehicle: vehicle('four') }), /3대/);
  state = appReducer(state, { type: 'DELETE_VEHICLE', vehicleId: 'three' });
  assert.equal(state.selectedVehicleId, 'car');
  assert.equal(isAppState(state), true);
});

test('departure calculation includes the actual previous calendar day', () => {
  const at = departureAt({
    eventAt: '2026-10-22T00:30:00+09:00',
    driveMinutes: 80,
    walkMinutes: 10,
    bufferMinutes: 10,
  });
  assert.equal(at?.toISOString(), '2026-10-21T13:50:00.000Z'); // 22:50 KST on the previous day.
  assert.equal(departureAt({ driveMinutes: 80, walkMinutes: 10, bufferMinutes: 10 }), null);
  assert.equal(
    departureAt({ eventAt: 'bad', driveMinutes: 80, walkMinutes: 10, bufferMinutes: 10 }),
    null,
  );
  assert.equal(parseLocalDateTime('2026-02-30', '15:00'), null);
  assert.equal(parseLocalDateTime('2026-10-22', '24:00'), null);
  assert.ok(parseLocalDateTime('2028-02-29', '15:00'));
});

test('EV has no engine-only service items; unknown maintenance baseline stays unknown', () => {
  assert.equal(
    getMaintenanceItems('EV').some((item) => item.id === 'engine-oil'),
    false,
  );
  assert.equal(
    getMaintenanceItems('HYB').some((item) => item.id === 'engine-oil'),
    true,
  );
  const oil = getMaintenanceItems('ICE').find((item) => item.id === 'engine-oil')!;
  assert.equal(getMaintenanceStatus(vehicle('car', 48_250), oil, []).status, 'unrecorded');
});

test('maintenance is due when either date or mileage expires, and short months clamp', () => {
  const item = { id: 'oil', name: '오일', intervalKm: 10_000, intervalMonths: 1, description: '' };
  const records = [
    {
      id: 'r',
      vehicleId: 'car',
      itemId: 'oil',
      odometerKm: 100,
      performedAt: '2026-01-31T00:00:00Z',
    },
  ];
  const overdueByDate = getMaintenanceStatus(
    vehicle('car', 200),
    item,
    records,
    new Date('2026-03-02T00:00:00Z'),
  );
  assert.equal(overdueByDate.status, 'overdue');
  assert.equal(new Date(overdueByDate.dueAt!).getMonth(), 1);
  assert.equal(new Date(overdueByDate.dueAt!).getDate(), 28);
  assert.equal(
    getMaintenanceStatus(vehicle('car', 10_101), item, records, new Date('2026-02-01T00:00:00Z'))
      .status,
    'overdue',
  );
  assert.equal(
    getMaintenanceStatus(vehicle('car', 9_200), { ...item, intervalMonths: undefined }, records)
      .status,
    'dueSoon',
  );
});

test('completed GPS trip is saved atomically with the bound vehicle odometer, only once', () => {
  let state = withVehicle();
  const active: ActiveTrip = {
    id: 'trip',
    vehicleId: 'car',
    startedAt: '2026-10-21T00:00:00.000Z',
    distanceKm: 0,
    durationSeconds: 0,
  };
  state = appReducer(state, { type: 'START_TRIP', trip: active });
  assert.throws(() => appReducer(state, { type: 'DELETE_VEHICLE', vehicleId: 'car' }), /주행/);
  assert.throws(
    () => appReducer(state, { type: 'UPDATE_VEHICLE', vehicle: vehicle('car', 200) }),
    /주행/,
  );
  state = appReducer(state, { type: 'ADD_VEHICLE', vehicle: vehicle('second', 999) });
  const trip: Trip = {
    ...active,
    distanceKm: 1.234,
    durationSeconds: 120,
    endedAt: '2026-10-21T00:02:00.000Z',
    source: 'gps',
  };
  state = appReducer(state, { type: 'ADD_TRIP', trip });
  assert.equal(state.activeTrip, null);
  assert.equal(state.vehicles.find((value) => value.id === 'car')?.odometerKm, 101.234);
  assert.equal(state.vehicles.find((value) => value.id === 'second')?.odometerKm, 999);
  assert.throws(() => appReducer(state, { type: 'ADD_TRIP', trip }), /이미 저장/);
  assert.equal(isAppState(state), true);
});

test('sample trips never change the real odometer', () => {
  const state = appReducer(withVehicle(), {
    type: 'ADD_TRIP',
    trip: {
      id: 'sample',
      vehicleId: 'car',
      startedAt: '2026-10-21T00:00:00.000Z',
      endedAt: '2026-10-21T01:00:00.000Z',
      distanceKm: 18.2,
      durationSeconds: 3600,
      source: 'sample',
    },
  });
  assert.equal(state.vehicles[0].odometerKm, 100);
});

test('strict persisted state roundtrips; corruption, duplicate IDs and orphan references are rejected', () => {
  const state = withVehicle();
  const roundtrip = parseStoredState(JSON.stringify(state));
  assert.deepEqual(roundtrip, { ok: true, state, migrated: false });
  for (const raw of [
    '{bad',
    'null',
    '{}',
    JSON.stringify({ ...state, version: 99 }),
    JSON.stringify({ ...state, vehicles: [vehicle('car'), vehicle('car')] }),
    JSON.stringify({ ...state, selectedVehicleId: 'missing' }),
    JSON.stringify({ ...state, vehicles: [{ ...vehicle('car'), odometerKm: -1 }] }),
  ])
    assert.equal(parseStoredState(raw).ok, false, raw);
  assert.equal(
    parseStoredState(
      JSON.stringify({
        ...state,
        vehicles: [{ ...vehicle('car'), createdAt: '2026-02-30T00:00:00Z' }],
      }),
    ).ok,
    false,
  );
  const legacy = { ...state, version: 0, activeTrip: undefined, plans: undefined };
  const migrated = parseStoredState(JSON.stringify(legacy));
  assert.equal(migrated.ok, true);
  if (migrated.ok) {
    assert.equal(migrated.migrated, true);
    assert.equal(migrated.state.activeTrip, null);
  }
});

test('interrupted sessions persist; distance cannot decrease and another trip cannot replace one', () => {
  const active: ActiveTrip = {
    id: 'recording',
    vehicleId: 'car',
    startedAt: '2026-10-21T00:00:00.000Z',
    distanceKm: 2.5,
    durationSeconds: 80,
  };
  const state = appReducer(withVehicle(), { type: 'START_TRIP', trip: active });
  const restored = parseStoredState(JSON.stringify(state));
  assert.equal(restored.ok, true);
  if (restored.ok) assert.equal(restored.state.activeTrip?.distanceKm, 2.5);
  assert.throws(() => appReducer(state, { type: 'START_TRIP', trip: { ...active, id: 'other' } }));
  assert.throws(() =>
    appReducer(state, { type: 'UPDATE_ACTIVE_TRIP', trip: { ...active, distanceKm: 1 } }),
  );
  assert.throws(() => appReducer(state, { type: 'RESET_DATA' }));
});

test('GPS filters inaccurate fixes, duplicates, impossible jumps and stationary noise', () => {
  const point = { latitude: 37.5, longitude: 127, accuracy: 5, timestamp: 1_000_000 };
  const first = addGpsPoint(createGpsAccumulator(), point);
  assert.equal(first.accepted, true);
  assert.equal(
    addGpsPoint(first.accumulator, { ...point, accuracy: null, timestamp: point.timestamp + 1000 })
      .reason,
    'accuracy',
  );
  assert.equal(
    addGpsPoint(first.accumulator, { ...point, accuracy: 100, timestamp: point.timestamp + 1000 })
      .reason,
    'accuracy',
  );
  assert.equal(addGpsPoint(first.accumulator, point).reason, 'stale');
  assert.equal(
    addGpsPoint(first.accumulator, { ...point, latitude: 38.5, timestamp: point.timestamp + 1000 })
      .reason,
    'jump',
  );
  assert.equal(
    addGpsPoint(first.accumulator, {
      ...point,
      latitude: 37.500001,
      timestamp: point.timestamp + 1000,
    }).reason,
    'noise',
  );
  const valid = addGpsPoint(first.accumulator, {
    ...point,
    latitude: 37.5001,
    timestamp: point.timestamp + 1000,
  });
  assert.equal(valid.accepted, true);
  assert.ok(valid.accumulator.distanceMeters > 11 && valid.accumulator.distanceMeters < 12);
});

test('GPS gaps and resume baselines do not invent distance through unobserved intervals', () => {
  const point = { latitude: 37.5, longitude: 127, accuracy: 5, timestamp: 1_000_000 };
  const first = addGpsPoint(createGpsAccumulator(100), point);
  const afterGap = addGpsPoint(first.accumulator, {
    ...point,
    latitude: 38.5,
    timestamp: point.timestamp + 31_000,
  });
  assert.equal(afterGap.reason, 'gap');
  assert.equal(afterGap.accumulator.distanceMeters, 100);
  const resumed = addGpsPoint(createGpsAccumulator(100), {
    ...point,
    latitude: 38.5,
    timestamp: point.timestamp + 60_000,
  });
  assert.equal(resumed.accumulator.distanceMeters, 100);
  assert.ok(
    Math.abs(
      haversineMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }) - 111_195,
    ) < 1,
  );
});

test('invalid maintenance and settings values cannot poison future storage loads', () => {
  const state = withVehicle();
  assert.throws(() =>
    appReducer(state, {
      type: 'ADD_MAINTENANCE',
      record: {
        id: 'm',
        vehicleId: 'car',
        itemId: 'engine-oil',
        odometerKm: 101,
        performedAt: '2026-01-01T00:00:00Z',
      },
    }),
  );
  assert.throws(() =>
    appReducer(state, { type: 'UPDATE_SETTINGS', settings: { walkMinutes: Number.NaN } }),
  );
  assert.throws(() => appReducer(state, { type: 'UPDATE_VEHICLE', vehicle: vehicle('car', -1) }));
  const multiline = appReducer(state, {
    type: 'ADD_MAINTENANCE',
    record: {
      id: 'note',
      vehicleId: 'car',
      itemId: 'engine-oil',
      odometerKm: 100,
      performedAt: '2026-01-01T00:00:00Z',
      note: '정비소에서 교환\n규격 확인\t완료',
    },
  });
  assert.equal(isAppState(multiline), true);
});

test('backup replacement validates before changing state and refuses interrupted sessions', () => {
  const original = withVehicle();
  const preserved = JSON.stringify(original);
  const backup = createDemoState();
  const imported = appReducer(original, { type: 'IMPORT_DATA', state: backup });
  assert.deepEqual(imported, backup);
  assert.notEqual(imported, backup);
  assert.deepEqual(parseStoredState(JSON.stringify(imported)), {
    ok: true,
    state: imported,
    migrated: false,
  });
  assert.throws(() =>
    appReducer(original, {
      type: 'IMPORT_DATA',
      state: { ...backup, selectedVehicleId: 'missing' },
    }),
  );
  assert.throws(() => appReducer(original, { type: 'IMPORT_DATA', state: createInitialState() }));
  const active: ActiveTrip = {
    id: 'recording',
    vehicleId: 'car',
    startedAt: '2026-10-21T00:00:00.000Z',
    distanceKm: 0,
    durationSeconds: 0,
  };
  const recording = appReducer(original, { type: 'START_TRIP', trip: active });
  assert.throws(() => appReducer(recording, { type: 'IMPORT_DATA', state: backup }));
  assert.throws(() => appReducer(original, { type: 'IMPORT_DATA', state: recording }));
  assert.equal(JSON.stringify(original), preserved);
});

test('oversized ASCII or multibyte backup payloads are rejected before JSON parsing', () => {
  const ascii = parseStoredState(' '.repeat(5 * 1_024 * 1_024 + 1));
  const unicode = parseStoredState('한'.repeat(2 * 1_024 * 1_024));
  assert.equal(ascii.ok, false);
  assert.equal(unicode.ok, false);
  if (!unicode.ok) assert.match(unicode.error, /5 MB/);
});

test('persisted enum values must be strings and welcome cannot hide existing records', () => {
  const state = withVehicle();
  assert.equal(
    parseStoredState(
      JSON.stringify({ ...state, vehicles: [{ ...state.vehicles[0], powertrain: ['EV'] }] }),
    ).ok,
    false,
  );
  const plan = {
    id: 'p',
    vehicleId: 'car',
    origin: '서울역',
    destination: '강남역',
    driveMinutes: 30,
    walkMinutes: 10,
    bufferMinutes: 10,
    source: ['sample'],
    createdAt: '2026-10-21T00:00:00Z',
  };
  assert.equal(parseStoredState(JSON.stringify({ ...state, plans: [plan] })).ok, false);
  const trip = {
    id: 't',
    vehicleId: 'car',
    startedAt: '2026-10-21T00:00:00Z',
    endedAt: '2026-10-21T00:01:00Z',
    durationSeconds: 60,
    distanceKm: 0.1,
    source: ['gps'],
  };
  assert.equal(parseStoredState(JSON.stringify({ ...state, trips: [trip] })).ok, false);
  assert.equal(parseStoredState(JSON.stringify({ ...state, onboarded: false })).ok, false);
  assert.equal(
    parseStoredState(JSON.stringify({ ...createInitialState(), demoMode: true })).ok,
    false,
  );
  assert.equal(parseStoredState(JSON.stringify(createInitialState())).ok, true);
});
