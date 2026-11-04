import { BackendError, type BackendClient } from './backend';

export interface CountSeries {
  label: string;
  count: number;
}
export interface ModelScore {
  label: string;
  mae_manwon: number;
}
export interface OnbidAnalytics {
  schema_version: 'drivemate-cycle-v1';
  run_id: string;
  status: 'completed';
  generated_at: string;
  price_kind: 'auction_award';
  production_promoted: boolean;
  source: {
    mode: 'reuse' | 'collect';
    date_start: string;
    date_end: string;
    api_calls_this_run: number;
    original_collection_calls: number;
  };
  quality: {
    raw_rows: number;
    passenger_rows: number;
    clean_rows: number;
    excluded_rows: number;
    usable_percent_of_passenger: number;
    missing_rates: Record<string, number>;
    exclusion_reason_counts: Record<string, number>;
    exact_duplicate_rows: number;
    repeated_vehicle_groups: number;
  };
  model: {
    selected_model: string;
    test_metrics: { rows: number; mae_manwon: number; wape_pct: number };
    service_support_audit: {
      test_rows: number;
      supported_rows: number;
      deferred_rows: number;
      supported_percent: number;
      supported_test_metrics: { mae_manwon: number } | null;
    };
    split_counts: { train: number; validation: number; calibration: number; test: number };
  };
  charts: {
    price_histogram: CountSeries[];
    top_models: CountSeries[];
    monthly_counts: CountSeries[];
    category_counts: CountSeries[];
    model_comparison: ModelScore[];
    absolute_error_histogram: CountSeries[];
  };
}

type Data = Record<string, unknown>;
const object = (value: unknown): value is Data =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, maximum = 240): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
const number = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum;
const count = (value: unknown): value is number => number(value) && Number.isInteger(value);
const day = (value: unknown): value is string => {
  if (!text(value, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
};
const counts = (value: unknown): value is CountSeries[] =>
  Array.isArray(value) &&
  value.length <= 200 &&
  value.every((row) => object(row) && text(row.label) && count(row.count));
const record = (value: unknown, check: (item: unknown) => boolean): boolean =>
  object(value) && Object.keys(value).length <= 100 && Object.values(value).every(check);

export function isOnbidAnalytics(value: unknown): value is OnbidAnalytics {
  if (
    !object(value) ||
    value.schema_version !== 'drivemate-cycle-v1' ||
    value.status !== 'completed' ||
    value.price_kind !== 'auction_award' ||
    !text(value.run_id) ||
    !text(value.generated_at, 100) ||
    !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value.generated_at) ||
    !Number.isFinite(Date.parse(value.generated_at)) ||
    typeof value.production_promoted !== 'boolean' ||
    !object(value.source) ||
    !object(value.quality) ||
    !object(value.model) ||
    !object(value.charts)
  )
    return false;
  const { source, quality, model, charts } = value;
  if (
    !['reuse', 'collect'].includes(String(source.mode)) ||
    !day(source.date_start) ||
    !day(source.date_end) ||
    source.date_start > source.date_end ||
    !count(source.api_calls_this_run) ||
    !count(source.original_collection_calls) ||
    !count(quality.raw_rows) ||
    !count(quality.passenger_rows) ||
    !count(quality.clean_rows) ||
    !count(quality.excluded_rows) ||
    !count(quality.exact_duplicate_rows) ||
    !count(quality.repeated_vehicle_groups) ||
    quality.clean_rows > quality.passenger_rows ||
    quality.passenger_rows > quality.raw_rows ||
    quality.clean_rows + quality.excluded_rows !== quality.raw_rows ||
    !number(quality.usable_percent_of_passenger, 100) ||
    !record(quality.missing_rates, (item) => number(item, 100)) ||
    !record(quality.exclusion_reason_counts, count) ||
    !text(model.selected_model) ||
    !object(model.test_metrics) ||
    !count(model.test_metrics.rows) ||
    !number(model.test_metrics.mae_manwon) ||
    !number(model.test_metrics.wape_pct) ||
    !object(model.service_support_audit) ||
    !object(model.split_counts)
  )
    return false;
  const support = model.service_support_audit;
  if (
    !count(support.test_rows) ||
    !count(support.supported_rows) ||
    !count(support.deferred_rows) ||
    support.supported_rows + support.deferred_rows !== support.test_rows ||
    support.test_rows !== model.test_metrics.rows ||
    !number(support.supported_percent, 100) ||
    !(
      support.supported_test_metrics === null ||
      (object(support.supported_test_metrics) && number(support.supported_test_metrics.mae_manwon))
    ) ||
    !['train', 'validation', 'calibration', 'test'].every((key) =>
      count((model.split_counts as Data)[key]),
    )
  )
    return false;
  return (
    counts(charts.price_histogram) &&
    counts(charts.top_models) &&
    counts(charts.monthly_counts) &&
    counts(charts.category_counts) &&
    counts(charts.absolute_error_histogram) &&
    Array.isArray(charts.model_comparison) &&
    charts.model_comparison.length <= 20 &&
    charts.model_comparison.every((row) => object(row) && text(row.label) && number(row.mae_manwon))
  );
}

export async function loadOnbidAnalytics(client: BackendClient): Promise<OnbidAnalytics> {
  const value = await client.request<unknown>('/analytics/latest');
  if (!isOnbidAnalytics(value))
    throw new BackendError('완료된 분석 결과의 형식을 확인할 수 없어요.', 502, 'invalid_response');
  return value;
}
