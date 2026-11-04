import { expect, test } from '@playwright/test';

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
  await expect(
    page.getByRole('heading', { name: '내 차의 다음 타이밍', exact: true }),
  ).toBeVisible();
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
