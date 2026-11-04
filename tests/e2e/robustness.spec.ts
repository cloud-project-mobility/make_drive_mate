import { expect, test, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

const backendUrl = process.env.DRIVEMATE_BACKEND_URL;
test.skip(!backendUrl, 'Requires the disposable mock API from npm run test:integrated.');
test.use({ timezoneId: 'America/New_York' });

async function register(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '예시 차량으로 둘러보기', exact: true }).click();
  await page.getByRole('tab', { name: '설정', exact: true }).click();
  await page.getByRole('textbox', { name: '백엔드 서버 주소', exact: true }).fill(backendUrl!);
  await page.getByRole('button', { name: '서버 연결 확인', exact: true }).click();
  await expect(page.getByText('서버 연결됨 · 외부 데이터는 예시', { exact: true })).toBeVisible();
  const email = `robust-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  await page.getByRole('textbox', { name: '테스트 계정 이메일', exact: true }).fill(email);
  await page.getByLabel('테스트 계정 비밀번호', { exact: true }).fill('synthetic-test-only-2026');
  await page.getByRole('button', { name: '로컬 테스트 계정 만들기', exact: true }).click();
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  return email;
}

test('logout hides the old account and its backup while the real server response is delayed', async ({
  page,
}) => {
  const email = await register(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached!: () => void;
  const ready = new Promise<void>((resolve) => {
    reached = resolve;
  });
  await page.route('**/api/v1/auth/logout', async (route) => {
    const response = await route.fetch();
    reached();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: '로컬 서버 로그아웃', exact: true }).click();
    await ready;
    await expect(page.getByText(email, { exact: true })).toHaveCount(0, { timeout: 2000 });
    await expect(page.getByRole('button', { name: '서버 백업 확인', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '로컬 서버 로그인', exact: true })).toBeVisible();
  } finally {
    release();
  }
  await expect(page.getByRole('button', { name: '로컬 서버 로그인', exact: true })).toBeEnabled();
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('@drivemate/state:v1')!).vehicles.length,
    ),
  ).toBe(3);
});

test('an imported calendar instant in the second DST hour survives saving and reload', async ({
  page,
}, testInfo) => {
  await page.clock.setFixedTime(new Date('2026-10-28T12:00:00Z'));
  await register(page);
  await page.route('**/api/v1/calendar/events', async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.events = [
      {
        id: 'synthetic-dst',
        title: '[예시] 시차 일정',
        start_at: '2026-11-01T01:30:27-05:00',
        end_at: '2026-11-01T02:30:27-05:00',
        start_date: null,
        end_date: null,
        all_day: false,
        location: '서울시청',
      },
    ];
    await route.fulfill({ response, json: payload });
  });
  await page.getByRole('tab', { name: '이동 계획', exact: true }).click();
  await page.getByRole('button', { name: '일정으로 계획', exact: true }).click();
  await page.getByRole('button', { name: '서버 캘린더 일정 불러오기', exact: true }).click();
  await page.getByRole('button', { name: '[예시] 시차 일정 일정 선택', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '도착 시간 · 24시간', exact: true })).toHaveValue(
    '01:30',
  );
  await expect(
    page.getByRole('button', { name: '01:30 · UTC-05:00 선택', exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 360, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await page
    .getByRole('button', { name: '01:30 · UTC-05:00 선택', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('dst-plan-360.png'), fullPage: true });
  await page.getByRole('textbox', { name: '출발지', exact: true }).fill('서울역');
  await page.getByRole('button', { name: '계획 저장하고 확인', exact: true }).click();
  await expect(page.getByRole('heading', { name: '서울시청으로 이동', exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem('@drivemate/state:v1')!).plans[0].eventAt,
      ),
    )
    .toBe('2026-11-01T06:30:27.000Z');
  await page.reload();
  await expect(page.getByRole('heading', { name: '서울시청으로 이동', exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('@drivemate/state:v1')!).plans[0].eventAt,
    ),
  ).toBe('2026-11-01T06:30:27.000Z');
});

test('same-name selected places retain coordinates, route provenance, backup compatibility and expiry', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 37.5547, longitude: 126.9726, accuracy: 5 });
  await register(page);
  await page.route('**/api/v1/places?*', async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.places = payload.places.map((place: object) => ({ ...place, name: '동명 장소' }));
    await route.fulfill({ response, json: payload });
  });
  await page.getByRole('tab', { name: '이동 계획', exact: true }).click();
  await page.getByRole('button', { name: '일정으로 계획', exact: true }).click();
  await page.getByRole('textbox', { name: '출발지', exact: true }).fill('서울역');
  await page.getByRole('button', { name: '출발지 검색', exact: true }).click();
  await page.getByRole('button', { name: '출발지로 동명 장소 선택', exact: true }).click();
  await page.getByRole('textbox', { name: '도착지', exact: true }).fill('서울시청');
  await page.getByRole('button', { name: '도착지 검색', exact: true }).click();
  await page.getByRole('button', { name: '도착지로 동명 장소 선택', exact: true }).click();
  await page.getByRole('button', { name: '서버 경로 시간 적용', exact: true }).click();
  await expect(page.getByText(/예시 경로 · .* km · .*분/)).toBeVisible();
  await page.getByRole('button', { name: '계획 저장하고 확인', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '동명 장소으로 이동', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.open = (url) => {
      localStorage.setItem('test:last-map-url', String(url));
      return null;
    };
  });
  await page.getByRole('button', { name: '지도 앱에서 실제 경로 확인', exact: true }).click();
  const opened = new URL((await page.evaluate(() => localStorage.getItem('test:last-map-url')))!);
  expect(opened.searchParams.get('origin')).toBe('37.5547,126.9726');
  expect(opened.searchParams.get('destination')).toBe('37.5666,126.9784');
  await page.getByRole('button', { name: '나의 아반떼 · GPS 기록 시작', exact: true }).click();
  await expect(page.getByText('GPS 측정 중', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '뒤로', exact: true }).click();
  await page.getByRole('button', { name: '진행 중인 주행 확인', exact: true }).click();
  expect(new URL(page.url()).searchParams.has('id')).toBe(false);
  await page.getByRole('button', { name: '지도 앱에서 실제 경로 확인', exact: true }).click();
  const resumedMap = new URL(
    (await page.evaluate(() => localStorage.getItem('test:last-map-url')))!,
  );
  expect(resumedMap.searchParams.get('origin')).toBe('37.5547,126.9726');
  expect(resumedMap.searchParams.get('destination')).toBe('37.5666,126.9784');
  await page.getByRole('button', { name: '이번 측정 취소', exact: true }).click();
  await page.getByRole('button', { name: '측정 내용 버리기', exact: true }).click();
  const saved = await page.evaluate(
    () => JSON.parse(localStorage.getItem('@drivemate/state:v1')!).plans[0],
  );
  expect(saved.route.source).toBe('mock');
  const savedRouteUrl = `/route?id=${encodeURIComponent(saved.id)}`;
  await page.getByRole('button', { name: '뒤로', exact: true }).click();
  await page.getByRole('tab', { name: '설정', exact: true }).click();
  await page.getByRole('button', { name: '서버 백업 확인', exact: true }).click();
  await page.getByRole('button', { name: '현재 기기 데이터를 서버에 저장', exact: true }).click();
  await page.getByRole('button', { name: '서버에 저장 확정', exact: true }).click();
  await expect(page.getByText('서버 백업 버전 1에 저장했어요.', { exact: true })).toBeVisible();
  await page.goto(savedRouteUrl);
  await page.clock.setFixedTime(new Date(Date.parse(saved.route.expiresAt) + 1000));
  await page.reload();
  await expect(page.getByText('저장한 경로의 유효 시간이 지났어요', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('@drivemate/state:v1')!).plans[0].originPoint,
    ),
  ).toEqual(saved.originPoint);
});

test('a late route calculation never overwrites a newer manual driving time', async ({ page }) => {
  await register(page);
  await page.getByRole('tab', { name: '이동 계획', exact: true }).click();
  await page.getByRole('button', { name: '일정으로 계획', exact: true }).click();
  for (const [field, place] of [
    ['출발지', '서울역'],
    ['도착지', '서울시청'],
  ]) {
    await page.getByRole('textbox', { name: field, exact: true }).fill(place);
    await page.getByRole('button', { name: `${field} 검색`, exact: true }).click();
    await page.getByRole('button', { name: `${field}로 ${place} 선택`, exact: true }).click();
  }
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached!: () => void;
  const ready = new Promise<void>((resolve) => {
    reached = resolve;
  });
  await page.route('**/api/v1/routes', async (route) => {
    const response = await route.fetch();
    reached();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: '서버 경로 시간 적용', exact: true }).click();
    await ready;
    await page.getByRole('textbox', { name: '예상 운전 시간 (분)', exact: true }).fill('23');
  } finally {
    release();
  }
  await expect(
    page.getByText('검색 중 계획이 변경됐어요. 현재 정보로 다시 계산해 주세요.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: '예상 운전 시간 (분)', exact: true })).toHaveValue(
    '23',
  );
  await page.getByRole('button', { name: '계획 저장하고 확인', exact: true }).click();
  await expect(page.getByRole('heading', { name: '서울시청으로 이동', exact: true })).toBeVisible();
  const saved = await page.evaluate(
    () => JSON.parse(localStorage.getItem('@drivemate/state:v1')!).plans[0],
  );
  expect(saved.driveMinutes).toBe(23);
  expect(saved.route).toBeUndefined();
  expect(saved.originPoint).toBeDefined();
});
