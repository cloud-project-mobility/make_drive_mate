import { BackendClient, BackendError } from './backend';
import { isAuctionResult, type AuctionResult } from './onbidValuation';
import type { AuctionAnalysisInput } from './auctionCache';
import type { ConsultationContext } from '../domain/aiConsultation';

export interface AssistantResult {
  ok: true;
  api_version: 'assistant-v1';
  status: 'answered' | 'abstained';
  answer: string;
  facts: { id: string; kind: 'evidence' | 'caution'; statement: string }[];
  valuation: AuctionResult | null;
  provider: { returned_model?: string; status?: string };
  price_generation_by_llm: false;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
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
    value.facts.length > 100
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
