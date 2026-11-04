import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button, C, Card, Chip, Field, Notice, SectionTitle, shared } from '../components/ui';
import { BackendError, backendMessage } from '../services/backend';
import {
  queryKnowledge,
  type KnowledgeResult,
  type KnowledgeSource,
} from '../services/documentKnowledge';
import { useBackend } from '../state/BackendProvider';

const examples = [
  '공매 낙찰가와 소비자 시세는 어떻게 다른가요?',
  '현재 데이터 수집·전처리 과정은 어떻게 되나요?',
  'PoC 계획과 현재 구현은 어떤 부분이 다른가요?',
];
const statusNames: Record<KnowledgeSource['status'], string> = {
  plan: '계획 문서 · 구현 확인 전',
  reported: '보고서에 기재된 내용',
  official: '공식 출처',
  code_verified: '현재 코드에서 확인',
};

function KnowledgeContent() {
  const { client, session, isCurrentClient } = useBackend();
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<KnowledgeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function search(useLlm: boolean) {
    if (!session || busy) return;
    if (!question.trim() || question.trim().length > 1000) {
      setError('확인할 내용을 1~1,000자로 입력해 주세요.');
      return;
    }
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const next = await queryKnowledge(client, question, useLlm);
      if (isCurrentClient(client)) setResult(next);
    } catch (cause) {
      if (isCurrentClient(client))
        setError(
          cause instanceof BackendError && cause.status === 403
            ? '문서 검색 권한이 있는 계정으로 로그인해 주세요.'
            : backendMessage(cause),
        );
    } finally {
      setBusy(false);
    }
  }
  const selected =
    result?.sources.filter((source) => result.answer_source_ids.includes(source.source_id)) ?? [];
  const sources = result?.status === 'retrieval_only' ? result.sources : selected;
  return (
    <Card style={s.card}>
      <SectionTitle title="프로젝트 문서에서 근거 찾기" />
      <Text style={shared.muted}>
        계획서·보고서와 현재 구현 자료의 원문을 찾아 비교해요. 차량 가격 예측과 별개이며, 계획에
        적힌 기능을 구현 완료로 보지 않아요.
      </Text>
      <View style={shared.stack}>
        {examples.map((example) => (
          <Button
            key={example}
            title={example}
            variant="secondary"
            disabled={busy}
            onPress={() => setQuestion(example)}
          />
        ))}
      </View>
      <Field
        label="프로젝트 문서 질문"
        value={question}
        onChangeText={setQuestion}
        maxLength={1000}
        multiline
        style={s.question}
        editable={!busy}
        placeholder="문서에서 확인하고 싶은 내용을 입력해 주세요."
      />
      <Text style={s.detail}>
        두 버튼 모두 검색용 임베딩 API 비용이 발생해요. GPT 정리는 추가 API를 사용해요. 유료 기능은
        서버 전체에서 하루 20회 한도를 공유하며, 문서 검색 권한이 있는 계정만 이용할 수 있어요.
      </Text>
      <Button
        title="문서 근거 검색"
        loading={busy}
        disabled={!session}
        onPress={() => void search(false)}
        testID="search-document-knowledge"
      />
      <Button
        title="GPT로 문서 근거 정리"
        variant="secondary"
        disabled={!session || busy}
        onPress={() => void search(true)}
      />
      {!session && (
        <Text style={shared.muted}>설정에서 허용된 계정으로 서버에 로그인해 주세요.</Text>
      )}
      {error ? <Notice title="문서 검색을 완료하지 못했어요" body={error} tone="error" /> : null}
      {result && (
        <View style={shared.stack} testID="document-knowledge-result">
          <Text accessibilityRole="header" style={s.title}>
            {result.status === 'abstained'
              ? '답변할 문서 근거가 부족해요'
              : result.status === 'retrieval_only'
                ? '검색된 문서 원문'
                : 'GPT가 선택한 문서 근거'}
          </Text>
          <Text style={shared.muted}>질문: {result.question}</Text>
          {result.status !== 'abstained' &&
            sources.map((source) => (
              <View key={source.source_id} style={s.source}>
                <Chip
                  label={statusNames[source.status]}
                  selected={source.status === 'code_verified'}
                />
                <Text style={s.label}>{source.document_title}</Text>
                <Text style={s.detail}>{source.location}</Text>
                <Text selectable style={s.quote}>
                  {source.quote}
                </Text>
              </View>
            ))}
          {result.limitations.map((item, index) => (
            <Text key={index} style={shared.muted}>
              {item}
            </Text>
          ))}
          <Text style={s.detail}>
            표시된 내용은 문서 원문 인용이에요. 문서 작성 시점과 계획·구현 상태를 함께 확인해
            주세요.
          </Text>
        </View>
      )}
    </Card>
  );
}
export default function DocumentKnowledge() {
  const { url, session } = useBackend();
  return (
    <KnowledgeContent
      key={`${url}:${session?.user.id ?? 'anonymous'}:${session?.expires_at ?? ''}`}
    />
  );
}
const s = StyleSheet.create({
  card: { gap: 16 },
  question: { minHeight: 100, textAlignVertical: 'top' },
  title: { color: C.ink, fontSize: 18, fontWeight: '800' },
  label: { color: C.ink, fontSize: 15, fontWeight: '700' },
  detail: { color: C.muted, fontSize: 12, lineHeight: 20 },
  source: { borderWidth: 1, borderColor: C.line, borderRadius: 14, padding: 16, gap: 10 },
  quote: { color: C.ink, fontSize: 14, lineHeight: 23 },
});
