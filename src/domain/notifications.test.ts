import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createDepartureNotificationCoordinator } from './departureNotifications';
import type { TripPlan } from './types';

/** Execute the actual native service with only its platform and SDK boundaries replaced. */
function nativeService(sdk: Record<string, unknown>): typeof import('../services/notifications') {
  const modules = new Map<string, { exports: unknown }>();
  function load(file: string): unknown {
    const cached = modules.get(file);
    if (cached) return cached.exports;
    const module = { exports: {} as unknown };
    modules.set(file, module);
    const output = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const requireModule = (name: string): unknown => {
      if (name === 'react-native') return { Platform: { OS: 'android' } };
      if (name === 'expo-notifications') return sdk;
      if (name.startsWith('.')) return load(resolve(dirname(file), `${name}.ts`));
      throw new Error(`Unexpected service dependency: ${name}`);
    };
    new Function('require', 'module', 'exports', output)(requireModule, module, module.exports);
    return module.exports;
  }
  return load(
    fileURLToPath(new URL('../services/notifications.ts', import.meta.url)),
  ) as typeof import('../services/notifications');
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function plan(id: string): TripPlan {
  return {
    id,
    vehicleId: 'test-vehicle',
    origin: '서울역',
    destination: '서울시청',
    eventAt: '2099-10-30T01:00:00Z',
    driveMinutes: 8,
    walkMinutes: 10,
    bufferMinutes: 10,
    source: 'manual',
    createdAt: '2026-10-28T00:00:00Z',
  };
}

test('deleting a plan waits for its pending native schedule and leaves no orphan alarm', async () => {
  const entered = deferred();
  const release = deferred();
  const alarms = new Set<string>();
  const coordinator = createDepartureNotificationCoordinator({
    async schedule(value) {
      entered.resolve();
      await release.promise;
      alarms.add(value.id);
      return { ok: true, identifier: value.id };
    },
    async cancel(id) {
      alarms.delete(id);
    },
    async cancelAll() {
      alarms.clear();
    },
  });
  const scheduled = coordinator.schedule(plan('deleted'));
  await entered.promise;
  let deleted = false;
  const deletion = coordinator.cancel('deleted').then(() => {
    deleted = true;
  });
  await Promise.resolve();
  assert.equal(deleted, false);
  release.resolve();
  assert.equal((await scheduled).ok, false);
  await deletion;
  assert.equal(deleted, true);
  assert.deepEqual([...alarms], []);
});

test('full restore cancels existing, in-flight, and queued alarms before replacing data', async () => {
  const entered = deferred();
  const release = deferred();
  const alarms = new Set(['previous-process']);
  const nativeSchedules: string[] = [];
  const coordinator = createDepartureNotificationCoordinator({
    async schedule(value) {
      nativeSchedules.push(value.id);
      if (value.id === 'in-flight') {
        entered.resolve();
        await release.promise;
      }
      alarms.add(value.id);
      return { ok: true, identifier: value.id };
    },
    async cancel(id) {
      alarms.delete(id);
    },
    async cancelAll() {
      alarms.clear();
    },
  });
  const inFlight = coordinator.schedule(plan('in-flight'));
  await entered.promise;
  const queued = coordinator.schedule(plan('queued'));
  let restored = false;
  const restore = coordinator.cancelAll().then(() => {
    restored = true;
  });
  assert.equal((await coordinator.schedule(plan('during-restore'))).ok, false);
  assert.equal(restored, false);
  release.resolve();
  assert.equal((await inFlight).ok, false);
  assert.equal((await queued).ok, false);
  await restore;
  assert.equal(restored, true);
  assert.deepEqual([...alarms], []);
  assert.deepEqual(nativeSchedules, ['in-flight']);
  assert.equal((await coordinator.schedule(plan('after-restore'))).ok, true);
  assert.deepEqual([...alarms], ['after-restore']);
});

test('a failed cancellation blocks deletion, and a later retry can clean up', async () => {
  const alarms = new Set(['preserved']);
  let fail = true;
  const coordinator = createDepartureNotificationCoordinator({
    async schedule() {
      return { ok: true };
    },
    async cancel(id) {
      if (fail) throw new Error('synthetic native cancellation failure');
      alarms.delete(id);
    },
    async cancelAll() {
      alarms.clear();
    },
  });
  let deleted = false;
  await assert.rejects(
    coordinator.cancel('preserved').then(() => {
      deleted = true;
    }),
    /synthetic native cancellation failure/,
  );
  assert.equal(deleted, false);
  assert.deepEqual([...alarms], ['preserved']);
  fail = false;
  await coordinator.cancel('preserved');
  assert.deepEqual([...alarms], []);
});

test('full cancellation failure blocks restore and does not poison subsequent operations', async () => {
  let fail = true;
  const alarms = new Set(['old']);
  const coordinator = createDepartureNotificationCoordinator({
    async schedule(value) {
      alarms.add(value.id);
      return { ok: true };
    },
    async cancel(id) {
      alarms.delete(id);
    },
    async cancelAll() {
      if (fail) throw new Error('synthetic list or cancellation failure');
      alarms.clear();
    },
  });
  let restored = false;
  await assert.rejects(
    coordinator.cancelAll().then(() => {
      restored = true;
    }),
  );
  assert.equal(restored, false);
  assert.deepEqual([...alarms], ['old']);
  fail = false;
  await coordinator.cancelAll();
  assert.equal((await coordinator.schedule(plan('new'))).ok, true);
  assert.deepEqual([...alarms], ['new']);
});

test('a new schedule is rejected while the same plan cancellation is still running', async () => {
  const entered = deferred();
  const release = deferred();
  let schedules = 0;
  const coordinator = createDepartureNotificationCoordinator({
    async schedule() {
      schedules += 1;
      return { ok: true };
    },
    async cancel() {
      entered.resolve();
      await release.promise;
    },
    async cancelAll() {},
  });
  const cancellation = coordinator.cancel('same');
  await entered.promise;
  assert.equal((await coordinator.schedule(plan('same'))).ok, false);
  assert.equal(schedules, 0);
  release.resolve();
  await cancellation;
  assert.equal((await coordinator.schedule(plan('same'))).ok, true);
  assert.equal(schedules, 1);
});

test('native schedule failures do not prevent a later cancellation or fresh schedule', async () => {
  let fail = true;
  const alarms = new Set<string>();
  const coordinator = createDepartureNotificationCoordinator({
    async schedule(value) {
      if (fail) throw new Error('synthetic schedule failure');
      alarms.add(value.id);
      return { ok: true };
    },
    async cancel(id) {
      alarms.delete(id);
    },
    async cancelAll() {
      alarms.clear();
    },
  });
  await assert.rejects(coordinator.schedule(plan('old')));
  await coordinator.cancel('old');
  fail = false;
  assert.equal((await coordinator.schedule(plan('new'))).ok, true);
  assert.deepEqual([...alarms], ['new']);
});

for (const all of [false, true]) {
  test(`native ${all ? 'full' : 'single-plan'} cancellation waits for late SDK writes even when another cancellation fails`, async () => {
    const entered = deferred();
    const release = deferred();
    type Scheduled = { identifier: string; content: { data: { planId: string } } };
    const alarms = new Map<string, Scheduled>(
      ['old-duplicate', 'departure-reused'].map((identifier) => [
        identifier,
        { identifier, content: { data: { planId: 'reused' } } },
      ]),
    );
    const service = nativeService({
      AndroidImportance: { DEFAULT: 3 },
      SchedulableTriggerInputTypes: { DATE: 'date' },
      async setNotificationChannelAsync() {},
      async getPermissionsAsync() {
        return { granted: true };
      },
      setNotificationHandler() {},
      async getAllScheduledNotificationsAsync() {
        return [...alarms.values()];
      },
      async cancelScheduledNotificationAsync(identifier: string) {
        if (identifier === 'old-duplicate') throw new Error('synthetic native failure');
        entered.resolve();
        await release.promise;
        alarms.delete(identifier);
      },
      async scheduleNotificationAsync(notification: Scheduled) {
        alarms.set(notification.identifier, notification);
        return notification.identifier;
      },
    });
    let failureReported = false;
    const cancellation = (
      all ? service.cancelAllDepartures() : service.cancelDeparture('reused')
    ).then(
      () => assert.fail('native cancellation must fail'),
      () => {
        failureReported = true;
      },
    );
    try {
      await entered.promise;
      await new Promise<void>((done) => setImmediate(done));
      assert.equal(
        failureReported,
        false,
        'late native writes must finish before failure is reported',
      );
      assert.equal((await service.scheduleDeparture(plan('reused'))).ok, false);
    } finally {
      release.resolve();
      await cancellation;
    }
    assert.equal(failureReported, true);
    assert.equal((await service.scheduleDeparture(plan('reused'))).ok, true);
    assert.equal(alarms.has('departure-reused'), true);
  });
}

test('native permission delay cannot schedule a departure that has already passed', async (context) => {
  const entered = deferred();
  const release = deferred();
  let currentTime = Date.parse('2099-10-30T00:00:00Z');
  context.mock.method(Date, 'now', () => currentTime);
  let nativeSchedules = 0;
  const service = nativeService({
    AndroidImportance: { DEFAULT: 3 },
    SchedulableTriggerInputTypes: { DATE: 'date' },
    async setNotificationChannelAsync() {},
    async getPermissionsAsync() {
      return { granted: false };
    },
    async requestPermissionsAsync() {
      entered.resolve();
      await release.promise;
      return { granted: true };
    },
    setNotificationHandler() {},
    async scheduleNotificationAsync() {
      nativeSchedules += 1;
      return 'too-late';
    },
  });
  const pending = service.scheduleDeparture(plan('late'));
  await entered.promise;
  currentTime = Date.parse('2099-10-30T01:01:00Z');
  release.resolve();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(nativeSchedules, 0);
});
