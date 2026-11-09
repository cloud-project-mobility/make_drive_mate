import { expect, test } from '@playwright/test';

test('vehicle fields expose their guidance and errors while remaining keyboard accessible', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '내 차량으로 시작하기', exact: true }).click();
  await page.getByRole('tab', { name: '내 차', exact: true }).click();
  await page.getByRole('button', { name: '첫 차량 등록', exact: true }).click();

  const name = page.getByRole('textbox', { name: '차량 이름', exact: true });
  const model = page.getByRole('textbox', { name: '제조사 · 모델 · 연식', exact: true });
  const distance = page.getByRole('textbox', { name: '현재 누적 주행거리 (km)', exact: true });
  const save = page.getByRole('button', { name: '차량 등록하기', exact: true });
  const guidance = '계기판에 표시된 누적 주행거리를 입력해 주세요.';
  const vehicleName = '우리 가족의 안전한 출퇴근과 주말 여행을 위한 첫번째차';

  await expect(distance).toHaveAccessibleDescription(guidance);
  const distanceDescriptionId = await distance.getAttribute('aria-describedby');
  const inputIds = await Promise.all(
    [name, model, distance].map((input) => input.getAttribute('id')),
  );
  expect(inputIds.every(Boolean)).toBe(true);
  expect(new Set(inputIds).size).toBe(3);
  await expect(name).toHaveAttribute('aria-labelledby', /\S+/);

  await save.focus();
  await save.press('Enter');
  for (const [input, error] of [
    [name, '차량 이름을 입력해 주세요.'],
    [model, '제조사·모델·연식을 입력해 주세요.'],
    [distance, '누적 주행거리에 0 이상의 숫자를 입력해 주세요.'],
  ] as const) {
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(input).toHaveAccessibleDescription(error);
    await expect(page.getByText(error, { exact: true })).toHaveAttribute('aria-live', 'polite');
  }
  await expect(distance).toHaveAttribute('aria-describedby', distanceDescriptionId!);

  // A second submission keeps the invalid name/model visible but restores the valid field's hint.
  await distance.fill('12,500');
  await save.focus();
  await save.press('Enter');
  await expect(distance).not.toHaveAttribute('aria-invalid', 'true');
  await expect(distance).toHaveAccessibleDescription(guidance);
  await expect(distance).toHaveAttribute('aria-describedby', distanceDescriptionId!);
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  expect(
    await Promise.all([name, model, distance].map((input) => input.getAttribute('id'))),
  ).toEqual(inputIds);

  await name.focus();
  await page.keyboard.insertText(vehicleName);
  await page.keyboard.press('Tab');
  await expect(model).toBeFocused();
  await page.keyboard.insertText('현대 아반떼 2023');
  await page.keyboard.press('Tab');
  await expect(distance).toBeFocused();
  await expect(page.getByRole('button', { name: '내연기관', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: '하이브리드', exact: true }).click();
  await expect(page.getByRole('button', { name: '하이브리드', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: '내연기관', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await save.focus();
  await save.press('Enter');

  await page.getByRole('tab', { name: '내 차', exact: true }).click();
  await expect(page.getByRole('heading', { name: '내 차', exact: true })).toBeVisible();
  const selector = page.getByRole('button', { name: '차량 선택', exact: true });
  await expect(selector).toContainText(vehicleName);
  await expect(selector.locator('..').getByTestId('vehicle-odometer')).toHaveText('12,500');
  await selector.click();
  await expect(page.getByRole('button', { name: vehicleName, exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(
    await page.evaluate(
      () =>
        Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
        window.innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
});
