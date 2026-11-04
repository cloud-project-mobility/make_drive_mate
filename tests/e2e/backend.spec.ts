import { expect, test, type Page } from '@playwright/test';

const backendUrl = process.env.DRIVEMATE_BACKEND_URL;
test.skip(
  !backendUrl,
  'Set DRIVEMATE_BACKEND_URL to a running mock-mode backend for real HTTP integration tests.',
);

async function register(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '예시 차량으로 둘러보기', exact: true }).click();
  await page.getByRole('tab', { name: '설정', exact: true }).click();
  await page.getByRole('textbox', { name: '백엔드 서버 주소', exact: true }).fill(backendUrl!);
  await page.getByRole('button', { name: '서버 연결 확인', exact: true }).click();
  await expect(page.getByText('서버 연결됨 · 외부 데이터는 예시', { exact: true })).toBeVisible();
  const email = `browser-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  const password = 'local-demo-only-2026';
  await page.getByRole('textbox', { name: '테스트 계정 이메일', exact: true }).fill(email);
  await page.getByLabel('테스트 계정 비밀번호', { exact: true }).fill(password);
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

test('real local account stores a revisioned backup, restores after confirmation, and never persists a bearer', async ({
  page,
}) => {
  const credentials = await register(page);
  await page.getByRole('button', { name: '외부 연동 준비 상태 확인', exact: true }).click();
  await expect(page.getByText('예시 데이터 · 실제 계정 연결 안 됨', { exact: true })).toHaveCount(
    3,
  );
  await expect(
    page.getByRole('button', { name: 'Google 캘린더 연결 준비', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '서버 백업 확인', exact: true }).click();
  await expect(
    page.getByText('이 계정에는 아직 서버 백업이 없어요.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '현재 기기 데이터를 서버에 저장', exact: true }).click();
  await page.getByRole('button', { name: '서버에 저장 확정', exact: true }).click();
  await expect(page.getByText('서버 백업 버전 1에 저장했어요.', { exact: true })).toBeVisible();
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
  await expect(page.getByRole('textbox', { name: '백엔드 서버 주소', exact: true })).toHaveValue(
    backendUrl!,
  );
  await page
    .getByRole('textbox', { name: '테스트 계정 이메일', exact: true })
    .fill(credentials.email);
  await page.getByLabel('테스트 계정 비밀번호', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: '로컬 서버 로그인', exact: true }).click();
  await page.getByRole('button', { name: '서버 백업 확인', exact: true }).click();
  await expect(page.getByText(/서버 버전 1 · 차량 3대/)).toBeVisible();
  await page.getByRole('button', { name: '로컬 서버 로그아웃', exact: true }).click();
  await expect(page.getByRole('button', { name: '로컬 서버 로그인', exact: true })).toBeVisible();
});

test('real mock providers import timed and all-day events, calculate selected coordinates, and preserve source labels', async ({
  page,
}) => {
  await register(page);
  await page.getByRole('tab', { name: '가치 분석', exact: true }).click();
  await page.getByRole('button', { name: '차량 정보 수정', exact: true }).click();
  await page.getByRole('button', { name: '서버 예시 차량 상태 확인', exact: true }).click();
  await expect(page.getByText('예시 차량 · 현대 계정 연결 안 됨', { exact: true })).toBeVisible();
  await expect(page.getByText(/관측 시각의 시간대가 확인되지 않았어요/)).toBeVisible();
  await page.getByRole('button', { name: '뒤로', exact: true }).click();
  await expect(page.getByText('48,250', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '이동 계획', exact: true }).click();
  await page.getByRole('button', { name: '일정으로 계획', exact: true }).click();
  await page.getByRole('button', { name: '서버 캘린더 일정 불러오기', exact: true }).click();
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
  await page.getByRole('button', { name: '외부 연동 준비 상태 확인', exact: true }).click();
  await expect(page.getByText('예시 데이터 · 실제 계정 연결 안 됨', { exact: true })).toHaveCount(
    3,
  );
  await expect(
    page.getByRole('button', { name: 'Google 캘린더 연결 준비', exact: true }),
  ).toHaveCount(0);
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
    await page.getByRole('button', { name: '서버 캘린더 일정 불러오기', exact: true }).click();
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
      page.getByRole('button', { name: '서버 캘린더 일정 불러오기', exact: true }),
    ).toBeDisabled();
  });
}
