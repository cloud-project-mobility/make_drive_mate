import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

// Optional real Spring server. Ordinary UI runs do not require an external backend.
const backendUrl = process.env.DRIVEMATE_CATALOG_BACKEND_URL?.replace(/\/$/, '');

async function startEmptyGarage(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '내 차량으로 시작하기', exact: true }).click();
  await expect(page.getByRole('button', { name: '첫 차량 등록', exact: true })).toBeVisible();
}

async function selectSorento(page: Page, name = '나의 쏘렌토') {
  await page.getByRole('button', { name: '첫 차량 등록', exact: true }).click();
  await page.getByRole('textbox', { name: '차종 검색', exact: true }).fill('쏘렌토');
  const option = page.getByRole('button', { name: /^기아 쏘렌토 .* 선택$/ });
  await expect(option.locator('img')).toHaveAttribute('src', /sorento-mq4-pe.*\.png(?:$|[?&#])/);
  await option.click();
  await page.getByRole('textbox', { name: '차량 이름', exact: true }).fill(name);
  await page.getByRole('textbox', { name: '현재 누적 주행거리 (km)', exact: true }).fill('24680');
}

async function expectSavedSorento(page: Page, name: string) {
  const card = page.getByRole('button', { name, exact: true });
  await expect(card).toBeVisible();
  await expect(card.locator('img')).toHaveAttribute('src', /sorento-mq4-pe.*\.png(?:$|[?&#])/);
  await expect.poll(() => card.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByTestId('vehicle-odometer')).toHaveText('24,680');
}

async function loginThroughSettings(page: Page, url: string, email: string, password: string) {
  await page.getByRole('tab', { name: '설정', exact: true }).click();
  await page.getByRole('textbox', { name: '백엔드 서버 주소', exact: true }).fill(url);
  await page.getByRole('button', { name: '서버 연결 확인', exact: true }).click();
  await expect(page.getByText('서버 응답을 확인했어요. 아래에서 로컬 서버 계정을 사용할 수 있어요.', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '테스트 계정 이메일', exact: true }).fill(email);
  await page.getByLabel('테스트 계정 비밀번호', { exact: true }).fill(password);
  const loginResponse = page.waitForResponse((response) =>
    response.url() === `${url}/api/v1/auth/login` && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '로컬 서버 로그인', exact: true }).click();
  const response = await loginResponse;
  expect(response.ok(), 'The real Spring login succeeds').toBe(true);
  const session = await response.json();
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '가치 분석', exact: true }).click();
  return session.access_token as string;
}

test('a signed-out driver searches the catalog, supplies the required year and keeps the selected photo after reload', async ({ page }) => {
  await startEmptyGarage(page);
  await selectSorento(page);
  await expect(page.getByText('현재는 이 기기에 저장돼요.', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '차량 연식 (년)', exact: true })).toHaveValue('');
  await page.getByRole('button', { name: '차량 등록하기', exact: true }).click();
  await expect(page.getByText(/차량등록증의 연식을 입력해 주세요\./)).toBeVisible();
  await page.getByRole('textbox', { name: '차량 연식 (년)', exact: true }).fill('2024');
  await page.getByRole('button', { name: '차량 등록하기', exact: true }).click();
  await expectSavedSorento(page, '나의 쏘렌토');
  await page.reload();
  await expectSavedSorento(page, '나의 쏘렌토');
  await page.getByRole('button', { name: '차량 정보 수정', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '차량 연식 (년)', exact: true })).toHaveValue('2024');
  await expect(page.getByRole('textbox', { name: '현재 누적 주행거리 (km)', exact: true })).toHaveValue('24680');
});

test('a real Spring account saves the catalog vehicle and imports it into a fresh browser context', async ({ page, browser, request, baseURL }) => {
  test.skip(!backendUrl, 'Set DRIVEMATE_CATALOG_BACKEND_URL to a running disposable Spring backend.');
  const url = backendUrl!;
  const email = `catalog-${randomUUID()}@example.test`;
  const password = `Catalog-${randomUUID()}-9!`;
  let cleanupToken: string | undefined;
  let secondContext: BrowserContext | undefined;
  try {
    const registered = await request.post(`${url}/api/v1/auth/register`, { data: { email, password } });
    expect(registered.status()).toBe(201);
    cleanupToken = (await registered.json()).access_token as string;
    await startEmptyGarage(page);
    cleanupToken = await loginThroughSettings(page, url, email, password);
    await selectSorento(page, '계정의 쏘렌토');
    await expect(page.getByText('등록하면 로그인한 계정에도 저장돼요.', { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: '차량 연식 (년)', exact: true }).fill('2024');
    const savedResponse = page.waitForResponse((response) =>
      response.url().startsWith(`${url}/api/v1/vehicles/`) && response.request().method() === 'PUT',
    );
    await page.getByRole('button', { name: '차량 등록하기', exact: true }).click();
    const saved = await savedResponse;
    expect(saved.ok()).toBe(true);
    const vehicle = (await saved.json()).vehicle;
    expect(vehicle).toMatchObject({ name: '계정의 쏘렌토', catalogId: 'sorento-mq4-pe', powertrain: 'HYB', odometerKm: 24680 });
    await expectSavedSorento(page, '계정의 쏘렌토');
    const stored = await request.get(`${url}/api/v1/vehicles`, {
      headers: { Authorization: `Bearer ${cleanupToken}` },
    });
    expect(stored.ok()).toBe(true);
    expect((await stored.json()).vehicles).toEqual([vehicle]);
    const storage = await page.evaluate(() => JSON.stringify(localStorage));
    expect(storage.includes(cleanupToken)).toBe(false);
    expect(storage.includes(password)).toBe(false);

    // The second context has no device state, cookies or in-memory login session.
    secondContext = await browser.newContext({ baseURL });
    const secondPage = await secondContext.newPage();
    await startEmptyGarage(secondPage);
    cleanupToken = await loginThroughSettings(secondPage, url, email, password);
    await secondPage.getByRole('button', { name: '계정 차량 불러오기', exact: true }).click();
    await expect(secondPage.getByText('계정의 쏘렌토', { exact: true })).toBeVisible();
    await secondPage.getByRole('button', { name: '이 기기에 추가', exact: true }).click();
    await expectSavedSorento(secondPage, '계정의 쏘렌토');
    await secondPage.reload();
    await expectSavedSorento(secondPage, '계정의 쏘렌토');
  } finally {
    await secondContext?.close();
    if (cleanupToken) {
      const deleted = await request.delete(`${url}/api/v1/account`, {
        headers: { Authorization: `Bearer ${cleanupToken}` },
      });
      expect(deleted.ok(), 'The temporary account and its vehicles are deleted').toBe(true);
    }
  }
});
