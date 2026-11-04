import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createValuationInput,
  simulateValuation,
  validateValuationInput,
  type ValuationInput,
} from './valuation';

const input: ValuationInput = {
  modelYear: 2023,
  odometerKm: 48250,
  originalPriceManwon: 3000,
  monthlyKm: 1000,
  monthlyUpkeepManwon: 15,
  minimumHoldMonths: 6,
  holdingBudgetManwon: 700,
  targetSaleManwon: 1400,
  historyKnown: true,
};

test('published demo has reproducible values, costs, date and a constrained 12-month candidate', () => {
  const result = simulateValuation(input);
  assert.equal(result.source, 'synthetic');
  assert.equal(result.asOf, '2026-11-02');
  assert.deepEqual(
    result.scenarios.map((s) => s.valueManwon),
    [1809.3, 1690.9, 1580.2, 1380.1],
  );
  assert.deepEqual(
    result.scenarios.map((s) => s.totalCostManwon),
    [0, 208.4, 409, 789.1],
  );
  assert.equal(result.scenarios[2].saleDate, '2027-11-02');
  assert.equal(result.scenarios[0].eligible, false);
  assert.equal(result.recommendation.month, 12);
});

test('older vehicles and more mileage lower modeled value without producing negative values', () => {
  const baseline = simulateValuation(input);
  assert.ok(
    simulateValuation({ ...input, modelYear: 2022 }).currentValueManwon <
      baseline.currentValueManwon,
  );
  assert.ok(
    simulateValuation({ ...input, odometerKm: 80000 }).currentValueManwon <
      baseline.currentValueManwon,
  );
  const highUsage = simulateValuation({ ...input, monthlyKm: 4000 });
  assert.equal(highUsage.currentValueManwon, baseline.currentValueManwon);
  assert.ok(highUsage.scenarios[3].valueManwon < baseline.scenarios[3].valueManwon);
  const extreme = simulateValuation({
    ...input,
    modelYear: 2006,
    odometerKm: 300000,
    monthlyKm: 10000,
  });
  assert.ok(extreme.scenarios.every((s) => s.valueManwon > 0 && s.totalCostManwon >= 0));
});

test('the total cost is cumulative depreciation plus user upkeep; zero months costs zero', () => {
  const withoutUpkeep = simulateValuation({ ...input, monthlyUpkeepManwon: 0 });
  const withUpkeep = simulateValuation(input);
  for (const [index, scenario] of withUpkeep.scenarios.entries()) {
    assert.ok(
      Math.abs(
        scenario.totalCostManwon -
          withoutUpkeep.scenarios[index].totalCostManwon -
          scenario.month * 15,
      ) < 0.11,
    );
    assert.equal(scenario.upkeepManwon, scenario.month * 15);
  }
  assert.equal(withUpkeep.scenarios[0].totalCostManwon, 0);
});

test('tightening or relaxing user constraints changes the candidate instead of always recommending now', () => {
  assert.equal(simulateValuation({ ...input, holdingBudgetManwon: 250 }).recommendation.month, 6);
  assert.equal(
    simulateValuation({ ...input, targetSaleManwon: 1000, holdingBudgetManwon: 1000 })
      .recommendation.month,
    24,
  );
  assert.equal(
    simulateValuation({ ...input, minimumHoldMonths: 0, holdingBudgetManwon: 0 }).recommendation
      .month,
    0,
  );
  const impossible = simulateValuation({ ...input, minimumHoldMonths: 24 });
  assert.equal(impossible.recommendation.status, 'deferred');
  assert.equal(impossible.recommendation.month, null);
});

test('unknown history suppresses advice and sensitivity crossing the target yields conditional advice', () => {
  const unknown = simulateValuation({ ...input, historyKnown: false });
  assert.equal(unknown.recommendation.status, 'deferred');
  assert.equal(unknown.recommendation.month, null);
  assert.equal(unknown.scenarios.length, 4);
  const conditional = simulateValuation({ ...input, targetSaleManwon: 1500 });
  assert.equal(conditional.recommendation.status, 'conditional');
  assert.equal(conditional.recommendation.month, 12);
  assert.ok(
    conditional.scenarios.every((s) => s.lowManwon < s.valueManwon && s.valueManwon < s.highManwon),
  );
  assert.deepEqual(
    conditional.scenarios.map((s) => s.sensitivityPercent),
    [8, 9, 10, 12],
  );
});

test('unsupported values fail closed instead of silently generating an estimate', () => {
  for (const changes of [
    { modelYear: 2027 },
    { modelYear: 2023.5 },
    { odometerKm: -1 },
    { odometerKm: 300001 },
    { monthlyKm: Number.NaN },
    { originalPriceManwon: Infinity },
    { minimumHoldMonths: 7 },
    { historyKnown: undefined },
    { holdingBudgetManwon: -1 },
  ]) {
    const invalid = { ...input, ...changes } as ValuationInput;
    assert.ok(Object.keys(validateValuationInput(invalid)).length > 0);
    assert.throws(() => simulateValuation(invalid));
  }
});

test('vehicle defaults read registered mileage without changing it and cannot hide invalid years', () => {
  const vehicle = {
    id: 'v',
    name: '내 차',
    model: '현대 아반떼 2024',
    odometerKm: 26340,
    powertrain: 'ICE' as const,
    createdAt: '2026-11-02',
  };
  const defaults = createValuationInput(vehicle);
  assert.equal(defaults.modelYear, 2024);
  assert.equal(defaults.odometerKm, 26340);
  defaults.odometerKm = 999;
  assert.equal(vehicle.odometerKm, 26340);
  assert.ok(Number.isNaN(createValuationInput({ ...vehicle, model: '미입력' }).modelYear));
  assert.equal(createValuationInput({ ...vehicle, model: '푸조 2008 2021' }).modelYear, 2021);
  for (const model of ['아반떼 1999', '아반떼 2027', '미입력']) {
    const unsupported = createValuationInput({ ...vehicle, model });
    assert.ok(validateValuationInput(unsupported).modelYear);
    assert.throws(() => simulateValuation(unsupported));
  }
});

test('a recent user quote anchors current value and only relative depreciation affects its future', () => {
  const quoted = simulateValuation({
    ...input,
    recentQuoteManwon: 1850,
    recentQuoteDate: '2026-11-02',
  });
  assert.equal(quoted.source, 'input-quote');
  assert.equal(quoted.currentValueManwon, 1850);
  assert.equal(quoted.scenarios[0].valueManwon, 1850);
  const otherReferencePrice = simulateValuation({
    ...input,
    originalPriceManwon: 5000,
    recentQuoteManwon: 1850,
    recentQuoteDate: '2026-10-20',
  });
  assert.deepEqual(quoted.scenarios, otherReferencePrice.scenarios);
  assert.ok(quoted.scenarios[3].valueManwon < 1850);
});

test('a quote must be paired with a valid recent date and cannot be from the future', () => {
  for (const changes of [
    { recentQuoteManwon: 1850 },
    { recentQuoteDate: '2026-11-02' },
    { recentQuoteManwon: 1850, recentQuoteDate: '2026-10-02' },
    { recentQuoteManwon: 1850, recentQuoteDate: '2026-11-03' },
    { recentQuoteManwon: 1850, recentQuoteDate: '2026-02-30' },
    { recentQuoteManwon: Number.NaN, recentQuoteDate: '2026-11-02' },
  ])
    assert.throws(() => simulateValuation({ ...input, ...changes }));
  assert.doesNotThrow(() =>
    simulateValuation({ ...input, recentQuoteManwon: 1850, recentQuoteDate: '2026-10-03' }),
  );
});

test('downside cost warns even if the sale target passes; immediate sale has no holding cost', () => {
  const tight = simulateValuation({ ...input, holdingBudgetManwon: 450, targetSaleManwon: 1000 });
  assert.equal(tight.recommendation.month, 12);
  assert.equal(tight.recommendation.status, 'conditional');
  assert.match(tight.recommendation.reasons.at(-1)!, /누적 비용 한도 초과/);
  const now = simulateValuation({ ...input, minimumHoldMonths: 0, holdingBudgetManwon: 0 });
  assert.equal(now.recommendation.status, 'candidate');
  assert.equal(now.recommendation.month, 0);
});
