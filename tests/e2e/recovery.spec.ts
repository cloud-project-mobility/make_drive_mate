import { expect, test } from '@playwright/test';
const key = '@drivemate/state:v1';

test('direct links cannot create orphan data before local onboarding', async ({ page }) => {
  await page.goto('/vehicle');
  await expect(
    page.getByRole('button', { name: '내 차량으로 시작하기', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '차량 등록하기', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '내 차량으로 시작하기', exact: true }).click();
  await expect(page.getByRole('button', { name: '첫 차량 등록', exact: true })).toBeVisible();
});

test('corrupt storage stays intact until reviewed backup recovery', async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, '{unreadable-state'), key);
  await page.goto('/');
  await expect(page.getByText('저장된 기록을 확인해 주세요.', { exact: true })).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe('{unreadable-state');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '원본 데이터 내보내기', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^drivemate-recovery-.*\.json$/);
  await page.getByRole('button', { name: '손상 데이터 복구 안내', exact: true }).click();
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe('{unreadable-state');
  await page.getByRole('button', { name: '백업 후 새로 시작', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '내 차량으로 시작하기', exact: true }),
  ).toBeVisible();
  const copies = await page.evaluate(
    (key) =>
      Object.keys(localStorage)
        .filter((k) => k.startsWith(`${key}:recovery:`))
        .map((k) => localStorage.getItem(k)),
    key,
  );
  expect(copies).toEqual(['{unreadable-state']);
});

test('a failed local save is visible and retries the latest state', async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Object.defineProperty(window, '__failSave', { value: true, writable: true });
    Storage.prototype.setItem = function (key, value) {
      if (
        key === '@drivemate/state:v1' &&
        (window as unknown as { __failSave: boolean }).__failSave
      )
        throw new Error('simulated storage full');
      return original.call(this, key, value);
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: '내 차량으로 시작하기', exact: true }).click();
  await expect(page.getByText('저장하지 못한 변경사항이 있어요', { exact: true })).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBeNull();
  await page.evaluate(() => {
    (window as unknown as { __failSave: boolean }).__failSave = false;
  });
  await page.getByRole('button', { name: '저장 다시 시도', exact: true }).click();
  await expect(page.getByText('저장하지 못한 변경사항이 있어요', { exact: true })).toHaveCount(0);
  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), key);
  expect(saved.onboarded).toBe(true);
  expect(saved.vehicles).toEqual([]);
});
