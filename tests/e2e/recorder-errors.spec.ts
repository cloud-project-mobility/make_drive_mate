import { expect, test } from '@playwright/test';
import type { AppState } from '../../src/domain/types';

test('browser GPS errors pause, remove the exact watch, and stale callbacks cannot stop resume', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['geolocation']);
  await page.addInitScript(() => {
    type ErrorCallback = (error: GeolocationPositionError) => void;
    const watchers = new Map<number, { success: PositionCallback; error?: ErrorCallback | null }>();
    const cleared: number[] = [];
    let nextId = 1_000; // Deliberately different from any library's internal subscription counter.
    let previousError: ErrorCallback | null | undefined;
    const failure = {
      code: 2,
      message: 'Controlled test position unavailable',
      PERMISSION_DENIED: 1,
      POSITION_UNAVAILABLE: 2,
      TIMEOUT: 3,
    } as GeolocationPositionError;
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        watchPosition(success: PositionCallback, error?: ErrorCallback | null) {
          const id = ++nextId;
          watchers.set(id, { success, error });
          return id;
        },
        clearWatch(id: number) {
          cleared.push(id);
          watchers.delete(id);
        },
      },
    });
    Object.assign(window, {
      __gpsHarness: {
        count: () => watchers.size,
        cleared,
        emit: () =>
          watchers.forEach((watcher) =>
            watcher.success({
              timestamp: Date.now(),
              coords: {
                latitude: 37.5,
                longitude: 127,
                accuracy: 5,
                altitude: null,
                altitudeAccuracy: null,
                heading: null,
                speed: null,
              },
            } as GeolocationPosition),
          ),
        fail: () => {
          previousError = [...watchers.values()][0]?.error;
          previousError?.(failure);
        },
        failOld: () => previousError?.(failure),
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '예시 차량으로 둘러보기', exact: true }).click();
  await expect(page.getByRole('tab', { name: '홈', exact: true })).toBeVisible();
  await page.goto('/route');
  await page.getByRole('button', { name: '나의 아반떼 · GPS 기록 시작', exact: true }).click();
  await expect(page.getByText('GPS 측정 중', { exact: true })).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { __gpsHarness: { emit: () => void } }).__gpsHarness.emit(),
  );
  await expect(page.getByText('약 5m', { exact: true })).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { __gpsHarness: { fail: () => void } }).__gpsHarness.fail(),
  );
  await expect(page.getByText('기록 일시 정지', { exact: true })).toBeVisible();
  await expect(page.getByText(/위치 신호를 받을 수 없어 기록을 일시 정지했어요/)).toBeVisible();
  expect(
    await page.evaluate(() => {
      const harness = (
        window as unknown as { __gpsHarness: { count: () => number; cleared: number[] } }
      ).__gpsHarness;
      return { count: harness.count(), cleared: harness.cleared };
    }),
  ).toEqual({ count: 0, cleared: [1_001] });
  await page.getByRole('button', { name: '기록 재개', exact: true }).click();
  await expect(page.getByText('GPS 측정 중', { exact: true })).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { __gpsHarness: { failOld: () => void } }).__gpsHarness.failOld(),
  );
  await expect(page.getByText('GPS 측정 중', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as unknown as { __gpsHarness: { count: () => number } }).__gpsHarness.count(),
    ),
  ).toBe(1);
  await page.getByRole('button', { name: '일시 정지', exact: true }).click();
  expect(
    await page.evaluate(() =>
      (window as unknown as { __gpsHarness: { count: () => number } }).__gpsHarness.count(),
    ),
  ).toBe(0);
});

test('a backwards device clock shows the save failure inside confirmation and preserves the paused trip for retry', async ({
  page,
  context,
}) => {
  const startedAt = new Date('2026-11-07T01:00:00Z');
  await page.clock.setFixedTime(startedAt);
  await context.grantPermissions(['geolocation']);
  // Only the browser sensor and wall clock are controlled; recording and saving use the UI.
  await page.addInitScript(() => {
    const callbacks = new Map<number, PositionCallback>();
    let nextId = 2_000;
    const sample = (latitude: number) =>
      ({
        timestamp: Date.now(),
        coords: {
          latitude,
          longitude: 126.978,
          accuracy: 5,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          speed: null,
        },
      }) as GeolocationPosition;
    Object.defineProperty(navigator.geolocation, 'watchPosition', {
      configurable: true,
      value: (callback: PositionCallback) => {
        const id = ++nextId;
        callbacks.set(id, callback);
        queueMicrotask(() => {
          if (callbacks.has(id)) callback(sample(37.5665));
        });
        return id;
      },
    });
    Object.defineProperty(navigator.geolocation, 'clearWatch', {
      configurable: true,
      value: (id: number) => callbacks.delete(id),
    });
    Object.assign(window, {
      __emitClockTestGps: (latitude: number) =>
        callbacks.forEach((callback) => callback(sample(latitude))),
    });
  });
  const readState = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem('@drivemate/state:v1')!) as AppState);
  await page.goto('/');
  await page.getByRole('button', { name: '예시 차량으로 둘러보기', exact: true }).click();
  await page.goto('/route');
  await page.getByRole('button', { name: '나의 아반떼 · GPS 기록 시작', exact: true }).click();
  await expect(page.getByText('GPS 측정 중', { exact: true })).toBeVisible();
  await expect(page.getByText('약 5m', { exact: true })).toBeVisible();
  await expect(page.getByText(/^0분 (?:[2-9]|[1-5]\d)초$/)).toBeVisible();
  await page.clock.setFixedTime(new Date(startedAt.getTime() + 3_000));
  await page.evaluate(() =>
    (window as unknown as { __emitClockTestGps: (latitude: number) => void }).__emitClockTestGps(
      37.5675,
    ),
  );
  await expect(page.getByText(/^0\.11\s*km$/)).toBeVisible();
  const before = await readState();
  const tripId = before.activeTrip!.id;
  const vehicleId = before.activeTrip!.vehicleId;
  const originalOdometer = before.vehicles.find((vehicle) => vehicle.id === vehicleId)!.odometerKm;

  await page.clock.setFixedTime(new Date(startedAt.getTime() - 60_000));
  await page.getByRole('button', { name: '종료하고 저장', exact: true }).click();
  const confirmation = page.getByTestId('trip-confirmation');
  await confirmation.getByRole('button', { name: '주행 종료 · 기록 저장', exact: true }).click();
  await expect(
    confirmation.getByText('주행 기록을 저장하지 못했어요', { exact: true }),
  ).toBeVisible();
  await expect(confirmation.getByText(/기기 시간이 주행 시작보다 뒤로 바뀌었어요/)).toBeVisible();
  await expect(page.getByText('주행 기록을 저장했어요', { exact: true })).toHaveCount(0);
  await expect.poll(async () => (await readState()).activeTrip?.distanceKm).toBeGreaterThan(0.1);
  const paused = await readState();
  expect(paused.activeTrip).toMatchObject({ id: tripId, vehicleId });
  expect(paused.activeTrip!.durationSeconds).toBeGreaterThanOrEqual(2);
  expect(paused.trips).toHaveLength(before.trips.length);
  expect(paused.vehicles.find((vehicle) => vehicle.id === vehicleId)!.odometerKm).toBe(
    originalOdometer,
  );
  await confirmation
    .getByRole('button', { name: '일시 정지 화면으로 돌아가기', exact: true })
    .click();
  await expect(page.getByText('기록 일시 정지', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '기록 재개', exact: true })).toBeVisible();
  await expect(page.getByText(/^0\.11\s*km$/)).toBeVisible();

  // Repairing the clock permits the same paused recording to be saved exactly once.
  await page.clock.setFixedTime(new Date(startedAt.getTime() + 3_600_000));
  await page.getByRole('button', { name: '종료하고 저장', exact: true }).click();
  await confirmation.getByRole('button', { name: '주행 종료 · 기록 저장', exact: true }).click();
  await expect(page.getByText('주행 기록을 저장했어요', { exact: true })).toBeVisible();
  await expect(page.getByText(/기기 시간이 주행 시작보다 뒤로 바뀌었어요/)).toHaveCount(0);
  await expect(confirmation).toHaveCount(0);
  await expect.poll(async () => (await readState()).activeTrip).toBeNull();
  const saved = await readState();
  expect(saved.trips).toHaveLength(before.trips.length + 1);
  expect(saved.trips.filter((trip) => trip.id === tripId)).toHaveLength(1);
  expect(saved.trips.find((trip) => trip.id === tripId)!.distanceKm).toBeCloseTo(
    paused.activeTrip!.distanceKm,
    6,
  );
  expect(saved.vehicles.find((vehicle) => vehicle.id === vehicleId)!.odometerKm).toBe(
    Math.round((originalOdometer + paused.activeTrip!.distanceKm) * 1_000) / 1_000,
  );
});
