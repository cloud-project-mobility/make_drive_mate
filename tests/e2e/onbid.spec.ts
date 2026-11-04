import { expect, test, type Page } from '@playwright/test';

const backendUrl = process.env.DRIVEMATE_BACKEND_URL;
test.skip(!backendUrl, 'Use npm run test:integrated with the key-free Spring backend.');

// These are synthetic UI-contract fixtures, never performance or price evidence.
const analytics = {
  schema_version: 'drivemate-cycle-v1',
  run_id: 'synthetic-ui-test',
  status: 'completed',
  generated_at: '2026-11-04T00:00:00Z',
  price_kind: 'auction_award',
  production_promoted: false,
  source: {
    mode: 'reuse',
    date_start: '2025-11-04',
    date_end: '2026-11-03',
    api_calls_this_run: 0,
    original_collection_calls: 1,
  },
  quality: {
    raw_rows: 100,
    passenger_rows: 80,
    clean_rows: 60,
    excluded_rows: 40,
    usable_percent_of_passenger: 75,
    missing_rates: { make: 25, fuel: 12.5 },
    exclusion_reason_counts: { non_passenger_category: 20 },
    exact_duplicate_rows: 0,
    repeated_vehicle_groups: 2,
  },
  model: {
    selected_model: 'random_forest_log',
    test_metrics: { rows: 20, mae_manwon: 240, wape_pct: 40 },
    service_support_audit: {
      test_rows: 20,
      supported_rows: 15,
      deferred_rows: 5,
      supported_percent: 75,
      supported_test_metrics: { mae_manwon: 130 },
    },
    split_counts: { train: 20, validation: 10, calibration: 10, test: 20 },
  },
  charts: {
    price_histogram: [{ label: '100~200만원', count: 20 }],
    top_models: [{ label: '예시 차종', count: 10 }],
    monthly_counts: [{ label: '2026-10', count: 10 }],
    category_counts: [{ label: '승용차', count: 80 }],
    model_comparison: [
      { label: 'extra_trees_log', mae_manwon: 190 },
      { label: 'random_forest_log', mae_manwon: 180 },
    ],
    absolute_error_histogram: [{ label: '50만원 미만', count: 10 }],
  },
};
const auction = {
  ok: true,
  evidence: {
    status: 'supported_exploratory',
    price_kind: 'auction_award',
    selected_model: 'random_forest_log',
    training_same_model_count: 50,
    test_mae_krw: 2400000,
    test_interval_coverage_pct: 75,
    defer_reasons: [],
    limitations: ['합성 UI 테스트 응답'],
    warnings: [],
    prediction_krw: 8000000,
    interval_low_krw: 6000000,
    interval_high_krw: 10000000,
    scenarios: [
      {
        months: 6,
        status: 'conditional_scenario',
        prediction_krw: 7500000,
        interval_low_krw: 5500000,
        interval_high_krw: 9500000,
        assumed_combined_cost_krw: 1400000,
      },
    ],
  },
  explanation: {
    mode: 'template',
    text: '합성 테스트 근거: 시장 조건을 고정한 비교예요.',
    price_generation_by_llm: false,
  },
};

async function login(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '예시 차량으로 둘러보기', exact: true }).click();
  await page.getByRole('tab', { name: '설정', exact: true }).click();
  await page.getByRole('textbox', { name: '백엔드 서버 주소', exact: true }).fill(backendUrl!);
  await page.getByRole('button', { name: '서버 연결 확인', exact: true }).click();
  await expect(page.getByText('서버 연결됨 · 외부 데이터는 예시', { exact: true })).toBeVisible();
  const email = `onbid-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  await page.getByRole('textbox', { name: '테스트 계정 이메일', exact: true }).fill(email);
  await page.getByLabel('테스트 계정 비밀번호', { exact: true }).fill('synthetic-ui-test-password');
  await page.getByRole('button', { name: '로컬 테스트 계정 만들기', exact: true }).click();
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '가치 분석', exact: true }).click();
}

test('analytics shows whole-test and supported-subset errors together and clears on logout', async ({
  page,
}) => {
  await page.route('**/api/v1/analytics/latest', async (route) => {
    expect(route.request().headers().authorization).toMatch(/^Bearer /);
    await route.fulfill({ json: analytics });
  });
  await login(page);
  await page.getByTestId('load-onbid-analytics').click();
  await expect(page.getByText('모델별 검증 오차', { exact: true })).toBeVisible();
  await expect(page.getByText('240만원', { exact: true })).toBeVisible();
  await expect(page.getByText('130만원', { exact: true })).toBeVisible();
  for (const width of [360, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(
        () =>
          Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
      ),
    ).toBeLessThanOrEqual(1);
    expect(
      (await page.getByTestId('load-onbid-analytics').boundingBox())!.height,
    ).toBeGreaterThanOrEqual(44);
  }
  // Native dimensions update after the browser resize; wait for the desktop navigation
  // before resolving a click so the disappearing mobile tab is not retained.
  await expect(page.getByRole('tab', { name: '설정', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '설정', exact: true }).click();
  await page.getByRole('button', { name: '로컬 서버 로그아웃', exact: true }).click();
  await page.getByRole('tab', { name: '가치 분석', exact: true }).click();
  await expect(page.getByText('모델별 검증 오차', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('load-onbid-analytics')).toBeDisabled();
});

test('imported analytics distinguishes zero local calls from unknown upstream collection', async ({
  page,
}) => {
  await page.route('**/api/v1/analytics/latest', (route) =>
    route.fulfill({
      json: {
        ...analytics,
        source: {
          ...analytics.source,
          original_collection_calls: null,
          source_format: 'onbid-export-v1',
          complete_scope: 'local_import',
          upstream_collection_verified: false,
        },
      },
    }),
  );
  await login(page);
  await page.getByTestId('load-onbid-analytics').click();
  await expect(page.getByText('모델별 검증 오차', { exact: true })).toBeVisible();
  await expect(
    page.getByText('이번 실행 API 호출 0회 · 원수집 API 호출 미확인', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('최초 API 수집 내역은 검증하지 않았어요', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('후보 평가 · 서비스 모델 자동 교체 없음', { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('onbid-analytics')).toContainText(
    '현재 차량 분석에 적용된 모델의 성능과 다를 수 있어요.',
  );
});

test('auction analysis preserves won units and explicitly avoids paid LLM calls', async ({
  page,
}) => {
  await page.route('**/api/v1/valuation/simulations', async (route) => {
    const input = route.request().postDataJSON();
    expect(input.use_llm).toBe(false);
    expect(input.monthly_upkeep_krw).toBe(150000);
    await route.fulfill({ json: auction });
  });
  await login(page);
  await page.getByRole('button', { name: '공매 차량 분석 열기', exact: true }).click();
  await page.getByRole('textbox', { name: '공매 분석 차종', exact: true }).fill('쏘나타');
  await page.getByRole('textbox', { name: '공매 분석 연식', exact: true }).fill('2018');
  await page.getByRole('button', { name: '학습 모델로 비교', exact: true }).click();
  await expect(page.getByTestId('onbid-result')).toContainText('예상 공매 낙찰가 800만원');
  await expect(page.getByTestId('onbid-result')).toContainText('합성 테스트 근거');
  await page.setViewportSize({ width: 360, height: 1000 });
  expect(
    await page.evaluate(
      () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
});

test('malformed analytics never becomes a success dashboard', async ({ page }) => {
  await page.route('**/api/v1/analytics/latest', (route) =>
    route.fulfill({ json: { ...analytics, quality: { ...analytics.quality, clean_rows: 9999 } } }),
  );
  await login(page);
  await page.getByTestId('load-onbid-analytics').click();
  await expect(
    page.getByText('완료된 분석 결과의 형식을 확인할 수 없어요.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('모델별 검증 오차', { exact: true })).toHaveCount(0);
});

test('document excerpts distinguish plans from verified implementation without exposing source paths', async ({
  page,
}) => {
  await page.route('**/api/v1/knowledge/query', async (route) => {
    expect(route.request().headers().authorization).toMatch(/^Bearer /);
    expect(route.request().postDataJSON().use_llm).toBe(false);
    await route.fulfill({
      json: {
        ok: true,
        api_version: 'document-rag-v1',
        result: {
          question: 'PoC 계획과 현재 구현은 어떤 부분이 다른가요?',
          status: 'retrieval_only',
          answer_mode: 'verified_excerpts',
          sources: [
            {
              source_id: 'plan-1',
              document_title: '합성 계획서',
              source_uri: '/private/not-public.docx',
              location: '설계 방향 · 문단 3',
              status: 'plan',
              quote: '차량 상태 정보를 추가할 계획이다.',
              parent_text: '합성 원문',
            },
            {
              source_id: 'code-1',
              document_title: '합성 현재 구현',
              source_uri: '/private/internal-code',
              location: '전처리 · 함수 설명',
              status: 'code_verified',
              quote: '미확정 값은 누락 상태로 보존한다.',
              parent_text: '합성 원문',
            },
          ],
          answer_source_ids: ['plan-1', 'code-1'],
          limitations: ['계획을 구현 완료로 해석하지 마세요.'],
          retrieval: {
            method: 'bm25+pgvector-cosine-rrf',
            collection_id: 'synthetic-only',
            candidate_count: 2,
          },
        },
      },
    });
  });
  await login(page);
  await page
    .getByRole('button', { name: 'PoC 계획과 현재 구현은 어떤 부분이 다른가요?', exact: true })
    .click();
  await page.getByTestId('search-document-knowledge').click();
  const result = page.getByTestId('document-knowledge-result');
  await expect(result).toContainText('검색된 문서 원문');
  await expect(result).toContainText('계획 문서 · 구현 확인 전');
  await expect(result).toContainText('현재 코드에서 확인');
  await expect(result).not.toContainText('/private/');
  await page.setViewportSize({ width: 360, height: 1000 });
  expect(
    await page.evaluate(
      () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
});

test('restricted document access explains the required account without displaying excerpts', async ({
  page,
}) => {
  await page.route('**/api/v1/knowledge/query', (route) =>
    route.fulfill({
      status: 403,
      json: {
        error: { code: 'knowledge_forbidden', message: 'restricted' },
      },
    }),
  );
  await login(page);
  await page
    .getByRole('textbox', { name: '프로젝트 문서 질문', exact: true })
    .fill('현재 데이터 수집 과정은?');
  await page.getByTestId('search-document-knowledge').click();
  await expect(
    page.getByText('문서 검색 권한이 있는 계정으로 로그인해 주세요.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('document-knowledge-result')).toHaveCount(0);
});
