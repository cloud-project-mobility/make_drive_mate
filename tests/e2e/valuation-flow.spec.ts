import { expect, test, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

async function start(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '예시 차량으로 둘러보기', exact: true }).click();
  await expect(page.getByRole('tab', { name: '홈', exact: true })).toBeVisible();
  await page.goto('/analysis');
  await expect(page.getByTestId('valuation-advice')).toHaveText('12개월 후 매도를 검토해요');
}

async function selectVehicle(page: Page, name: string) {
  await page.getByRole('button', { name: '뒤로', exact: true }).click();
  await page.getByRole('tab', { name: '내 차', exact: true }).click();
  await page.getByRole('button', { name: '차량 선택', exact: true }).click();
  await page.getByRole('button', { name, exact: true }).click();
}

test('closing or cancelling offline changes discards the draft and its validation errors', async ({
  page,
}) => {
  await start(page);
  const offline = page.getByTestId('offline-valuation');
  await offline.getByRole('button', { name: '내 조건으로 비교하기', exact: true }).click();
  const budget = offline.getByRole('textbox', {
    name: '누적 추가 보유 비용 한도 (만원)',
    exact: true,
  });
  await budget.fill('250');
  await expect(
    offline.getByText('아직 적용하지 않은 변경이 있어요', { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('valuation-advice')).toHaveText('12개월 후 매도를 검토해요');
  await offline.getByRole('button', { name: '입력창 닫기', exact: true }).click();
  await expect(
    offline.getByRole('button', { name: '분석 조건 바꾸기', exact: true }),
  ).toBeFocused();
  await offline.getByRole('button', { name: '분석 조건 바꾸기', exact: true }).click();
  await expect(budget).toHaveValue('700');
  await budget.fill('');
  await offline.getByRole('button', { name: '이 조건으로 다시 비교', exact: true }).click();
  await expect(budget).toBeFocused();
  await expect(budget).toHaveAttribute('aria-invalid', 'true');
  await offline.getByRole('button', { name: '변경 취소', exact: true }).click();
  await expect(
    offline.getByRole('button', { name: '분석 조건 바꾸기', exact: true }),
  ).toBeFocused();
  await offline.getByRole('button', { name: '분석 조건 바꾸기', exact: true }).click();
  await expect(budget).toHaveValue('700');
  await expect(budget).not.toHaveAttribute('aria-invalid', 'true');
  await expect(offline.getByText('입력값을 확인해 주세요', { exact: true })).toHaveCount(0);
});

test('applying offline conditions returns to that result and synchronizes the selected horizon', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await start(page);
  const offline = page.getByTestId('offline-valuation');
  const modelRequests: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/(valuation|assistant)\//.test(request.url()))
      modelRequests.push(request.url());
  });
  await offline.getByRole('button', { name: '내 조건으로 비교하기', exact: true }).click();
  await offline
    .getByRole('textbox', { name: '누적 추가 보유 비용 한도 (만원)', exact: true })
    .fill('250');
  await offline.getByRole('button', { name: '이 조건으로 다시 비교', exact: true }).click();
  await expect(page.getByTestId('valuation-applied')).toBeFocused();
  await expect(page.getByTestId('valuation-applied')).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId('valuation-advice')).toHaveText('6개월 후 매도를 검토해요');
  await expect(page.getByTestId('valuation-advice')).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId('onbid-analytics')).not.toBeInViewport();
  await expect(page.getByTestId('scenario-6')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('scenario-detail-title')).toContainText('6개월 후');
  await expect(page.getByTestId('vehicle-odometer')).toHaveText('48,250');
  expect(modelRequests).toEqual([]);
  await testInfo.attach('offline-applied-decision-360px', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  await page.getByTestId('scenario-24').press('Enter');
  await expect(page.getByTestId('scenario-24')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('scenario-detail-title')).toContainText('24개월 후');
  const accessibility = await new AxeBuilder({ page })
    .include('[data-testid="offline-valuation"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
});

test('quotes and vehicle changes keep offline values and decisions in their own context', async ({
  page,
}) => {
  await start(page);
  const offline = page.getByTestId('offline-valuation');
  await offline.getByRole('button', { name: '분석 조건 바꾸기', exact: true }).click();
  await offline
    .getByRole('textbox', { name: '최근 매입견적 (만원, 선택)', exact: true })
    .fill('1850');
  await offline
    .getByRole('textbox', { name: '견적일 (YYYY-MM-DD, 선택)', exact: true })
    .fill('2026-11-02');
  await offline.getByRole('button', { name: '이 조건으로 다시 비교', exact: true }).click();
  await expect(page.getByTestId('current-simulated-value')).toHaveText('1,850 만원');
  await offline.getByRole('button', { name: '분석 조건 바꾸기', exact: true }).click();
  await offline
    .getByRole('textbox', { name: '최근 매입견적 (만원, 선택)', exact: true })
    .fill('1900');
  await expect(page.getByTestId('current-simulated-value')).toHaveText('1,850 만원');
  await offline.getByRole('button', { name: '이 조건으로 다시 비교', exact: true }).click();
  await expect(page.getByTestId('current-simulated-value')).toHaveText('1,900 만원');

  await selectVehicle(page, '우리 집 K5');
  await page.getByRole('button', { name: '차량 정보 수정', exact: true }).click();
  await page
    .getByRole('textbox', { name: '제조사 · 모델 · 연식', exact: true })
    .fill('기아 K5 2006');
  await page.getByRole('button', { name: '변경사항 저장', exact: true }).click();
  await page.goto('/analysis');
  await expect(offline.getByText('합성 데이터 · 규칙 기반 목업', { exact: true })).toBeVisible();
  await expect(page.getByTestId('valuation-advice')).toHaveText('현재 조건으로는 제안을 유보해요');
  await expect(page.getByTestId('scenario-0')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('scenario-detail-title')).toContainText('지금 매도하면');
  await offline.getByRole('button', { name: '분석 조건 바꾸기', exact: true }).click();
  await expect(
    offline.getByRole('textbox', { name: '최근 매입견적 (만원, 선택)', exact: true }),
  ).toHaveValue('');
  await selectVehicle(page, '나의 아반떼');
  await page.goto('/analysis');
  await expect(page.getByTestId('current-simulated-value')).toHaveText('1,809 만원');
  await expect(page.getByTestId('scenario-12')).toHaveAttribute('aria-pressed', 'true');
});
