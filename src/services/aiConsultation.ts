import { BackendClient, BackendError } from './backend';
import { isAuctionResult, type AuctionResult } from './onbidValuation';
import type { AuctionAnalysisInput } from './auctionCache';
import type { ConsultationContext, ConsultationVehicleIdentity } from '../domain/aiConsultation';

export interface VehicleDocumentSource {
  source_id: string;
  source_kind: 'official_manual_summary';
  document_title: string;
  source_uri: string;
  section: string;
  page: number | null;
  excerpt: string;
  applicability: {
    scope: 'general' | 'model_specific';
    make: string | null;
    model: string | null;
    year_from: number | null;
    year_to: number | null;
    fuel_types: string[];
  };
}
export interface VehicleRagResult {
  scope: 'public_vehicle';
  status:
    'disabled' | 'unavailable' | 'needs_vehicle_details' | 'no_match' | 'not_used' | 'matched';
  sources: VehicleDocumentSource[];
  answer_source_ids: string[];
  method: 'bm25+pgvector-cosine-rrf' | 'bm25+local-cosine-rrf' | null;
}

export interface AssistantResult {
  ok: true;
  api_version: 'assistant-v1';
  status: 'answered' | 'abstained';
  answer: string;
  facts: { id: string; kind: 'evidence' | 'caution'; statement: string }[];
  valuation: AuctionResult | null;
  provider: { returned_model?: string; status?: string };
  price_generation_by_llm: false;
  vehicle_rag?: VehicleRagResult;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const boundedText = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= maximum &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const documentYear = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= 1970 && Number(value) <= 2100;
// Kept in sync with the server's public-vehicle corpus policy, never a wildcard suffix match.
const officialVehicleHosts = new Set(['ownersmanual.hyundai.com', 'ownersmanual.kia.com']);
export function isOfficialVehicleSourceUrl(value: unknown): value is string {
  if (!boundedText(value, 2000) || /[\s\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      officialVehicleHosts.has(url.hostname) &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === '443')
    );
  } catch {
    return false;
  }
}
function isVehicleDocumentSource(value: unknown): value is VehicleDocumentSource {
  if (
    !object(value) ||
    typeof value.source_id !== 'string' ||
    !/^[A-Za-z0-9_.:-]{1,100}$/.test(value.source_id) ||
    value.source_kind !== 'official_manual_summary' ||
    !boundedText(value.document_title, 200) ||
    !isOfficialVehicleSourceUrl(value.source_uri) ||
    !boundedText(value.section, 200) ||
    (value.page !== null &&
      (!Number.isInteger(value.page) || Number(value.page) < 1 || Number(value.page) > 10000)) ||
    !boundedText(value.excerpt, 1600) ||
    !object(value.applicability)
  )
    return false;
  const scope = value.applicability;
  if (!Array.isArray(scope.fuel_types) || scope.fuel_types.length > 20) return false;
  if (scope.scope === 'general')
    return (
      scope.make === null &&
      scope.model === null &&
      scope.year_from === null &&
      scope.year_to === null &&
      scope.fuel_types.length === 0
    );
  return (
    scope.scope === 'model_specific' &&
    boundedText(scope.make, 100) &&
    boundedText(scope.model, 100) &&
    documentYear(scope.year_from) &&
    (scope.year_to === null || (documentYear(scope.year_to) && scope.year_to >= scope.year_from)) &&
    scope.fuel_types.every((fuel) => boundedText(fuel, 100))
  );
}
export function isVehicleRagResult(value: unknown): value is VehicleRagResult {
  if (
    !object(value) ||
    value.scope !== 'public_vehicle' ||
    ![
      'disabled',
      'unavailable',
      'needs_vehicle_details',
      'no_match',
      'not_used',
      'matched',
    ].includes(String(value.status)) ||
    ![null, 'bm25+pgvector-cosine-rrf', 'bm25+local-cosine-rrf'].includes(
      value.method as string | null,
    ) ||
    !Array.isArray(value.sources) ||
    value.sources.length > 3 ||
    !value.sources.every(isVehicleDocumentSource) ||
    !Array.isArray(value.answer_source_ids) ||
    value.answer_source_ids.length !== value.sources.length ||
    (value.status === 'matched') !== value.sources.length > 0
  )
    return false;
  const ids = value.sources.map((source) => source.source_id);
  return (
    new Set(ids).size === ids.length &&
    value.answer_source_ids.every((id, index) => id === ids[index])
  );
}
const koreanQuantity =
  /(?:^|[^가-힣])(?:(?:[영공일이삼사오육칠팔구십백천만억조]+|한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|스무|서른|마흔|쉰)\s+|(?:[영공일이삼사오육칠팔구][십백천만억][영공일이삼사오육칠팔구십백천만억조]*|[십백천만억][영공일이삼사오육칠팔구십백천만억조]+|[영공일이삼사오육칠팔구]+조[영공일이삼사오육칠팔구십백천만억조]*)\s*)(?:개월|년|달|일|시간|분|초|대|건|개|원|만원|억원|퍼센트|프로|킬로미터|미터|리터)/;
export function isAssistantResult(value: unknown): value is AssistantResult {
  if (
    !object(value) ||
    value.ok !== true ||
    value.api_version !== 'assistant-v1' ||
    !['answered', 'abstained'].includes(String(value.status)) ||
    value.price_generation_by_llm !== false ||
    typeof value.answer !== 'string' ||
    !value.answer ||
    value.answer.length > 700 ||
    /\d|[₩$€¥]|(?:만|억|천|백|십)\s*원|만원|억원|달러/.test(value.answer) ||
    koreanQuantity.test(value.answer) ||
    !object(value.provider) ||
    (value.valuation !== null && !isAuctionResult(value.valuation)) ||
    !Array.isArray(value.facts) ||
    value.facts.length > 100 ||
    (value.vehicle_rag !== undefined && !isVehicleRagResult(value.vehicle_rag))
  )
    return false;
  const ids = new Set<string>();
  return value.facts.every((fact) => {
    if (
      !object(fact) ||
      typeof fact.id !== 'string' ||
      ids.has(fact.id) ||
      !['evidence', 'caution'].includes(String(fact.kind)) ||
      typeof fact.statement !== 'string' ||
      fact.statement.length > 4000
    )
      return false;
    ids.add(fact.id);
    return true;
  });
}
export async function queryAssistant(
  client: BackendClient,
  body: {
    question: string;
    context: ConsultationContext;
    previous_question?: string;
    analysis?: AuctionAnalysisInput;
    vehicle_identity?: ConsultationVehicleIdentity;
  },
): Promise<AssistantResult> {
  const result = await client.request<unknown>('/assistant/query', {
    method: 'POST',
    body,
    timeoutMs: 130_000,
  });
  if (!isAssistantResult(result))
    throw new BackendError('AI 답변을 근거와 대조하지 못했어요.', 502, 'invalid_response');
  return result;
}
