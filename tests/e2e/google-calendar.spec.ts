import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';

const backend = process.env.DRIVEMATE_BACKEND_URL;
test.skip(!backend, 'Run through test:integrated with its disposable Spring backend.');

// Real app and DriveMate authentication. Google endpoints below are explicit synthetic fixtures;
// GoogleCalendarApiTest separately exercises the real Spring OAuth/SQL/controller boundary.
async function fixture(page: Page, context: BrowserContext) {
  const state = {
    configured: true,
    connected: false,
    denied: false,
    revoked: false,
    empty: false,
    queryError: false,
    revocationFailed: false,
    held: null as null | { ready: () => void; promise: Promise<void> },
    authorizationCalls: 0,
    eventCalls: 0,
  };
  const start = new Date(Date.now() + 86_400_000);
  start.setHours(10, 0, 0, 0);
  const end = new Date(start.getTime() + 3_600_000);
  const day = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
  const next = new Date(start.getTime() + 86_400_000);
  const endDay = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
  const timed = {
    id: 'fixture-timed',
    title: '테스트 회의',
    start_at: start.toISOString(),
    end_at: end.toISOString(),
    start_date: null,
    end_date: null,
    all_day: false,
    location: '서울시청',
  };
  const allDay = {
    ...timed,
    id: 'fixture-all-day',
    title: '종일 테스트',
    start_at: null,
    end_at: null,
    start_date: day,
    end_date: endDay,
    all_day: true,
    location: null,
  };
  const noLocation = {
    ...timed,
    id: 'fixture-no-location',
    title: '장소 없는 테스트',
    location: null,
  };
  const fail = (route: Route, status: number, code: string, message: string) =>
    route.fulfill({ status, json: { error: { code, message } } });
  await context.route('**/api/v1/integrations', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.continue();
    const base = { mode: 'live', configured: false, connected: false, live_verified: false };
    await route.fulfill({
      json: {
        provider_mode: 'live',
        providers: {
          kakao: base,
          hyundai: base,
          google_calendar: { ...base, configured: state.configured, connected: state.connected },
        },
      },
    });
  });
  await context.route('**/api/v1/integrations/google/authorize', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.continue();
    state.authorizationCalls++;
    expect(route.request().headers().authorization).toMatch(/^Bearer /);
    await route.fulfill({
      json: {
        authorization_url:
          'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic-calendar-state',
        expires_in: 600,
      },
    });
  });
  await context.route('https://accounts.google.com/o/oauth2/v2/auth?**', async (route) => {
    // No real Google account, secret or consent is used by this browser suite.
    const outcome = state.denied ? 'error=access_denied' : 'code=synthetic-code';
    await route.fulfill({
      contentType: 'text/html',
      body: `<h1>Synthetic Google consent</h1><a href="${backend}/api/v1/integrations/google/callback?state=synthetic-calendar-state&${outcome}">Finish test consent</a>`,
    });
  });
  await context.route('**/api/v1/integrations/google/callback?**', async (route) => {
    state.connected = !state.denied;
    await route.fulfill({
      status: state.denied ? 400 : 200,
      contentType: 'text/html',
      body: `<h1>${state.denied ? 'Consent denied in fixture' : 'Consent completed in fixture'}</h1>`,
    });
  });
  await context.route('**/api/v1/integrations/google', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.continue();
    expect(route.request().method()).toBe('DELETE');
    state.connected = false;
    await route.fulfill({ json: { connected: false, provider_revoked: !state.revocationFailed } });
  });
  await context.route('**/api/v1/calendar/events', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.continue();
    state.eventCalls++;
    if (state.held) {
      state.held.ready();
      await state.held.promise;
    }
    if (state.revoked) {
      state.connected = false;
      return fail(
        route,
        401,
        'oauth_reauthorization_required',
        'Google 캘린더 연결 동의가 다시 필요합니다.',
      );
    }
    if (state.queryError)
      return fail(route, 502, 'provider_unavailable', '외부 서비스에 연결할 수 없습니다.');
    await route.fulfill({
      json: { source: 'live', events: state.empty ? [] : [timed, allDay, noLocation] },
    });
  });
  return { state, day, start };
}

async function register(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '예시 차량으로 둘러보기', exact: true }).click();
  await page.getByRole('button', { name: '로그인 및 설정', exact: true }).click();
  await page.getByRole('button', { name: '서버 설정 펼치기', exact: true }).click();
  await page.getByRole('textbox', { name: '백엔드 서버 주소', exact: true }).fill(backend!);
  await page.getByRole('button', { name: '서버 연결 확인', exact: true }).click();
  await expect(page.getByText('서버 연결됨 · 외부 데이터는 예시', { exact: true })).toBeVisible();
  const email = `calendar-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  await page.getByRole('textbox', { name: '테스트 계정 이메일', exact: true }).fill(email);
  await page
    .getByLabel('테스트 계정 비밀번호', { exact: true })
    .fill('calendar-test-password-2026');
  await page.getByRole('button', { name: '회원가입으로 전환', exact: true }).click();
  await page.getByRole('button', { name: '로컬 테스트 계정 만들기', exact: true }).click();
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  return email;
}
async function plan(page: Page) {
  await page.getByRole('tab', { name: '이동 계획', exact: true }).click();
  await page.getByRole('button', { name: '일정으로 계획', exact: true }).click();
}
async function consent(page: Page, denied = false) {
  await page.getByRole('button', { name: 'Google 캘린더 연결 준비', exact: true }).click();
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Google 인증 화면 열기', exact: true }).click();
  const popup = await popupPromise;
  await popup.getByRole('link', { name: 'Finish test consent', exact: true }).click();
  await expect(popup.getByRole('heading')).toHaveText(
    denied ? 'Consent denied in fixture' : 'Consent completed in fixture',
  );
  await popup.close();
  await page.bringToFront();
  await page.getByRole('button', { name: '캘린더 연결 상태 확인', exact: true }).click();
}

test('logged-out Calendar explains the required account and preserves manual planning', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '예시 차량으로 둘러보기', exact: true }).click();
  await plan(page);
  await expect(
    page.getByRole('button', { name: '로그인 설정으로 이동', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Google 캘린더 연결 준비', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '도착지', exact: true })).toBeEditable();
});

test('unconfigured Calendar never offers fake consent or blocks manual entry', async ({
  page,
  context,
}) => {
  const { state } = await fixture(page, context);
  state.configured = false;
  await register(page);
  await plan(page);
  await expect(
    page.getByText('아직 캘린더 연결을 사용할 수 없어요', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Google 캘린더 연결 준비', exact: true }),
  ).toHaveCount(0);
  expect(state.authorizationCalls).toBe(0);
});

test('consent, event reading and timed/all-day/missing-location imports work at both viewport sizes', async ({
  page,
  context,
}) => {
  const { day } = await fixture(page, context);
  if ((page.viewportSize()?.width ?? 1440) < 600)
    await page.setViewportSize({ width: 360, height: 800 });
  await register(page);
  await plan(page);
  await consent(page);
  await expect(page.getByText('Google 계정 연결됨', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Google 캘린더 일정 불러오기', exact: true }).click();
  await page.getByRole('button', { name: '테스트 회의 일정 선택', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '도착지', exact: true })).toHaveValue('서울시청');
  await expect(page.getByRole('textbox', { name: '도착 날짜', exact: true })).toHaveValue(day);
  await page.getByRole('button', { name: '종일 테스트 일정 선택', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '도착 시간 · 24시간', exact: true })).toHaveValue(
    '',
  );
  await expect(page.getByRole('textbox', { name: '도착 날짜', exact: true })).toHaveValue(day);
  await page.getByRole('button', { name: '장소 없는 테스트 일정 선택', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '도착지', exact: true })).toHaveValue('');
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBeTruthy();
});

test('denied consent can be retried without losing the DriveMate login', async ({
  page,
  context,
}) => {
  const { state } = await fixture(page, context);
  state.denied = true;
  await register(page);
  await plan(page);
  await consent(page, true);
  await expect(page.getByText('Google 계정 연결 필요', { exact: true })).toBeVisible();
  state.denied = false;
  await consent(page);
  await expect(page.getByText('Google 계정 연결됨', { exact: true })).toBeVisible();
  expect(state.authorizationCalls).toBe(2);
});

test('revoked access clears events and offers reconnection while keeping app login', async ({
  page,
  context,
}) => {
  const { state } = await fixture(page, context);
  state.connected = true;
  const email = await register(page);
  await plan(page);
  await page.getByRole('button', { name: 'Google 캘린더 일정 불러오기', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '테스트 회의 일정 선택', exact: true }),
  ).toBeVisible();
  state.revoked = true;
  await page.getByRole('button', { name: 'Google 캘린더 일정 불러오기', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Google 캘린더 연결 준비', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '테스트 회의 일정 선택', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '뒤로', exact: true }).click();
  await page.getByRole('button', { name: '계정 및 설정', exact: true }).click();
  await expect(page.getByText(email, { exact: true })).toBeVisible();
});

test('empty results and query failure allow retry without inventing events', async ({
  page,
  context,
}) => {
  const { state } = await fixture(page, context);
  state.connected = true;
  state.empty = true;
  await register(page);
  await plan(page);
  await page.getByRole('button', { name: 'Google 캘린더 일정 불러오기', exact: true }).click();
  await expect(
    page.getByText('앞으로 30일 동안 가져올 일정이 없어요', { exact: true }),
  ).toBeVisible();
  state.empty = false;
  state.queryError = true;
  await page.getByRole('button', { name: 'Google 캘린더 일정 불러오기', exact: true }).click();
  await expect(page.getByText('외부 서비스에 연결할 수 없습니다.', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: '테스트 회의 일정 선택', exact: true }),
  ).toHaveCount(0);
  state.queryError = false;
  await page.getByRole('button', { name: 'Google 캘린더 일정 불러오기', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '테스트 회의 일정 선택', exact: true }),
  ).toBeVisible();
});

test('disconnect clears visible Google events but preserves saved local plans', async ({
  page,
  context,
}) => {
  const { state } = await fixture(page, context);
  state.connected = true;
  state.revocationFailed = true;
  await register(page);
  await plan(page);
  const before = await page.evaluate(
    () => JSON.parse(localStorage.getItem('@drivemate/state:v1')!).plans,
  );
  await page.getByRole('button', { name: 'Google 캘린더 일정 불러오기', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '테스트 회의 일정 선택', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Google 캘린더 연결 해제', exact: true }).click();
  await page.getByRole('button', { name: 'Google 연결 해제 확정', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '테스트 회의 일정 선택', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(/Google 권한 철회는 확인하지 못했으니/)).toBeVisible();
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('@drivemate/state:v1')!).plans),
  ).toEqual(before);
});

test('a late event response cannot restore data after foreground connection refresh', async ({
  page,
  context,
}) => {
  const { state } = await fixture(page, context);
  state.connected = true;
  await register(page);
  await plan(page);
  let ready!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  state.held = {
    ready,
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  await page.getByRole('button', { name: 'Google 캘린더 일정 불러오기', exact: true }).click();
  await started;
  state.connected = false;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(
    page.getByRole('button', { name: 'Google 캘린더 연결 준비', exact: true }),
  ).toBeVisible();
  const completed = page.waitForResponse('**/api/v1/calendar/events');
  release();
  await completed;
  await expect(
    page.getByRole('button', { name: '테스트 회의 일정 선택', exact: true }),
  ).toHaveCount(0);
});
