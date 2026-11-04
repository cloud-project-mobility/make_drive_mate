import { BackendClient, BackendError } from './backend';

export interface KnowledgeSource {
  source_id: string;
  document_title: string;
  source_uri: string;
  location: string;
  status: 'plan' | 'reported' | 'official' | 'code_verified';
  quote: string;
  parent_text: string;
}
export interface KnowledgeResult {
  question: string;
  status: 'answered' | 'retrieval_only' | 'abstained';
  answer_mode: 'verified_excerpts';
  sources: KnowledgeSource[];
  answer_source_ids: string[];
  limitations: string[];
  retrieval: { method: string; collection_id: string; candidate_count: number };
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, maximum = 20_000): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;

export function isKnowledgeResponse(value: unknown): value is {
  ok: true;
  api_version: 'document-rag-v1';
  result: KnowledgeResult;
} {
  if (
    !record(value) ||
    value.ok !== true ||
    value.api_version !== 'document-rag-v1' ||
    !record(value.result)
  )
    return false;
  const result = value.result;
  if (
    !text(result.question, 1000) ||
    !['answered', 'retrieval_only', 'abstained'].includes(String(result.status)) ||
    result.answer_mode !== 'verified_excerpts'
  )
    return false;
  if (
    !Array.isArray(result.sources) ||
    result.sources.length > 30 ||
    !result.sources.every(
      (source) =>
        record(source) &&
        text(source.source_id, 256) &&
        text(source.document_title, 1000) &&
        typeof source.source_uri === 'string' &&
        source.source_uri.length <= 4000 &&
        text(source.location, 2000) &&
        ['plan', 'reported', 'official', 'code_verified'].includes(String(source.status)) &&
        text(source.quote) &&
        typeof source.parent_text === 'string' &&
        source.parent_text.length <= 100_000,
    )
  )
    return false;
  const ids = result.sources.map((source) => source.source_id);
  if (
    new Set(ids).size !== ids.length ||
    !Array.isArray(result.answer_source_ids) ||
    result.answer_source_ids.length > 30 ||
    !result.answer_source_ids.every((id) => typeof id === 'string' && ids.includes(id)) ||
    new Set(result.answer_source_ids).size !== result.answer_source_ids.length ||
    (result.status === 'answered' && result.answer_source_ids.length === 0)
  )
    return false;
  if (
    !Array.isArray(result.limitations) ||
    result.limitations.length > 30 ||
    !result.limitations.every((item) => text(item, 4000))
  )
    return false;
  return (
    record(result.retrieval) &&
    text(result.retrieval.method, 200) &&
    text(result.retrieval.collection_id, 500) &&
    Number.isSafeInteger(result.retrieval.candidate_count) &&
    Number(result.retrieval.candidate_count) >= 0
  );
}

export async function queryKnowledge(
  client: BackendClient,
  question: string,
  useLlm: boolean,
): Promise<KnowledgeResult> {
  const value = await client.request<unknown>('/knowledge/query', {
    method: 'POST',
    body: { question: question.trim(), use_llm: useLlm },
    timeoutMs: 130_000,
  });
  if (!isKnowledgeResponse(value))
    throw new BackendError('문서 근거 응답의 출처와 형식을 확인할 수 없어요.');
  return value.result;
}
