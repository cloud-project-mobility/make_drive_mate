import { expect, test, type Page } from '@playwright/test';

async function start(page: Page) {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: '내 차의 가치, 다음 타이밍을 읽다.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '예시 차량으로 둘러보기', exact: true }).click();
  await expect(page.getByTestId('current-simulated-value')).toHaveText('1,809 만원');
}

test('the default synthetic example exposes provenance, all horizons and cost decomposition', async ({
  page,
}) => {
  await start(page);
  await expect(page.getByText('합성 데이터 · 규칙 기반 목업', { exact: true })).toBeVisible();
  await expect(page.getByTestId('valuation-advice')).toHaveText('12개월 후 매도를 검토해요');
  for (const month of [0, 6, 12, 24])
    await expect(page.getByTestId(`scenario-${month}`)).toBeVisible();
  await page.getByTestId('scenario-24').click();
  await expect(page.getByTestId('scenario-detail-title')).toHaveText(
    '24개월 후 매도하면, 추가 보유 비용은',
  );
  await expect(page.getByTestId('scenario-24')).toContainText('789만원');
  await page.getByTestId('scenario-0').click();
  await expect(page.getByTestId('scenario-detail-title')).toHaveText(
    '지금 매도하면, 추가 보유 비용은',
  );
  await expect(page.getByTestId('scenario-0')).toContainText('0만원');
  await page.getByRole('button', { name: '계산 가정과 데이터 상태', exact: true }).click();
  await expect(page.getByText(/학습된 AI나 실거래 가격 예측기가 아니에요/)).toBeVisible();
  await expect(page.getByText(/통계적 신뢰구간이 아니에요/)).toBeVisible();
});

test('editing inputs changes the valuation and preferences change the candidate without modifying the garage', async ({
  page,
}) => {
  await start(page);
  await page.getByRole('button', { name: '분석 조건 바꾸기', exact: true }).click();
  await page
    .getByRole('textbox', { name: '누적 추가 보유 비용 한도 (만원)', exact: true })
    .fill('250');
  await page.getByRole('button', { name: '이 조건으로 다시 비교', exact: true }).click();
  await expect(page.getByTestId('valuation-advice')).toHaveText('6개월 후 매도를 검토해요');
  await page.getByRole('button', { name: '분석 조건 바꾸기', exact: true }).click();
  await page.getByRole('textbox', { name: '분석 연식 (년)', exact: true }).fill('2022');
  await page.getByRole('textbox', { name: '분석 누적 주행거리 (km)', exact: true }).fill('70000');
  await page.getByRole('textbox', { name: '월 예상 주행거리 (km)', exact: true }).fill('2500');
  await page.getByRole('button', { name: '이 조건으로 다시 비교', exact: true }).click();
  await expect(page.getByTestId('current-simulated-value')).not.toHaveText('1,809 만원');
  await expect(page.getByTestId('vehicle-odometer')).toHaveText('48,250');
  await page.reload();
  await expect(page.getByTestId('current-simulated-value')).toHaveText('1,809 만원');
  await expect(page.getByTestId('valuation-advice')).toHaveText('12개월 후 매도를 검토해요');
});

test('invalid input cannot silently update results and unknown history or impossible goals defer advice', async ({
  page,
}) => {
  await start(page);
  await page.getByRole('button', { name: '분석 조건 바꾸기', exact: true }).click();
  await page.getByRole('textbox', { name: '분석 연식 (년)', exact: true }).fill('');
  await page.getByRole('button', { name: '이 조건으로 다시 비교', exact: true }).click();
  await expect(page.getByText('입력값을 확인해 주세요', { exact: true })).toBeVisible();
  await expect(page.getByTestId('current-simulated-value')).toHaveText('1,809 만원');
  await page.getByRole('textbox', { name: '분석 연식 (년)', exact: true }).fill('2023');
  await page.getByRole('button', { name: '이력 미확인', exact: true }).click();
  await page.getByRole('button', { name: '이 조건으로 다시 비교', exact: true }).click();
  await expect(page.getByTestId('valuation-advice')).toHaveText('이력 확인 후 다시 비교해요');
  await page.getByRole('button', { name: '분석 조건 바꾸기', exact: true }).click();
  await page.getByRole('button', { name: '무사고·비침수 가정', exact: true }).click();
  await page.getByRole('textbox', { name: '목표 최소 매도가 (만원)', exact: true }).fill('9000');
  await page.getByRole('button', { name: '이 조건으로 다시 비교', exact: true }).click();
  await expect(page.getByTestId('valuation-advice')).toHaveText('현재 조건으로는 제안을 유보해요');
});

test('360px and desktop screens keep input and comparison controls readable without overflow', async ({
  page,
}) => {
  await start(page);
  for (const width of [360, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.getByRole('button', { name: '분석 조건 바꾸기', exact: true }).click();
    await expect(
      page.getByRole('textbox', { name: '월 예상 주행거리 (km)', exact: true }),
    ).toBeVisible();
    const overflow = await page.evaluate(
      () =>
        Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
        window.innerWidth,
    );
    expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(1);
    const button = page.getByRole('button', { name: '이 조건으로 다시 비교', exact: true });
    expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await button.click();
    await page.getByTestId('scenario-6').click();
    await expect(page.getByTestId('scenario-detail-title')).toContainText('6개월 후');
  }
});

test('an optional dated quote changes the anchor while stale quotes are rejected', async ({
  page,
}) => {
  await start(page);
  await page.getByRole('button', { name: '분석 조건 바꾸기', exact: true }).click();
  await page.getByRole('textbox', { name: '최근 매입견적 (만원, 선택)', exact: true }).fill('1850');
  await page
    .getByRole('textbox', { name: '견적일 (YYYY-MM-DD, 선택)', exact: true })
    .fill('2026-10-01');
  await page.getByRole('button', { name: '이 조건으로 다시 비교', exact: true }).click();
  await expect(
    page.getByText('견적일은 기준일 2026-11-02까지 최근 30일 이내의 실제 날짜로 입력해 주세요.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByTestId('current-simulated-value')).toHaveText('1,809 만원');
  await page
    .getByRole('textbox', { name: '견적일 (YYYY-MM-DD, 선택)', exact: true })
    .fill('2026-11-02');
  await page.getByRole('button', { name: '이 조건으로 다시 비교', exact: true }).click();
  await expect(page.getByTestId('current-simulated-value')).toHaveText('1,850 만원');
  await expect(page.getByText('입력 견적 기준 · 미래는 가정', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '분석 조건 바꾸기', exact: true }).click();
  await page.getByRole('textbox', { name: '최근 매입견적 (만원, 선택)', exact: true }).fill('');
  await page.getByRole('textbox', { name: '견적일 (YYYY-MM-DD, 선택)', exact: true }).fill('');
  await page.getByRole('button', { name: '이 조건으로 다시 비교', exact: true }).click();
  await expect(page.getByTestId('current-simulated-value')).toHaveText('1,809 만원');
});

test('a registered vehicle without a year requires analysis input instead of inventing a year', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '내 차량으로 시작하기', exact: true }).click();
  await page.getByRole('button', { name: '첫 차량 등록', exact: true }).click();
  await page.getByRole('textbox', { name: '차량 이름', exact: true }).fill('연식 확인할 차');
  await page
    .getByRole('textbox', { name: '제조사 · 모델 · 연식', exact: true })
    .fill('현대 아반떼');
  await page.getByRole('textbox', { name: '현재 누적 주행거리 (km)', exact: true }).fill('48250');
  await page.getByRole('button', { name: '차량 등록하기', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '분석 연식 (년)', exact: true })).toHaveValue('');
  await expect(page.getByTestId('current-simulated-value')).toHaveCount(0);
  await expect(page.getByTestId('valuation-advice')).toHaveCount(0);
  await page.getByRole('textbox', { name: '분석 연식 (년)', exact: true }).fill('2023');
  await page.getByRole('button', { name: '이 조건으로 다시 비교', exact: true }).click();
  await expect(page.getByTestId('current-simulated-value')).toHaveText('1,809 만원');
});
