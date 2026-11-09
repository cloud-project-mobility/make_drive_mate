import { expect, test, type Page } from '@playwright/test';

const backendUrl = process.env.DRIVEMATE_BACKEND_URL;
test.skip(
  !backendUrl,
  'Set DRIVEMATE_BACKEND_URL to a running mock-mode backend for real HTTP integration tests.',
);

async function register(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '예시 차량으로 둘러보기', exact: true }).click();
  await page.getByRole('button', { name: '로그인 및 설정', exact: true }).click();
  await page.getByRole('button', { name: '서버 설정 펼치기', exact: true }).click();
  await page.getByRole('textbox', { name: '백엔드 서버 주소', exact: true }).fill(backendUrl!);
  await page.getByRole('button', { name: '서버 연결 확인', exact: true }).click();
  await expect(page.getByText('서버 연결됨 · 외부 데이터는 예시', { exact: true })).toBeVisible();
  const email = `browser-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  const password = 'local-demo-only-2026';
  await page.getByRole('textbox', { name: '테스트 계정 이메일', exact: true }).fill(email);
  await page.getByLabel('테스트 계정 비밀번호', { exact: true }).fill(password);
  await page.getByRole('button', { name: '회원가입으로 전환', exact: true }).click();
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/auth/register') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '로컬 테스트 계정 만들기', exact: true }).click();
  const response = await responsePromise;
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  await expect(page.getByText(email, { exact: true })).toBeVisible({ timeout: 15000 });
  return { email, password, token: session.access_token as string };
}

async function openServiceAccount(page: Page, baseURL: string, successfulRegistration = false) {
  const origin = 'https://drivemate-login.test';
  const calls: string[] = [];
  if ((page.viewportSize()?.width ?? 1440) < 600) {
    await page.setViewportSize({ width: 360, height: 800 });
  }
  await page.route(`${origin}/**`, async (route) => {
    const requested = new URL(route.request().url());
    const response = await page.request.get(`${baseURL}${requested.pathname}${requested.search}`);
    await route.fulfill({ response });
  });
  await page.route('**/api/v1/**', async (route) => {
    const requested = new URL(route.request().url());
    expect(requested.origin).toBe(origin);
    // The public reference catalog is read on mount, independently of account actions.
    if (requested.pathname !== '/api/v1/vehicle-catalog') calls.push(requested.pathname);
    if (requested.pathname.endsWith('/auth/login')) {
      await route.fulfill({
        status: 401,
        json: { error: { code: 'invalid_credentials', message: '확인 필요' } },
      });
    } else if (requested.pathname.endsWith('/auth/register')) {
      await route.fulfill(
        successfulRegistration
          ? {
              status: 201,
              json: {
                access_token: 'synthetic-service-session-token',
                token_type: 'bearer',
                user: { id: 'synthetic-service-user', email: 'service-user@example.test' },
                expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              },
            }
          : { status: 403, json: { error: { code: 'email_reserved', message: '확인 필요' } } },
      );
    } else if (requested.pathname.endsWith('/auth/password')) {
      expect(route.request().headers().authorization).toBe(
        'Bearer synthetic-service-session-token',
      );
      const body = route.request().postDataJSON();
      expect(body.new_password).toBe('synthetic-new-password');
      await route.fulfill(
        body.current_password === 'synthetic-service-password'
          ? { status: 200, json: { ok: true, reauthentication_required: true } }
          : {
              status: 400,
              json: {
                error: {
                  code: 'invalid_current_password',
                  message: '현재 비밀번호를 확인해 주세요.',
                },
              },
            },
      );
    } else if (requested.pathname.endsWith('/integrations')) {
      await route.fulfill({
        status: 200,
        json: {
          provider_mode: 'live',
          providers: {
            kakao: {
              mode: 'live',
              configured: true,
              connected: false,
              live_verified: true,
              auth_type: 'api_key',
              requires_user_consent: false,
              reason: 'verified',
              capabilities: {
                places: {
                  configured: true,
                  live_verified: true,
                  last_verified_at: '2026-11-04T12:00:00Z',
                },
                routes: { configured: true, live_verified: false, last_verified_at: null },
              },
            },
            google_calendar: {
              mode: 'live',
              configured: false,
              connected: false,
              live_verified: false,
            },
            hyundai: {
              mode: 'live',
              configured: false,
              connected: false,
              live_verified: false,
              reason: 'implementation_pending',
            },
          },
        },
      });
    } else if (requested.pathname.endsWith('/auth/logout')) {
      await route.fulfill({ status: 200, json: { ok: true } });
    } else {
      await route.fulfill({
        status: 503,
        json: { error: { code: 'synthetic_unavailable', message: '예시 미연결' } },
      });
    }
  });
  await page.goto(origin);
  await page.getByRole('button', { name: '예시 차량으로 둘러보기', exact: true }).click();
  await page.getByRole('button', { name: '로그인 및 설정', exact: true }).click();
  return { calls, origin };
}

test('HTTPS service account hides server settings and explains account-specific login errors', async ({
  page,
  baseURL,
}) => {
  const { calls, origin } = await openServiceAccount(page, baseURL!);
  await expect(page.getByRole('heading', { name: '로그인', exact: true })).toBeVisible();
  await expect(page.getByText(/Google·AWS·현대 계정 로그인과는 별개/)).toBeVisible();
  await expect(page.getByRole('textbox', { name: '백엔드 서버 주소', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '서버 설정 펼치기', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '백엔드 서버 주소', exact: true })).toHaveValue(
    origin,
  );
  await page.getByRole('button', { name: '서버 설정 접기', exact: true }).click();
  expect(calls).toEqual([]);
  await page
    .getByRole('textbox', { name: 'DriveMate 계정 이메일', exact: true })
    .fill('service-user@example.test');
  await page
    .getByLabel('DriveMate 계정 비밀번호', { exact: true })
    .fill('synthetic-service-password');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(
    page.getByText(
      'DriveMate에 가입한 이메일과 비밀번호를 확인해 주세요. 로컬 PC 계정은 자동으로 연결되지 않아요.',
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: '회원가입으로 전환', exact: true }).click();
  await page.getByRole('button', { name: '회원가입', exact: true }).click();
  await expect(
    page.getByText(
      '이 이메일은 별도 계정 설정이 필요해요. 운영자에게 최초 로그인 안내를 요청해 주세요.',
      { exact: true },
    ),
  ).toBeVisible();
  expect(calls).toEqual(['/api/v1/auth/login', '/api/v1/auth/register']);
});

test('HTTPS service account registration preserves session and logout behavior without storing credentials', async ({
  page,
  baseURL,
}) => {
  const { calls } = await openServiceAccount(page, baseURL!, true);
  await page
    .getByRole('textbox', { name: 'DriveMate 계정 이메일', exact: true })
    .fill('service-user@example.test');
  await page
    .getByLabel('DriveMate 계정 비밀번호', { exact: true })
    .fill('synthetic-service-password');
  await page.getByRole('button', { name: '회원가입으로 전환', exact: true }).click();
  await page.getByRole('button', { name: '회원가입', exact: true }).click();
  await expect(
    page.getByText('DriveMate 회원가입을 마치고 로그인했어요.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('service-user@example.test', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '백엔드 서버 주소', exact: true })).toHaveCount(0);
  const saved = await page.evaluate(() => JSON.stringify(localStorage));
  expect(saved).not.toContain('synthetic-service-session-token');
  expect(saved).not.toContain('synthetic-service-password');
  await page.getByRole('button', { name: '외부 서비스 연결', exact: true }).click();
  await page.getByRole('button', { name: '외부 연동 준비 상태 확인', exact: true }).click();
  await expect(
    page.getByText('서비스 키 연결 · 실제 조회 이력 있음', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/개인 카카오 계정 로그인은 필요하지 않아요/)).toBeVisible();
  await expect(page.getByText(/장소 검색: 실제 조회 확인됨/)).toBeVisible();
  await expect(page.getByText('길찾기: 준비됨 · 실제 조회 확인 전', { exact: true })).toBeVisible();
  await expect(
    page.getByText('실차 연동 준비 중 · 아직 연결 안 됨', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('서버 설정 준비됨 · 계정 연결 전', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(page.getByRole('button', { name: '로그인', exact: true })).toBeVisible();
  expect(calls).toEqual([
    '/api/v1/auth/register',
    '/api/v1/integrations', // Calendar checks its own connection when the panel opens.
    '/api/v1/integrations', // Explicit general-provider readiness refresh.
    '/api/v1/auth/logout',
  ]);
});

test('HTTPS service account password change validates confirmation and returns to login after success', async ({
  page,
  baseURL,
}) => {
  const { calls } = await openServiceAccount(page, baseURL!, true);
  await page
    .getByRole('textbox', { name: 'DriveMate 계정 이메일', exact: true })
    .fill('service-user@example.test');
  await page
    .getByLabel('DriveMate 계정 비밀번호', { exact: true })
    .fill('synthetic-service-password');
  await page.getByRole('button', { name: '회원가입으로 전환', exact: true }).click();
  await page.getByRole('button', { name: '회원가입', exact: true }).click();
  await page.getByRole('button', { name: '계정 보안', exact: true }).click();
  await page.getByRole('button', { name: '비밀번호 변경', exact: true }).click();
  await page.getByLabel('현재 비밀번호', { exact: true }).fill('synthetic-wrong-password');
  await page.getByLabel('새 비밀번호', { exact: true }).fill('synthetic-new-password');
  await page.getByLabel('새 비밀번호 확인', { exact: true }).fill('synthetic-mismatch');
  await page.getByRole('button', { name: '비밀번호 변경 확정', exact: true }).click();
  await expect(
    page.getByText('새 비밀번호와 확인 입력이 일치하지 않아요.', { exact: true }),
  ).toBeVisible();
  expect(calls).toEqual(['/api/v1/auth/register']);
  await page.getByLabel('새 비밀번호 확인', { exact: true }).fill('synthetic-new-password');
  await page.getByRole('button', { name: '비밀번호 변경 확정', exact: true }).click();
  await expect(page.getByText('현재 비밀번호를 확인해 주세요.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  await page.getByLabel('현재 비밀번호', { exact: true }).fill('synthetic-service-password');
  await page.getByRole('button', { name: '비밀번호 변경 확정', exact: true }).click();
  await expect(
    page.getByText(
      '비밀번호를 변경했어요. 모든 기기에서 로그아웃되었으니 새 비밀번호로 로그인해 주세요.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '로그인', exact: true })).toBeVisible();
  await expect(page.getByLabel('현재 비밀번호', { exact: true })).toHaveCount(0);
  const saved = await page.evaluate(() => JSON.stringify(localStorage));
  expect(saved).not.toContain('synthetic-new-password');
  expect(saved).not.toContain('synthetic-service-session-token');
  expect(calls).toEqual([
    '/api/v1/auth/register',
    '/api/v1/auth/password',
    '/api/v1/auth/password',
    '/api/v1/auth/logout',
  ]);
});

test('real local account stores a revisioned backup, restores after confirmation, and never persists a bearer', async ({
  page,
}) => {
  const credentials = await register(page);
  await page.getByRole('button', { name: '외부 서비스 연결', exact: true }).click();
  await page.getByRole('button', { name: '외부 연동 준비 상태 확인', exact: true }).click();
  await expect(page.getByText('예시 데이터 · 실제 계정 연결 안 됨', { exact: true })).toHaveCount(
    2,
  );
  await expect(
    page.getByRole('button', { name: 'Google 캘린더 연결 준비', exact: true }),
  ).toHaveCount(0);
  if ((await page.getByRole('button', { name: '서버 백업 확인', exact: true }).count()) === 0)
    await page.getByRole('button', { name: '계정별 서버 백업', exact: true }).click();
  await page.getByRole('button', { name: '서버 백업 확인', exact: true }).click();
  await expect(
    page.getByText('이 계정에는 아직 서버 백업이 없어요.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '현재 기기 데이터를 서버에 저장', exact: true }).click();
  await page.getByRole('button', { name: '서버에 저장 확정', exact: true }).click();
  await expect(page.getByText('서버 백업 버전 1에 저장했어요.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '운전·알림 설정', exact: true }).click();
  await page.getByRole('textbox', { name: '여유 시간 (분)', exact: true }).fill('25');
  await page.getByRole('button', { name: '기본 시간 저장', exact: true }).click();
  await page.getByRole('button', { name: '서버 백업을 기기에 복원', exact: true }).click();
  await expect(
    page.getByText('서버 백업으로 현재 기기 데이터를 바꿀까요?', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '기기에 복원 확정', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '여유 시간 (분)', exact: true })).toHaveValue(
    '10',
  );
  const storage = await page.evaluate(() => JSON.stringify(localStorage));
  expect(storage).not.toContain('access_token');
  expect(storage).not.toContain(credentials.password);
  await page.reload();
  await expect(page.getByRole('button', { name: '로컬 서버 로그인', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '서버 설정 펼치기', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '백엔드 서버 주소', exact: true })).toHaveValue(
    backendUrl!,
  );
  await page
    .getByRole('textbox', { name: '테스트 계정 이메일', exact: true })
    .fill(credentials.email);
  await page.getByLabel('테스트 계정 비밀번호', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: '로컬 서버 로그인', exact: true }).click();
  if ((await page.getByRole('button', { name: '서버 백업 확인', exact: true }).count()) === 0)
    await page.getByRole('button', { name: '계정별 서버 백업', exact: true }).click();
  await page.getByRole('button', { name: '서버 백업 확인', exact: true }).click();
  await expect(page.getByText(/서버 버전 1 · 차량 3대/)).toBeVisible();
  await page.getByRole('button', { name: '로컬 서버 로그아웃', exact: true }).click();
  await expect(page.getByRole('button', { name: '로컬 서버 로그인', exact: true })).toBeVisible();
});

test('real mock providers import timed and all-day events, calculate selected coordinates, and preserve source labels', async ({
  page,
}) => {
  await register(page);
  await page.getByRole('tab', { name: '내 차', exact: true }).click();
  await page.getByRole('button', { name: '차량 정보 수정', exact: true }).click();
  await page.getByRole('button', { name: '차량 연동 상태', exact: true }).click();
  await page.getByRole('button', { name: '서버 예시 차량 상태 확인', exact: true }).click();
  await expect(page.getByText('예시 차량 · 현대 계정 연결 안 됨', { exact: true })).toBeVisible();
  await expect(page.getByText(/관측 시각의 시간대가 확인되지 않았어요/)).toBeVisible();
  await page.getByRole('button', { name: '뒤로', exact: true }).click();
  const vehicleSummary = page
    .getByRole('button', { name: '차량 선택', exact: true })
    .locator('..')
    .locator('..');
  await expect(vehicleSummary.getByTestId('vehicle-odometer')).toHaveText('48,250');
  await page.getByRole('tab', { name: '이동 계획', exact: true }).click();
  await page.getByRole('button', { name: '일정으로 계획', exact: true }).click();
  await page.getByRole('button', { name: '예시 캘린더 일정 불러오기', exact: true }).click();
  await expect(page.getByText('서버 예시 일정 · Google 연결 안 됨', { exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: '[예시] 프로젝트 자료 정리 일정 선택', exact: true })
    .click();
  await expect(page.getByRole('textbox', { name: '도착 시간 · 24시간', exact: true })).toHaveValue(
    '',
  );
  await expect(
    page.getByText('종일 일정이에요. 실제 도착 시간을 직접 입력해 주세요.', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: '[예시] 온라인 회의 · 장소 없음 일정 선택', exact: true })
    .click();
  await expect(page.getByRole('textbox', { name: '도착지', exact: true })).toHaveValue('');
  await page
    .getByRole('button', { name: '[예시] 조별 프로젝트 회의 일정 선택', exact: true })
    .click();
  await expect(page.getByRole('textbox', { name: '도착지', exact: true })).toHaveValue('서울시청');
  await page.getByRole('textbox', { name: '출발지', exact: true }).fill('없는 장소 이름');
  await page.getByRole('button', { name: '출발지 검색', exact: true }).click();
  await expect(
    page.getByText('검색 결과가 없어요. 장소 이름을 확인해 주세요.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('textbox', { name: '출발지', exact: true }).fill('서울역');
  await page.getByRole('button', { name: '출발지 검색', exact: true }).click();
  await page.getByRole('button', { name: '출발지로 서울역 선택', exact: true }).click();
  await page.getByRole('button', { name: '도착지 검색', exact: true }).click();
  await page.getByRole('button', { name: '도착지로 서울시청 선택', exact: true }).click();
  await page.getByRole('button', { name: '서버 경로 시간 적용', exact: true }).click();
  await expect(page.getByText(/예시 경로 · .* km · .*분/)).toBeVisible();
  await expect(page.getByRole('textbox', { name: '예상 운전 시간 (분)', exact: true })).toHaveValue(
    '8',
  );
  await page.getByRole('textbox', { name: '출발지', exact: true }).fill('서울역 다른 출구');
  await page.getByRole('button', { name: '계획 저장하고 확인', exact: true }).click();
  await expect(page.getByRole('heading', { name: '일정으로 계획', exact: true })).toBeVisible();
  await expect(
    page
      .getByText(
        '경로 계산 후 장소나 시간이 바뀌었어요. 경로를 다시 계산하거나 예상 운전 시간을 직접 입력해 주세요.',
        { exact: true },
      )
      .first(),
  ).toBeVisible();
  await page.getByRole('textbox', { name: '출발지', exact: true }).fill('서울역');
  await page.getByRole('button', { name: '서버 경로 시간 적용', exact: true }).click();
  await expect(page.getByText(/예시 경로 · .* km · .*분/)).toBeVisible();
  // Only this place response is controlled: same label, different identity and coordinates.
  // Route calculations before and after the check still use the real mock-mode backend.
  await page.route(
    (url) => url.pathname === '/api/v1/places',
    async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      payload.places[0] = {
        ...payload.places[0],
        id: 'same-name-other-coordinate',
        longitude: 126.9784,
        latitude: 37.5666,
        address: '동일한 이름의 다른 장소 테스트',
      };
      await route.fulfill({ response, json: payload });
    },
    { times: 1 },
  );
  await page.getByRole('button', { name: '출발지 검색', exact: true }).click();
  await page.getByRole('button', { name: '출발지로 서울역 선택', exact: true }).click();
  await page.getByRole('button', { name: '계획 저장하고 확인', exact: true }).click();
  await expect(page.getByRole('heading', { name: '일정으로 계획', exact: true })).toBeVisible();
  await expect(
    page
      .getByText(
        '경로 계산 후 장소나 시간이 바뀌었어요. 경로를 다시 계산하거나 예상 운전 시간을 직접 입력해 주세요.',
        { exact: true },
      )
      .first(),
  ).toBeVisible();
  await page.getByRole('button', { name: '출발지 검색', exact: true }).click();
  await page.getByRole('button', { name: '출발지로 서울역 선택', exact: true }).click();
  await page.getByRole('button', { name: '서버 경로 시간 적용', exact: true }).click();
  await expect(page.getByText(/예시 경로 · .* km · .*분/)).toBeVisible();
  await page.getByRole('button', { name: '계획 저장하고 확인', exact: true }).click();
  await expect(page.getByText('예시 일정 또는 경로', { exact: true })).toBeVisible();
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('@drivemate/state:v1')!),
  );
  expect(stored.plans[0].source).toBe('sample');
  expect(stored.plans[0].distanceKm).toBeGreaterThan(0);
  expect(stored.vehicles[0].odometerKm).toBe(48250);
});

test('real backend rejects stale snapshot upload without replacing either copy', async ({
  page,
  request,
}) => {
  const credentials = await register(page);
  await page.getByRole('button', { name: '외부 서비스 연결', exact: true }).click();
  await page.getByRole('button', { name: '외부 연동 준비 상태 확인', exact: true }).click();
  await expect(page.getByText('예시 데이터 · 실제 계정 연결 안 됨', { exact: true })).toHaveCount(
    2,
  );
  await expect(
    page.getByRole('button', { name: 'Google 캘린더 연결 준비', exact: true }),
  ).toHaveCount(0);
  if ((await page.getByRole('button', { name: '서버 백업 확인', exact: true }).count()) === 0)
    await page.getByRole('button', { name: '계정별 서버 백업', exact: true }).click();
  await page.getByRole('button', { name: '서버 백업 확인', exact: true }).click();
  await expect(
    page.getByText('이 계정에는 아직 서버 백업이 없어요.', { exact: true }),
  ).toBeVisible();
  const login = await request.post(`${backendUrl}/api/v1/auth/login`, {
    data: { email: credentials.email, password: credentials.password },
  });
  expect(login.ok()).toBeTruthy();
  const session = await login.json();
  const state = await page.evaluate(() => JSON.parse(localStorage.getItem('@drivemate/state:v1')!));
  state.settings.walkMinutes = 17;
  const concurrent = await request.put(`${backendUrl}/api/v1/state`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
    data: { expected_revision: 0, state },
  });
  expect(concurrent.ok()).toBeTruthy();
  await page.getByRole('button', { name: '현재 기기 데이터를 서버에 저장', exact: true }).click();
  const conflictResponse = page.waitForResponse(
    (response) => response.url().endsWith('/api/v1/state') && response.request().method() === 'PUT',
  );
  await page.getByRole('button', { name: '서버에 저장 확정', exact: true }).click();
  expect((await conflictResponse).status()).toBe(409);
  const preserved = await request.get(`${backendUrl}/api/v1/state`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  expect((await preserved.json()).state.settings.walkMinutes).toBe(17);
  await expect(
    page.getByRole('button', { name: '현재 기기 데이터를 서버에 저장', exact: true }),
  ).toHaveCount(0);
  if ((await page.getByRole('button', { name: '서버 백업 확인', exact: true }).count()) === 0)
    await page.getByRole('button', { name: '계정별 서버 백업', exact: true }).click();
  await page.getByRole('button', { name: '서버 백업 확인', exact: true }).click();
  await expect(page.getByText(/서버 버전 1 · 차량 3대/)).toBeVisible();
});

test('revoked server session requires fresh login and preserves device data', async ({
  page,
  request,
}) => {
  const credentials = await register(page);
  const result = await request.post(`${backendUrl}/api/v1/auth/logout`, {
    headers: { Authorization: `Bearer ${credentials.token}` },
  });
  expect(result.ok()).toBeTruthy();
  if ((await page.getByRole('button', { name: '서버 백업 확인', exact: true }).count()) === 0)
    await page.getByRole('button', { name: '계정별 서버 백업', exact: true }).click();
  await page.getByRole('button', { name: '서버 백업 확인', exact: true }).click();
  await expect(
    page.getByText(
      '서버 세션이 만료되거나 해제됐어요. 기기 기록은 유지돼요. 다시 로그인해 주세요.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '로컬 서버 로그인', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '서버 백업 확인', exact: true })).toHaveCount(0);
  const state = await page.evaluate(() => JSON.parse(localStorage.getItem('@drivemate/state:v1')!));
  expect(state.vehicles).toHaveLength(3);
});

for (const delayed of [false, true]) {
  test(`calendar ${delayed ? 'late responses' : 'cached results'} cannot cross a revoked account session`, async ({
    page,
    request,
  }) => {
    const credentials = await register(page);
    await page.getByRole('tab', { name: '이동 계획', exact: true }).click();
    await page.getByRole('button', { name: '일정으로 계획', exact: true }).click();
    let releaseResponse: (() => void) | undefined;
    let responseReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      responseReady = resolve;
    });
    await page.route(
      (url) => url.pathname === '/api/v1/calendar/events',
      async (route) => {
        const response = await route.fetch();
        const payload = await response.json();
        payload.events[0].title = '[예시] 이전 계정의 일정';
        if (delayed)
          await new Promise<void>((resolve) => {
            releaseResponse = resolve;
            responseReady?.();
          });
        await route.fulfill({ response, json: payload });
      },
      { times: 1 },
    );
    await page.getByRole('button', { name: '예시 캘린더 일정 불러오기', exact: true }).click();
    if (delayed) await ready;
    else
      await expect(
        page.getByRole('button', { name: '[예시] 이전 계정의 일정 일정 선택', exact: true }),
      ).toBeVisible();
    const revoked = await request.post(`${backendUrl}/api/v1/auth/logout`, {
      headers: { Authorization: `Bearer ${credentials.token}` },
    });
    expect(revoked.ok()).toBeTruthy();
    await page.getByRole('textbox', { name: '출발지', exact: true }).fill('서울역');
    await page.getByRole('button', { name: '출발지 검색', exact: true }).click();
    await expect(
      page.getByRole('button', { name: '설정에서 로컬 서버 연결', exact: true }),
    ).toBeVisible();
    if (delayed) {
      const finished = page.waitForResponse((response) =>
        response.url().includes('/api/v1/calendar/events'),
      );
      releaseResponse?.();
      await finished;
    }
    await expect(
      page.getByRole('button', { name: '[예시] 이전 계정의 일정 일정 선택', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: '예시 캘린더 일정 불러오기', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: '로그인 설정으로 이동', exact: true }),
    ).toBeVisible();
  });
}
