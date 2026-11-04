import { BackendClient, BackendError } from './backend';

export interface AuctionScenario {
  months: number;
  status: string;
  prediction_krw?: number;
  interval_low_krw?: number;
  interval_high_krw?: number;
  assumed_combined_cost_krw?: number;
}
export interface AuctionComparable {
  evidence_id: string;
  event_date: string;
  model: string;
  age_years: number;
  odometer_km: number;
  auction_award_krw: number;
  selection: 'same_model_nearest_age_and_mileage_training_only';
}
export interface AuctionResult {
  ok: true;
  evidence: {
    status: 'deferred' | 'supported_exploratory';
    price_kind: 'auction_award';
    selected_model: string;
    training_same_model_count: number;
    test_mae_krw: number;
    test_interval_coverage_pct: number;
    defer_reasons: string[];
    limitations: string[];
    warnings: string[];
    scenarios: AuctionScenario[];
    comparable_cases?: AuctionComparable[];
    prediction_krw?: number;
    interval_low_krw?: number;
    interval_high_krw?: number;
  };
  explanation: { mode: string; text: string; price_generation_by_llm: false };
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
export function isAuctionResult(value: unknown): value is AuctionResult {
  if (!object(value) || value.ok !== true || !object(value.evidence) || !object(value.explanation))
    return false;
  const evidence = value.evidence;
  return (
    ['deferred', 'supported_exploratory'].includes(String(evidence.status)) &&
    evidence.price_kind === 'auction_award' &&
    typeof evidence.selected_model === 'string' &&
    finite(evidence.training_same_model_count) &&
    finite(evidence.test_mae_krw) &&
    finite(evidence.test_interval_coverage_pct) &&
    strings(evidence.defer_reasons) &&
    strings(evidence.limitations) &&
    strings(evidence.warnings) &&
    (evidence.comparable_cases === undefined ||
      (Array.isArray(evidence.comparable_cases) &&
        evidence.comparable_cases.length <= 3 &&
        evidence.comparable_cases.every(
          (item) =>
            object(item) &&
            Object.keys(item).every((key) =>
              [
                'evidence_id',
                'event_date',
                'model',
                'age_years',
                'odometer_km',
                'auction_award_krw',
                'selection',
              ].includes(key),
            ) &&
            typeof item.evidence_id === 'string' &&
            typeof item.event_date === 'string' &&
            /^\d{4}-\d{2}-\d{2}$/.test(item.event_date) &&
            typeof item.model === 'string' &&
            item.model.length <= 100 &&
            ['age_years', 'odometer_km', 'auction_award_krw'].every(
              (key) => finite(item[key]) && item[key] >= 0,
            ) &&
            item.selection === 'same_model_nearest_age_and_mileage_training_only',
        ))) &&
    ['prediction_krw', 'interval_low_krw', 'interval_high_krw'].every((key) =>
      evidence.status === 'deferred' ? evidence[key] === undefined : finite(evidence[key]),
    ) &&
    Array.isArray(evidence.scenarios) &&
    evidence.scenarios.length <= 25 &&
    evidence.scenarios.every(
      (scenario) =>
        object(scenario) &&
        finite(scenario.months) &&
        typeof scenario.status === 'string' &&
        [
          'prediction_krw',
          'interval_low_krw',
          'interval_high_krw',
          'assumed_combined_cost_krw',
        ].every((key) =>
          scenario.status === 'deferred' ? scenario[key] === undefined : finite(scenario[key]),
        ),
    ) &&
    typeof value.explanation.mode === 'string' &&
    typeof value.explanation.text === 'string' &&
    value.explanation.text.length <= 40_000 &&
    value.explanation.price_generation_by_llm === false
  );
}
export async function requestAuction(client: BackendClient, body: unknown): Promise<AuctionResult> {
  const value = await client.request<unknown>('/valuation/simulations', {
    method: 'POST',
    body,
    timeoutMs: 130_000,
  });
  if (!isAuctionResult(value))
    throw new BackendError('공매 분석 응답 형식을 확인할 수 없어요.', 502, 'invalid_response');
  return value;
}
