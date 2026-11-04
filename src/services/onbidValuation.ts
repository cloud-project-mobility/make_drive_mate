import { BackendClient, BackendError } from './backend';

export interface AuctionScenario {
  months: number;
  status: string;
  prediction_krw?: number;
  interval_low_krw?: number;
  interval_high_krw?: number;
  assumed_combined_cost_krw?: number;
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
