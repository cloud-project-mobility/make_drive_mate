import { expect, test, type Page } from '@playwright/test';

const origin = 'https://drivemate-onboarding.test';
const email = 'onboarding-driver@example.test';
const password = 'synthetic-onboarding-password';

async function mockService(page: Page, baseURL: string, rejectFirstVehicle = false) {
  if ((page.viewportSize()?.width ?? 1440) < 600)
    await page.setViewportSize({ width: 360, height: 800 });
  const accounts: string[] = [];
  const vehicles: Record<string, unknown>[] = [];
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    const response = await page.request.get(`${baseURL}${url.pathname}${url.search}`);
    await route.fulfill({ response });
  });
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    expect(url.origin).toBe(origin);
    if (/\/auth\/(register|login)$/.test(url.pathname)) {
      accounts.push(url.pathname);
      expect(request.postDataJSON()).toEqual({ email, password });
      await route.fulfill({
        status: url.pathname.endsWith('register') ? 201 : 200,
        json: {
          access_token: 'synthetic-onboarding-session',
          token_type: 'bearer',
          user: { id: 'synthetic-onboarding-user', email },
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
    } else if (url.pathname.startsWith('/api/v1/vehicles/') && request.method() === 'PUT') {
      expect(request.headers().authorization).toBe('Bearer synthetic-onboarding-session');
      const vehicle = request.postDataJSON();
      vehicles.push(vehicle);
      await route.fulfill(
        rejectFirstVehicle && vehicles.length === 1
          ? {
              status: 503,
              json: { error: { code: 'synthetic_save_failed', message: '합성 서버 저장 실패' } },
            }
          : { status: 200, json: { vehicle } },
      );
    } else {
      await route.fulfill({
        status: 503,
        json: {
          error: { code: 'synthetic_unavailable', message: '합성 검사에서 사용하지 않는 연결' },
        },
      });
    }
  });
  await page.goto(origin);
  return { accounts, vehicles };
}

async function enterAccount(page: Page, mode: 'register' | 'login') {
  await page
    .getByRole('button', {
      name: mode === 'register' ? '계정 만들기' : '이미 계정이 있어요',
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/\/settings\?onboarding=1&mode=/);
  await expect(page.getByRole('button', { name: '기기 데이터 초기화', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('button', { name: '기기 설정 보기', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'DriveMate 계정 이메일', exact: true }).fill(email);
  await page.getByLabel('DriveMate 계정 비밀번호', { exact: true }).fill(password);
}

test('account registration is followed by one vehicle step and only successful server saves enter device state', async ({
  page,
  baseURL,
}) => {
  const { accounts, vehicles } = await mockService(page, baseURL!, true);
  await enterAccount(page, 'register');
  await page.getByLabel('DriveMate 계정 비밀번호', { exact: true }).fill('short');
  await page.getByRole('button', { name: '회원가입', exact: true }).click();
  await expect(
    page.getByText('새 계정은 10자 이상의 비밀번호를 입력해 주세요.', { exact: true }),
  ).toBeVisible();
  expect(accounts).toEqual([]);
  await page.getByLabel('DriveMate 계정 비밀번호', { exact: true }).fill(password);
  await page.getByRole('button', { name: '회원가입', exact: true }).click();
  await expect(page).toHaveURL(/\/vehicle\?onboarding=1$/);
  expect(accounts).toEqual(['/api/v1/auth/register']);
  await expect(
    page.getByText('등록하면 로그인한 계정에도 저장돼요.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '등록하고 시작하기', exact: true }).click();
  await expect(page.getByText('차량 이름을 입력해 주세요.', { exact: true })).toBeVisible();
  expect(vehicles).toEqual([]);
  await page.getByRole('textbox', { name: '차량 이름', exact: true }).fill('온보딩 차량');
  await page
    .getByRole('textbox', { name: '제조사 · 모델 · 연식', exact: true })
    .fill('현대 쏘나타 2023');
  await page.getByRole('textbox', { name: '현재 누적 주행거리 (km)', exact: true }).fill('12345');
  await page.getByRole('button', { name: '등록하고 시작하기', exact: true }).click();
  await expect(page.getByText('합성 서버 저장 실패', { exact: true })).toBeVisible();
  const readState = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem('@drivemate/state:v1')!));
  expect((await readState()).vehicles).toEqual([]);
  await page.getByRole('button', { name: '등록하고 시작하기', exact: true }).click();
  await expect(page).toHaveURL(origin + '/');
  expect(vehicles).toHaveLength(2);
  expect(vehicles[0].id).toBe(vehicles[1].id);
  await expect.poll(async () => (await readState()).vehicles.length).toBe(1);
  expect((await readState()).vehicles[0]).toMatchObject({
    name: '온보딩 차량',
    model: '현대 쏘나타 2023',
    odometerKm: 12345,
    powertrain: 'ICE',
  });
  const storage = await page.evaluate(() => JSON.stringify({ localStorage, sessionStorage }));
  expect(storage).not.toContain(password);
  expect(storage).not.toContain('synthetic-onboarding-session');
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
});

test('returning account login reaches registration but a reload cannot silently save as a signed-out account', async ({
  page,
  baseURL,
}) => {
  const { accounts, vehicles } = await mockService(page, baseURL!);
  await enterAccount(page, 'login');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page).toHaveURL(/\/vehicle\?onboarding=1$/);
  await page.reload();
  await expect(
    page.getByRole('button', { name: '로그인하고 차량 등록', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '등록하고 시작하기', exact: true })).toHaveCount(0);
  expect(accounts).toEqual(['/api/v1/auth/login']);
  expect(vehicles).toEqual([]);
  await page.getByRole('button', { name: '로그인하고 차량 등록', exact: true }).click();
  await expect(page.getByRole('heading', { name: '로그인', exact: true })).toBeVisible();
});

test('signed-out local experience keeps device management behind explicit choices and reset still needs confirmation', async ({
  page,
  baseURL,
}) => {
  await mockService(page, baseURL!);
  await page.getByRole('button', { name: '예시 차량으로 둘러보기', exact: true }).click();
  await page.getByRole('button', { name: '로그인 및 설정', exact: true }).click();
  await expect(page.getByRole('heading', { name: '로그인', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '기기 데이터 관리', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '기기 데이터 초기화', exact: true })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: '기기 설정 보기', exact: true }).click();
  await page.getByRole('button', { name: '운전·알림 설정', exact: true }).click();
  await page.getByRole('textbox', { name: '여유 시간 (분)', exact: true }).fill('15');
  await page.getByRole('button', { name: '기본 시간 저장', exact: true }).click();
  await expect(page.getByText('저장 완료', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '기기 데이터 관리', exact: true }).click();
  await page.getByRole('button', { name: '기기 데이터 초기화', exact: true }).click();
  await expect(page.getByText('모든 로컬 데이터를 삭제할까요?', { exact: true })).toBeVisible();
  expect(
    (await page.evaluate(() => JSON.parse(localStorage.getItem('@drivemate/state:v1')!))).vehicles,
  ).toHaveLength(3);
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await expect(page.getByRole('button', { name: '모든 데이터 삭제', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '기기 데이터 초기화', exact: true }).click();
  await page.getByRole('button', { name: '모든 데이터 삭제', exact: true }).click();
  await expect(page.getByRole('button', { name: '계정 만들기', exact: true })).toBeVisible();
});
