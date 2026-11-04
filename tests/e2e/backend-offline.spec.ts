import { expect, test } from '@playwright/test';

test('unavailable backend and invalid URL show recoverable errors while the offline garage remains usable', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '예시 차량으로 둘러보기', exact: true }).click();
  await page.getByRole('button', { name: '로그인 및 설정', exact: true }).click();
  await page.getByRole('button', { name: '서버 설정 펼치기', exact: true }).click();
  await page
    .getByRole('textbox', { name: '백엔드 서버 주소', exact: true })
    .fill('http://127.0.0.1:1');
  await page.getByRole('button', { name: '서버 연결 확인', exact: true }).click();
  await expect(
    page.getByText('서버에 연결하지 못했어요. 주소, 서버 실행 상태와 네트워크를 확인해 주세요.', {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole('textbox', { name: '백엔드 서버 주소', exact: true })
    .fill('https://user:password@example.test');
  await page.getByRole('button', { name: '서버 연결 확인', exact: true }).click();
  await expect(
    page.getByText(
      '서버 주소에는 호스트와 포트만 입력해 주세요. 계정 정보나 경로는 포함할 수 없어요.',
      { exact: true },
    ),
  ).toBeVisible();
  await page.goto('/analysis');
  await expect(page.getByText('48,250', { exact: true })).toBeVisible();
});
