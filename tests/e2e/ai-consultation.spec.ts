import { expect, test, type Page } from '@playwright/test';
import { createInitialState } from '../../src/domain/state';

// Entire provider boundary is synthetic. No real login, price inference or GPT call.
const api = 'https://assistant-fixture.example.test';
const vehicleRag = {
  scope: 'public_vehicle',
  status: 'matched',
  method: 'bm25+pgvector-cosine-rrf',
  sources: [
    {
      source_id: 'synthetic_manual_1',
      source_kind: 'official_manual_summary',
      document_title: '합성 K5 공식 자료 검증',
      source_uri: 'https://ownersmanual.kia.com/synthetic-manual.html',
      section: '합성 정비 조건',
      page: 12,
      excerpt: '합성 발췌입니다. 실제 정비 지침이나 권장 주기가 아닙니다.',
      applicability: {
        scope: 'model_specific',
        make: '기아',
        model: 'K5',
        year_from: 2023,
        year_to: 2026,
        fuel_types: ['휘발유'],
      },
    },
  ],
  answer_source_ids: ['synthetic_manual_1'],
};
const assistantResponse = {
  ok: true,
  api_version: 'assistant-v1',
  status: 'answered',
  answer: '공식 자료의 적용 조건을 확인하세요.',
  facts: [],
  valuation: null,
  provider: { returned_model: 'synthetic-provider', status: 'completed' },
  price_generation_by_llm: false,
  vehicle_rag: vehicleRag,
};
const auction = {
  ok: true,
  evidence: {
    status: 'supported_exploratory',
    price_kind: 'auction_award',
    selected_model: 'synthetic',
    training_same_model_count: 8,
    test_mae_krw: 2400000,
    test_interval_coverage_pct: 75,
    defer_reasons: [],
    limitations: ['합성 UI 검증 자료'],
    warnings: ['similar_model_training_rows_below_10'],
    prediction_krw: 8000000,
    interval_low_krw: 6000000,
    interval_high_krw: 10000000,
    scenarios: [6, 12].map((months) => ({
      months,
      status: 'conditional_scenario',
      prediction_krw: months === 6 ? 7500000 : 7000000,
      interval_low_krw: 5000000,
      interval_high_krw: 10000000,
      assumed_combined_cost_krw: 1000000,
    })),
    comparable_cases: [
      {
        evidence_id: 'comparison_1',
        event_date: '2026-01-10',
        model: 'K5',
        age_years: 6,
        odometer_km: 12000,
        auction_award_krw: 8200000,
        selection: 'same_model_nearest_age_and_mileage_training_only',
      },
    ],
  },
  explanation: { mode: 'template', text: '합성 근거', price_generation_by_llm: false },
};

async function setup(
  page: Page,
  onRequest: (path: string, body: Record<string, unknown>) => unknown,
) {
  const state = createInitialState();
  state.onboarded = true;
  state.vehicles = [
    {
      id: 'synthetic-car',
      name: 'private-nickname',
      model: 'K5 2024',
      catalogId: 'k5-dl3-pe',
      powertrain: 'HYB',
      odometerKm: 12000,
      createdAt: '2026-01-01T00:00:00Z',
    },
  ];
  state.vehicles.push({
    id: 'synthetic-other',
    name: '다른 합성 차량',
    model: '쏘나타 2021',
    powertrain: 'HYB',
    odometerKm: 5000,
    createdAt: '2026-01-01T00:00:00Z',
  });
  state.selectedVehicleId = 'synthetic-car';
  state.maintenance = [
    {
      id: 'synthetic-record',
      vehicleId: 'synthetic-car',
      itemId: 'engine-oil',
      odometerKm: 11000,
      performedAt: '2026-10-01T00:00:00Z',
      note: 'private-note',
    },
  ];
  await page.addInitScript(
    ({ saved, server }) => {
      localStorage.setItem('@drivemate/state:v1', JSON.stringify(saved));
      localStorage.setItem('@drivemate/backend-url:v1', server);
    },
    { saved: state, server: api },
  );
  await page.route(`${api}/api/v1/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON() ?? {};
    let json: unknown;
    if (path.endsWith('/auth/login'))
      json = {
        access_token: 'synthetic-session',
        token_type: 'bearer',
        user: { id: 'synthetic-user', email: 'synthetic@example.test' },
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      };
    else if (path.endsWith('/auth/logout')) json = { ok: true };
    else if (path.endsWith('/health')) json = { status: 'ok', provider_mode: 'mock' };
    else json = onRequest(path, body);
    await route.fulfill({
      status: json ? 200 : 404,
      json: json ?? { error: { code: 'test_unavailable', message: '합성 미제공' } },
    });
  });
  await page.goto('/settings');
  await page.getByLabel('DriveMate 계정 이메일', { exact: true }).fill('synthetic@example.test');
  await page.getByLabel('DriveMate 계정 비밀번호', { exact: true }).fill('synthetic-password');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page.getByText('synthetic@example.test', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'AI 상담', exact: true }).click();
}

test('freeform consultation transmits allowlisted records, renders a real answer contract, and clears on logout', async ({
  page,
}, testInfo) => {
  const calls: Record<string, unknown>[] = [];
  await setup(page, (path, body) => {
    if (!path.endsWith('/assistant/query')) return null;
    calls.push(body);
    return {
      ok: true,
      api_version: 'assistant-v1',
      status: 'answered',
      answer: '기록과 제조사 매뉴얼을 함께 확인해 보세요.',
      facts: [
        {
          id: 'maintenance_engine-oil',
          kind: 'evidence',
          statement: '사용자 기록 기준 엔진오일 교체 기록이 있어요.',
        },
      ],
      valuation: null,
      provider: { returned_model: 'synthetic-provider', status: 'completed' },
      price_generation_by_llm: false,
      vehicle_rag: vehicleRag,
    };
  });
  expect(calls).toHaveLength(0);
  const composer = await page.getByLabel('AI 상담 질문', { exact: true }).boundingBox();
  expect(composer).not.toBeNull();
  expect(composer!.y + composer!.height).toBeLessThan(page.viewportSize()!.height);
  await page.screenshot({ path: testInfo.outputPath('assistant-initial.png'), fullPage: true });
  await page
    .getByLabel('AI 상담 질문', { exact: true })
    .fill('엔진오일 기록을 어떻게 참고하면 좋을까요?');
  await page.getByRole('button', { name: 'AI에게 보내기', exact: true }).click();
  await expect(
    page.getByText('기록과 제조사 매뉴얼을 함께 확인해 보세요.', { exact: true }),
  ).toBeVisible();
  expect(calls).toHaveLength(1);
  expect(JSON.stringify(calls[0])).not.toContain('private-');
  expect(calls[0]).not.toHaveProperty('analysis');
  expect(calls[0].vehicle_identity).toEqual({
    make: '기아',
    model: 'K5',
    model_year: 2024,
    fuel: null,
  });
  await expect(page.getByText(vehicleRag.sources[0].excerpt, { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '차량 자료 근거 보기', exact: true }).click();
  await expect(page.getByText(vehicleRag.sources[0].document_title, { exact: true })).toBeVisible();
  await expect(page.getByText('합성 정비 조건 · PDF 12쪽', { exact: true })).toBeVisible();
  await expect(page.getByText(vehicleRag.sources[0].excerpt, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '공식 원문 열기', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: /전송 정보·이용 안내 보기/ }).click();
  await expect(page.getByText(/주소·좌표·메모·일정 제목은 자동 전송하지/)).toBeVisible();
  await expect(page.getByText(/질문 임베딩 비용도 발생할 수 있어요/)).toBeVisible();
  for (const width of [360, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - innerWidth,
        ),
      )
      .toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath(`assistant-${width}.png`), fullPage: true });
  }
  await page.getByLabel('AI 상담 질문', { exact: true }).fill('로그아웃 전에 입력 중인 합성 질문');
  await page.getByRole('button', { name: '계정 및 설정', exact: true }).click();
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await page.getByRole('tab', { name: 'AI 상담', exact: true }).click();
  await expect(
    page.getByText('기록과 제조사 매뉴얼을 함께 확인해 보세요.', { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'AI에게 보내기', exact: true })).toBeDisabled();
  await expect(page.getByLabel('AI 상담 질문', { exact: true })).toHaveValue('');
  await expect(page.getByText(vehicleRag.sources[0].document_title, { exact: true })).toHaveCount(
    0,
  );
});

test('URL question initially fills the composer without sending or logging in', async ({
  page,
}) => {
  const state = createInitialState();
  state.onboarded = true;
  await page.addInitScript((saved) => {
    localStorage.setItem('@drivemate/state:v1', JSON.stringify(saved));
  }, state);
  let calls = 0;
  await page.route('**/api/v1/assistant/query', async (route) => {
    calls += 1;
    await route.abort();
  });
  const question = '제조사 매뉴얼은 어떻게 참고하나요?';
  await page.goto('/ai?question=' + encodeURIComponent(question));
  await expect(page.getByLabel('AI 상담 질문', { exact: true })).toHaveValue(question);
  await expect(page.getByRole('button', { name: 'AI에게 보내기', exact: true })).toBeDisabled();
  expect(calls).toBe(0);
});

test('confirmed inputs produce numeric model cards and actual comparable counts; deferred inputs never display a price', async ({
  page,
}) => {
  let analysisCount = 0;
  await setup(page, (path, body) => {
    if (path.endsWith('/valuation/simulations')) {
      analysisCount += 1;
      expect(body.use_llm).toBe(false);
      expect(body.monthly_upkeep_krw).toBe(150000);
      if (analysisCount === 1) return auction;
      return {
        ...auction,
        evidence: {
          ...auction.evidence,
          status: 'deferred',
          prediction_krw: undefined,
          interval_low_krw: undefined,
          interval_high_krw: undefined,
          training_same_model_count: 0,
          scenarios: [],
          comparable_cases: [],
          defer_reasons: ['unseen_model_or_make_model_combination'],
        },
      };
    }
    return null;
  });
  await page.getByRole('button', { name: '차량 조건·유지비 확인', exact: true }).click();
  await page.getByLabel('실제 모델명', { exact: true }).fill('K5');
  await page.getByLabel('월 유지비 (만원)', { exact: true }).fill('15');
  await page.getByRole('button', { name: '입력 확인하고 공매 가격 분석', exact: true }).click();
  await expect(page.getByText('800만원', { exact: true })).toBeVisible();
  await expect(page.getByText('700만원', { exact: true })).toBeVisible();
  await expect(
    page.getByText(/같은 모델 학습 자료 8건 · 표시 가능한 실제 비교 사례 1건/),
  ).toBeVisible();
  await expect(page.getByText('같은 모델 표본이 적어요', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '가격 근거와 출처 보기', exact: true }).click();
  await expect(page.getByText('K5 · 820만원', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '홈', exact: true }).click();
  await expect(page.getByTestId('home-auction-summary')).toContainText('800');
  await expect(page.getByTestId('home-auction-summary')).toContainText('같은 모델 학습 자료 8건');
  await page.getByRole('button', { name: '차량 선택', exact: true }).click();
  await page.getByRole('button', { name: '다른 합성 차량', exact: true }).click();
  await expect(page.getByTestId('home-auction-summary')).toContainText('아직 분석한 가격이 없어요');
  await expect(page.getByTestId('home-auction-summary')).not.toContainText('800');
  await page.getByRole('tab', { name: 'AI 상담', exact: true }).click();
  await expect(page.getByText('800만원', { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: '홈', exact: true }).click();
  await page.getByRole('button', { name: '차량 선택', exact: true }).click();
  await page.getByRole('button', { name: 'private-nickname', exact: true }).click();
  await expect(page.getByTestId('home-auction-summary')).toContainText('800');
  await page.getByRole('tab', { name: 'AI 상담', exact: true }).click();
  await page.getByRole('button', { name: '차량 조건·유지비 확인', exact: true }).click();
  await page.getByLabel('실제 모델명', { exact: true }).fill('지원하지 않는 합성 모델');
  await page.getByLabel('월 유지비 (만원)', { exact: true }).fill('15');
  await page.getByRole('button', { name: '입력 확인하고 공매 가격 분석', exact: true }).click();
  await expect(
    page.getByText('표본 또는 지원 범위가 부족해 가격을 보류했어요', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('800만원', { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: '홈', exact: true }).click();
  await expect(page.getByTestId('home-auction-summary')).toContainText(
    '가격을 제시할 근거가 부족해요',
  );
  await page.getByRole('button', { name: '계정 및 설정', exact: true }).click();
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await page.getByRole('tab', { name: '홈', exact: true }).click();
  await expect(page.getByTestId('home-auction-summary')).toContainText('아직 분석한 가격이 없어요');
});

test('missing, unsupported and unused vehicle material never claims a cited manual', async ({
  page,
}) => {
  const statuses = ['no_match', 'needs_vehicle_details', 'unavailable', 'disabled', 'not_used'];
  const notices = [
    '선택한 차량에 맞는 자료가 없어요. 공식 설명서를 직접 확인해 주세요.',
    '차종·연식을 확인해야 차량 자료를 찾을 수 있어요.',
    '차량 자료 검색을 지금 확인할 수 없어요.',
    '차량 자료 검색이 아직 연결되지 않았어요.',
    '이번 답변에 인용한 제조사 문서는 없어요.',
  ];
  let index = 0;
  await setup(page, (path) =>
    path.endsWith('/assistant/query')
      ? {
          ...assistantResponse,
          vehicle_rag: {
            ...vehicleRag,
            status: statuses[index++],
            sources: [],
            answer_source_ids: [],
            method: null,
          },
        }
      : null,
  );
  for (const notice of notices) {
    await page
      .getByLabel('AI 상담 질문', { exact: true })
      .fill('차량 자료의 적용 범위를 알려 주세요.');
    await page.getByRole('button', { name: 'AI에게 보내기', exact: true }).click();
    await expect(page.getByText(notice, { exact: true })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: '차량 자료 근거 보기', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('button', { name: '공식 원문 열기', exact: true })).toHaveCount(0);
});

test('vehicle source selection clears on vehicle change and rejects unofficial source URLs', async ({
  page,
}) => {
  let calls = 0;
  await setup(page, (path) => {
    if (!path.endsWith('/assistant/query')) return null;
    calls += 1;
    return calls === 1
      ? assistantResponse
      : {
          ...assistantResponse,
          vehicle_rag: {
            ...vehicleRag,
            sources: [
              {
                ...vehicleRag.sources[0],
                source_uri: 'https://private-project.example.test/manual.pdf',
              },
            ],
          },
        };
  });
  await page.getByLabel('AI 상담 질문', { exact: true }).fill('차량 자료를 확인해 주세요.');
  await page.getByRole('button', { name: 'AI에게 보내기', exact: true }).click();
  await page.getByRole('button', { name: '차량 자료 근거 보기', exact: true }).click();
  await expect(page.getByText(vehicleRag.sources[0].document_title, { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '홈', exact: true }).click();
  await page.getByRole('button', { name: '차량 선택', exact: true }).click();
  await page.getByRole('button', { name: '다른 합성 차량', exact: true }).click();
  await page.getByRole('tab', { name: 'AI 상담', exact: true }).click();
  await expect(page.getByText(vehicleRag.sources[0].document_title, { exact: true })).toHaveCount(
    0,
  );
  await page.getByLabel('AI 상담 질문', { exact: true }).fill('다른 차량 자료를 확인해 주세요.');
  await page.getByRole('button', { name: 'AI에게 보내기', exact: true }).click();
  await expect(
    page.getByText('AI 답변을 근거와 대조하지 못했어요.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '공식 원문 열기', exact: true })).toHaveCount(0);
  await expect(page.getByText(assistantResponse.answer, { exact: true })).toHaveCount(0);
});
