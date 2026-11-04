import { expect, test, type Page } from '@playwright/test';
import { createInitialState } from '../../src/domain/state';
import type { AppState, TripPlan } from '../../src/domain/types';

test.use({ timezoneId: 'Asia/Seoul' });

function fixture(): AppState {
  const state = createInitialState();
  const future = new Date(Date.now() + 3 * 86_400_000);
  future.setUTCHours(15, 30, 0, 0); // 00:30 KST; departure is on the preceding day.
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const createdAt = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const plan = (id: string, overrides: Partial<TripPlan> = {}): TripPlan => ({
    id,
    vehicleId: 'vehicle-a',
    origin: '서울역',
    destination: '강남역',
    eventTitle: '자정 이후 미팅',
    eventAt: future.toISOString(),
    driveMinutes: 50,
    walkMinutes: 10,
    bufferMinutes: 10,
    source: 'manual',
    createdAt,
    ...overrides,
  });
  return {
    ...state,
    onboarded: true,
    vehicles: [
      {
        id: 'vehicle-a',
        name: '알파 차량',
        model: '현대 아반떼 2023',
        powertrain: 'ICE',
        odometerKm: 12000,
        createdAt,
      },
      {
        id: 'vehicle-b',
        name: '베타 차량',
        model: '기아 EV6 2024',
        powertrain: 'EV',
        odometerKm: 5000,
        createdAt,
      },
    ],
    selectedVehicleId: 'vehicle-b',
    plans: [
      plan('manual'),
      plan('live', {
        vehicleId: 'vehicle-b',
        eventTitle: '조회한 경로 일정',
        distanceKm: 14.2,
        originPoint: { latitude: 37.5547, longitude: 126.9726 },
        destinationPoint: { latitude: 37.5666, longitude: 126.9784 },
        route: {
          source: 'live',
          computedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 300000).toISOString(),
        },
      }),
      plan('mock', {
        eventTitle: '예시 경로 일정',
        source: 'sample',
        distanceKm: 2.4,
        originPoint: { latitude: 37.5547, longitude: 126.9726 },
        destinationPoint: { latitude: 37.5666, longitude: 126.9784 },
        route: { source: 'mock', computedAt: createdAt, expiresAt: past },
      }),
      plan('past', { eventTitle: '지난 미팅 일정', eventAt: past }),
    ],
    trips: [
      {
        id: 'trip-a',
        vehicleId: 'vehicle-a',
        planId: 'past',
        startedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        endedAt: past,
        distanceKm: 12.5,
        durationSeconds: 1200,
        source: 'manual',
        destination: '완료한 실제 기록',
      },
    ],
  };
}

async function openTrips(page: Page, history = false) {
  await page.addInitScript((state) => {
    if (!localStorage.getItem('@drivemate/state:v1'))
      localStorage.setItem('@drivemate/state:v1', JSON.stringify(state));
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        watchPosition() {
          throw new Error('Listing plans must not request GPS');
        },
        getCurrentPosition() {
          throw new Error('Listing plans must not request GPS');
        },
        clearWatch() {},
      },
    });
  }, fixture());
  await page.route('**/api/**', (route) => route.abort());
  await page.goto(history ? '/trips?view=history' : '/trips');
  await expect(page.getByRole('heading', { name: '이동 계획', exact: true })).toBeVisible();
}

test('scheduled list keeps vehicle binding, dates and truthful route/notification sources', async ({
  page,
}, testInfo) => {
  await openTrips(page);
  await expect(page.getByRole('tab', { name: '예정', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByText('예정 3', { exact: true })).toBeVisible();
  const manual = page.getByTestId('trip-plan-manual');
  await expect(manual.getByText('알파 차량', { exact: true })).toBeVisible();
  await expect(page.getByText('새 계획에 사용할 차량: 베타 차량', { exact: true })).toBeVisible();
  await expect(manual.getByText('00:30 도착', { exact: true })).toBeVisible();
  await expect(manual.getByText('23:20 권장 출발', { exact: true })).toBeVisible();
  await expect(manual.getByText(/출발$/).filter({ hasNotText: '권장 출발' })).toBeVisible();
  await expect(
    manual.getByText('입력한 예상 시간 기준 · 실시간 교통 미반영', { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('trip-plan-live').getByText(/^서버 경로 ·/)).toBeVisible();
  await expect(
    page.getByTestId('trip-plan-mock').getByText(/^예시 경로 ·.*유효 시간 지남$/),
  ).toBeVisible();
  await expect(page.getByTestId('trip-plan-past')).toHaveCount(0);
  await expect(page.getByRole('switch')).toHaveCount(0);
  await expect(manual.getByText('출발 알림 · 앱에서 설정', { exact: true })).toBeVisible();
  await expect(
    page.getByText('기기 간 위치 확인은 로그인 후 사용할 수 있어요.', { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('scheduled.png'), fullPage: true });
  await manual.getByRole('button', { name: '자정 이후 미팅 이동 계획 보기', exact: true }).click();
  await expect(page).toHaveURL(/\/route\?id=manual/);
});

test('completed deep link separates elapsed schedules and preserves trip after confirmed plan deletion', async ({
  page,
}) => {
  await openTrips(page, true);
  await expect(page.getByRole('tab', { name: '완료', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByText('완료한 실제 기록', { exact: true })).toBeVisible();
  await expect(
    page.getByText('도착 시간이 지난 계획이에요. 실제 주행 완료 여부와는 별개예요.', {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: '완료한 실제 기록의 이동 계획 보기', exact: true })
    .click();
  await expect(page).toHaveURL(/\/route\?id=past/);
  await page.goto('/trips?view=history');
  const past = page.getByTestId('trip-plan-past');
  await expect(
    past.getByRole('button', { name: '지난 미팅 일정 계획 삭제', exact: true }),
  ).toHaveCount(0);
  await past.getByRole('button', { name: '지난 미팅 일정 더 보기', exact: true }).click();
  await past.getByRole('button', { name: '지난 미팅 일정 계획 삭제', exact: true }).click();
  await expect(
    past.getByText('이 이동 계획을 삭제할까요? 주행 기록은 유지돼요.', { exact: true }),
  ).toBeVisible();
  await past.getByRole('button', { name: '취소', exact: true }).click();
  await expect(past).toBeVisible();
  await past.getByRole('button', { name: '지난 미팅 일정 더 보기', exact: true }).click();
  await past.getByRole('button', { name: '지난 미팅 일정 계획 삭제', exact: true }).click();
  await past.getByRole('button', { name: '계획 삭제', exact: true }).click();
  await expect(past).toHaveCount(0);
  await expect(page.getByText('완료한 실제 기록', { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem('@drivemate/state:v1')!).plans.length),
    )
    .toBe(3);
  await page.reload();
  await expect(page.getByText('완료한 실제 기록', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: '완료한 실제 기록의 이동 계획 보기', exact: true }),
  ).toHaveCount(0);
});

test('360px schedule layout retains usable actions without horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await openTrips(page);
  await expect(page.getByRole('button', { name: '새 계획', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '일정으로 계획', exact: true })).toBeVisible();
  const overflow = await page.getByTestId('trip-plan-manual').evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return [...element.querySelectorAll('*')].some((child) => {
      const rect = child.getBoundingClientRect();
      return rect.width > 0 && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1);
    });
  });
  expect(overflow).toBe(false);
  const more = page.getByRole('button', { name: '자정 이후 미팅 더 보기', exact: true });
  const bounds = await more.boundingBox();
  expect(bounds?.width).toBeGreaterThanOrEqual(44);
  expect(bounds?.height).toBeGreaterThanOrEqual(44);
  await page.getByRole('tab', { name: '완료', exact: true }).click();
  await expect(page.getByText('완료한 실제 기록', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '예정', exact: true }).click();
  await expect(page.getByTestId('trip-plan-manual')).toBeVisible();
});

test('external Kakao navigation uses saved coordinates and names-only plans use search', async ({
  page,
}) => {
  await openTrips(page);
  await page.getByRole('button', { name: '조회한 경로 일정 이동 계획 보기', exact: true }).click();
  await page.evaluate(() => {
    window.open = (url) => {
      localStorage.setItem('test:kakao-link', String(url));
      return null;
    };
  });
  await expect(
    page.getByText('카카오맵 앱 또는 웹에서 선택한 출발지와 도착지의 자동차 경로를 열어요.', {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: '카카오맵에서 길안내', exact: true }).click();
  const link = new URL((await page.evaluate(() => localStorage.getItem('test:kakao-link')))!);
  expect(link.origin).toBe('https://map.kakao.com');
  expect(decodeURIComponent(link.pathname)).toBe(
    '/link/by/car/서울역,37.5547,126.9726/강남역,37.5666,126.9784',
  );
  await page.goto('/route?id=manual');
  await page.evaluate(() => {
    window.open = (url) => {
      localStorage.setItem('test:kakao-link', String(url));
      return null;
    };
  });
  await page.getByRole('button', { name: '카카오맵에서 목적지 검색', exact: true }).click();
  const search = new URL((await page.evaluate(() => localStorage.getItem('test:kakao-link')))!);
  expect(search.origin).toBe('https://map.kakao.com');
  expect(decodeURIComponent(search.pathname)).toBe('/link/search/강남역');
});
