import type { Vehicle } from './types';

/** A reproducible classroom simulation, not a fitted model or a market quotation. */
export const VALUATION_AS_OF = '2026-11-02';
export const VALUATION_MODEL_VERSION = 'synthetic-rules-v1';
export const VALUATION_MONTHS = [0, 6, 12, 24] as const;
export type ValuationMonth = (typeof VALUATION_MONTHS)[number];

export interface ValuationInput {
  modelYear: number;
  odometerKm: number;
  originalPriceManwon: number;
  monthlyKm: number;
  monthlyUpkeepManwon: number;
  minimumHoldMonths: ValuationMonth;
  holdingBudgetManwon: number;
  targetSaleManwon: number;
  historyKnown: boolean;
  /** Optional user-entered quote; it is not fetched or independently verified. */
  recentQuoteManwon?: number;
  recentQuoteDate?: string;
}

export interface ValuationScenario {
  month: ValuationMonth;
  saleDate: string;
  odometerKm: number;
  valueManwon: number;
  lowManwon: number;
  highManwon: number;
  sensitivityPercent: number;
  depreciationManwon: number;
  upkeepManwon: number;
  totalCostManwon: number;
  eligible: boolean;
  reasons: string[];
}

export interface ValuationResult {
  asOf: typeof VALUATION_AS_OF;
  modelVersion: typeof VALUATION_MODEL_VERSION;
  source: 'synthetic' | 'input-quote';
  currentValueManwon: number;
  scenarios: ValuationScenario[];
  recommendation: {
    status: 'candidate' | 'conditional' | 'deferred';
    month: ValuationMonth | null;
    title: string;
    reasons: string[];
  };
}

export type ValuationErrors = Partial<Record<keyof ValuationInput, string>>;

export function validateValuationInput(input: ValuationInput): ValuationErrors {
  const errors: ValuationErrors = {};
  const range = (key: keyof ValuationInput, min: number, max: number, label: string) => {
    const value = input[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      errors[key] =
        `${label}: ${min.toLocaleString('ko-KR')}~${max.toLocaleString('ko-KR')} 범위로 입력해 주세요.`;
    }
  };
  range('modelYear', 2006, 2026, '연식');
  if (!errors.modelYear && !Number.isInteger(input.modelYear))
    errors.modelYear = '연식은 네 자리 정수로 입력해 주세요.';
  range('odometerKm', 0, 300_000, '누적 주행거리(km)');
  range('originalPriceManwon', 100, 30_000, '가상 기준가(만원)');
  range('monthlyKm', 0, 10_000, '월 주행거리(km)');
  range('monthlyUpkeepManwon', 0, 500, '월 유지비(만원)');
  range('holdingBudgetManwon', 0, 10_000, '누적 비용 한도(만원)');
  range('targetSaleManwon', 0, 30_000, '목표 매도가(만원)');
  if (!VALUATION_MONTHS.includes(input.minimumHoldMonths))
    errors.minimumHoldMonths = '최소 보유 기간은 0·6·12·24개월 중 선택해 주세요.';
  if (typeof input.historyKnown !== 'boolean')
    errors.historyKnown = '사고·침수 이력 확인 여부를 선택해 주세요.';
  if (input.recentQuoteManwon !== undefined) {
    range('recentQuoteManwon', 100, 30_000, '입력 매입견적(만원)');
    const date = input.recentQuoteDate;
    const time =
      typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? Date.parse(`${date}T00:00:00Z`)
        : Number.NaN;
    const asOfTime = Date.parse(`${VALUATION_AS_OF}T00:00:00Z`);
    if (
      !Number.isFinite(time) ||
      new Date(time).toISOString().slice(0, 10) !== date ||
      time > asOfTime ||
      asOfTime - time > 30 * 86400000
    )
      errors.recentQuoteDate =
        '견적일은 기준일 2026-11-02까지 최근 30일 이내의 실제 날짜로 입력해 주세요.';
  } else if (input.recentQuoteDate !== undefined) {
    errors.recentQuoteManwon = '견적 날짜와 매입견적 금액을 함께 입력해 주세요.';
  }
  return errors;
}

export function createValuationInput(vehicle: Vehicle): ValuationInput {
  // Legacy vehicle model is free text: "푸조 2008 2021" should use its last year.
  // Missing or unsupported years must be corrected instead of silently replaced.
  const parsedYear = Number(vehicle.model.match(/\b(?:19|20)\d{2}\b/g)?.at(-1));
  return {
    modelYear: parsedYear,
    // Do not alter registered vehicle data. Unsupported inputs are flagged by validation.
    odometerKm: vehicle.odometerKm,
    originalPriceManwon: 3000,
    monthlyKm: 1000,
    monthlyUpkeepManwon: 15,
    minimumHoldMonths: 6,
    holdingBudgetManwon: 700,
    targetSaleManwon: 1400,
    historyKnown: true,
  };
}

const money = (value: number) => Math.round(value * 10) / 10;

function syntheticValue(input: ValuationInput, month: ValuationMonth): number {
  const age = 2026 - input.modelYear + month / 12;
  const km = input.odometerKm + input.monthlyKm * month;
  return (
    input.originalPriceManwon *
    0.84 ** Math.min(age, 1) *
    0.9 ** Math.max(age - 1, 0) *
    Math.exp(-km / 400_000)
  );
}

export function simulateValuation(input: ValuationInput): ValuationResult {
  const errors = validateValuationInput(input);
  if (Object.keys(errors).length) throw new Error(Object.values(errors).join(' '));
  const syntheticCurrent = syntheticValue(input, 0);
  const current = input.recentQuoteManwon ?? syntheticCurrent;
  const scenarios = VALUATION_MONTHS.map((month): ValuationScenario => {
    const value = current * (syntheticValue(input, month) / syntheticCurrent);
    const depreciation = current - value;
    const upkeep = input.monthlyUpkeepManwon * month;
    const totalCost = depreciation + upkeep;
    const sensitivity = 0.08 + (month / 12) * 0.02;
    const reasons: string[] = [];
    if (month < input.minimumHoldMonths) reasons.push('최소 보유 기간 미달');
    if (totalCost > input.holdingBudgetManwon) reasons.push('누적 비용 한도 초과');
    if (value < input.targetSaleManwon) reasons.push('목표 매도가 미달');
    const date = new Date(`${VALUATION_AS_OF}T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + month);
    return {
      month,
      saleDate: date.toISOString().slice(0, 10),
      odometerKm: input.odometerKm + input.monthlyKm * month,
      valueManwon: money(value),
      lowManwon: money(value * (1 - sensitivity)),
      highManwon: money(value * (1 + sensitivity)),
      sensitivityPercent: money(sensitivity * 100),
      depreciationManwon: money(depreciation),
      upkeepManwon: money(upkeep),
      totalCostManwon: money(totalCost),
      eligible: reasons.length === 0,
      reasons,
    };
  });
  const candidate = scenarios.filter((scenario) => scenario.eligible).at(-1);
  let recommendation: ValuationResult['recommendation'];
  if (!input.historyKnown) {
    recommendation = {
      status: 'deferred',
      month: null,
      title: '이력 확인 후 다시 비교해요',
      reasons: [
        '사고·침수 이력이 확인되지 않아 매도 검토 시점을 제안하지 않아요.',
        '표와 그래프는 무사고·비침수라는 가정의 계산 결과만 보여줘요.',
      ],
    };
  } else if (!candidate) {
    recommendation = {
      status: 'deferred',
      month: null,
      title: '현재 조건으로는 제안을 유보해요',
      reasons: [
        '0·6·12·24개월 중 보유 기간, 비용 한도, 목표 매도가를 모두 만족하는 시점이 없어요.',
        '각 시점의 미충족 조건을 확인한 뒤 목표를 조정해 비교해 보세요.',
      ],
    };
  } else {
    const priceAtRisk = candidate.lowManwon < input.targetSaleManwon;
    const costAtRisk =
      candidate.month > 0 &&
      current - candidate.lowManwon + candidate.upkeepManwon > input.holdingBudgetManwon;
    const conditional = priceAtRisk || costAtRisk;
    recommendation = {
      status: conditional ? 'conditional' : 'candidate',
      month: candidate.month,
      title:
        candidate.month === 0
          ? '지금 매도를 검토해요'
          : `${candidate.month}개월 후 매도를 검토해요`,
      reasons: [
        `0·6·12·24개월 중 입력한 세 조건을 만족하는 가장 늦은 비교 시점이에요.`,
        `추가 보유 비용 ${Math.round(candidate.totalCostManwon).toLocaleString('ko-KR')}만원이 누적 한도 ${input.holdingBudgetManwon.toLocaleString('ko-KR')}만원 이내예요.`,
        conditional
          ? `낮은 가격 가정에서는 ${[priceAtRisk && '목표 매도가 미달', costAtRisk && '누적 비용 한도 초과'].filter(Boolean).join('·')} 가능성이 있어요. 실제 견적 확인 전에는 시점을 확정하지 마세요.`
          : '더 오래 사용하는 선호를 반영한 조건부 제안이에요. 실제 견적과 지출에 따라 달라져요.',
      ],
    };
  }
  return {
    asOf: VALUATION_AS_OF,
    modelVersion: VALUATION_MODEL_VERSION,
    source: input.recentQuoteManwon === undefined ? 'synthetic' : 'input-quote',
    currentValueManwon: money(current),
    scenarios,
    recommendation,
  };
}
