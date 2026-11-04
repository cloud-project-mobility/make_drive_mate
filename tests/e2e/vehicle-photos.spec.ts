import { expect, test } from '@playwright/test';

test('vehicle cards show distinct local photos, preserve selection and expose photo provenance', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '예시 차량으로 둘러보기', exact: true }).click();
  for (const [name, file, distance] of [
    ['나의 아반떼', 'avante-cn7-pe', '48,250'],
    ['우리 집 K5', 'k5-dl3-pe', '26,340'],
    ['아이오닉 5', 'ioniq5-ne', '31,780'],
  ]) {
    const card = page.getByRole('button', { name, exact: true });
    await expect(card.locator('img')).toHaveAttribute('src', new RegExp(file));
    await expect(card.locator('img')).toHaveAttribute('src', /\.png(?:$|[?&#])/);
    await expect.poll(() => card.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    const transparentCorners = await card.locator('img').evaluate((image: HTMLImageElement) => {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      return [[0, 0], [canvas.width - 1, 0], [0, canvas.height - 1], [canvas.width - 1, canvas.height - 1]]
        .every(([x, y]) => context.getImageData(x, y, 1, 1).data[3] <= 1);
    });
    expect(transparentCorners, `${name} has a real transparent PNG background`).toBe(true);
    await card.click();
    await expect(card).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('vehicle-odometer')).toHaveText(distance);
  }
  await page.reload();
  await expect(page.getByRole('button', { name: '아이오닉 5', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '차량 사진 안내와 출처', exact: true }).click();
  await expect(page.getByText(/내 차량이나 개별 매물의 실제 사진이 아니에요/)).toBeVisible();
  await expect(page.getByRole('link', { name: '아반떼 사진 원본 · 외부 사이트', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '아이오닉 5 CC BY-SA 4.0 이용 조건 · 외부 사이트', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /사진 원본 · 외부 사이트$/ })).toHaveCount(10);
  await expect(page.getByText('이미지 편집: AI로 배경 제거·여백 조정.', { exact: true })).toBeVisible();
  await expect(page.getByText(/CC BY-SA로 표시한 사진의 편집본은 해당 원본과 동일한 라이선스로 제공해요/)).toBeVisible();
});

test('photo cards fit narrow and wide screens and unknown models keep a labelled fallback', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: '예시 차량으로 둘러보기', exact: true }).click();
  for (const width of [360, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const card = page.getByRole('button', { name: '우리 집 K5', exact: true });
    await card.click();
    await expect.poll(() => card.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath(`vehicle-cards-${width}.png`) });
  }
  await page.getByRole('button', { name: '차량 정보 수정', exact: true }).click();
  await page.getByRole('textbox', { name: '제조사 · 모델 · 연식', exact: true }).fill('기아 EV9 2024');
  await expect(page.getByText('차종 사진 준비 중 · 기본 이미지', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '변경사항 저장', exact: true }).click();
  await expect(page.getByRole('button', { name: '우리 집 K5', exact: true }).locator('img')).not.toHaveAttribute('src', /k5/);
});
