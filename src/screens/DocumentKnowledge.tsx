import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { C, Card, Icon, type IconName, Notice } from '../components/ui';
import { BackendError, backendMessage } from '../services/backend';
import {
  queryKnowledge,
  type KnowledgeResult,
  type KnowledgeSource,
} from '../services/documentKnowledge';
import { useBackend } from '../state/BackendProvider';

const examples = [
  { label: '공매가와 시세 차이', question: '공매 낙찰가와 소비자 시세는 어떻게 다른가요?' },
  { label: '데이터 처리 과정', question: '현재 데이터 수집·전처리 과정은 어떻게 되나요?' },
  { label: '계획과 구현 비교', question: 'PoC 계획과 현재 구현은 어떤 부분이 다른가요?' },
];
const statusNames: Record<KnowledgeSource['status'], string> = {
  plan: '계획 문서 · 구현 확인 전',
  reported: '보고서에 기재된 내용',
  official: '공식 출처',
  code_verified: '현재 코드에서 확인',
};

function SearchAction({
  title,
  icon,
  secondary = false,
  disabled,
  loading,
  onPress,
  testID,
}: {
  title: string;
  icon: IconName;
  secondary?: boolean;
  disabled: boolean;
  loading: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const color = disabled ? '#475569' : secondary ? '#174AA4' : '#FFFFFF';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      disabled={disabled || loading}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        s.action,
        secondary && s.secondaryAction,
        disabled && s.disabledAction,
        pressed && s.pressedAction,
      ]}
    >
      {loading ? <ActivityIndicator color={color} /> : <Icon name={icon} size={19} color={color} />}
      <Text style={[s.actionText, { color }]}>{title}</Text>
    </Pressable>
  );
}

function KnowledgeContent() {
  const { client, session, isCurrentClient } = useBackend();
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<KnowledgeResult | null>(null);
  const [activeAction, setActiveAction] = useState<'search' | 'summary' | null>(null);
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState('');
  const busy = activeAction !== null;
  async function search(useLlm: boolean) {
    if (!session || busy) return;
    if (!question.trim() || question.trim().length > 1000) {
      setError('확인할 내용을 1~1,000자로 입력해 주세요.');
      return;
    }
    setActiveAction(useLlm ? 'summary' : 'search');
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
      setActiveAction(null);
    }
  }
  const selected =
    result?.sources.filter((source) => result.answer_source_ids.includes(source.source_id)) ?? [];
  const sources = result?.status === 'retrieval_only' ? result.sources : selected;
  return (
    <Card style={s.card}>
      <View style={s.header}>
        <View style={s.headerIcon}>
          <Icon name="file-text" size={23} color="#174AA4" />
        </View>
        <View style={s.headerCopy}>
          <Text accessibilityRole="header" style={s.heading}>
            프로젝트 문서에서 근거 찾기
          </Text>
          <Text style={s.body}>계획서·보고서에서 필요한 문장과 출처를 찾아보세요.</Text>
        </View>
      </View>
      {!session && (
        <View style={s.loginNotice}>
          <Icon name="lock" size={18} color="#334155" />
          <Text style={s.loginText}>문서 검색 권한이 있는 계정으로 로그인해 주세요.</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="문서 검색을 위해 로그인 설정 열기"
            onPress={() => router.push('/settings')}
            style={s.loginLink}
          >
            <Text style={s.linkText}>로그인하기</Text>
            <Icon name="arrow-right" size={16} color="#174AA4" />
          </Pressable>
        </View>
      )}
      <View style={s.form}>
        <View style={s.labelRow}>
          <Text style={s.label}>프로젝트 문서 질문</Text>
          <Text style={s.detail}>{question.length.toLocaleString()} / 1,000자</Text>
        </View>
        <TextInput
          accessibilityLabel="프로젝트 문서 질문"
          value={question}
          onChangeText={setQuestion}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          maxLength={1000}
          multiline
          style={[s.question, focused && s.questionFocused]}
          editable={!busy}
          placeholder="예: 공매 낙찰가와 소비자 시세는 어떻게 다른가요?"
          placeholderTextColor="#56677E"
          autoCapitalize="none"
        />
        <View style={s.examples}>
          <Text style={s.examplesLabel}>빠른 질문</Text>
          {examples.map((example) => (
            <Pressable
              key={example.question}
              accessibilityRole="button"
              accessibilityLabel={example.question}
              accessibilityState={{ selected: question === example.question, disabled: busy }}
              disabled={busy}
              onPress={() => setQuestion(example.question)}
              style={({ pressed }) => [
                s.example,
                question === example.question && s.selectedExample,
                pressed && s.pressedAction,
              ]}
            >
              <Text style={s.exampleText}>{example.label}</Text>
              <Icon name="arrow-up-right" size={15} color="#334155" />
            </Pressable>
          ))}
        </View>
      </View>
      <View style={s.actionSection}>
        <View style={s.actions}>
          <SearchAction
            title="문서 근거 검색"
            icon="search"
            loading={activeAction === 'search'}
            disabled={!session || (busy && activeAction !== 'search')}
            onPress={() => void search(false)}
            testID="search-document-knowledge"
          />
          <SearchAction
            title="GPT로 문서 근거 정리"
            icon="align-left"
            secondary
            loading={activeAction === 'summary'}
            disabled={!session || (busy && activeAction !== 'summary')}
            onPress={() => void search(true)}
          />
        </View>
        <Text style={s.detail}>원문과 출처를 찾거나, 찾은 근거를 GPT로 정리할 수 있어요.</Text>
      </View>
      <View style={s.usage}>
        <Icon name="info" size={17} color="#475569" />
        <Text style={s.usageText}>
          검색에도 API 비용이 발생하며, GPT 정리는 추가 호출을 사용해요. 하루 20회 한도는 모든
          사용자가 함께 사용해요.
        </Text>
      </View>
      {error ? <Notice title="문서 검색을 완료하지 못했어요" body={error} tone="error" /> : null}
      {result && (
        <View style={s.results} testID="document-knowledge-result">
          <Text accessibilityRole="header" style={s.title}>
            {result.status === 'abstained'
              ? '답변할 문서 근거가 부족해요'
              : result.status === 'retrieval_only'
                ? '검색된 문서 원문'
                : 'GPT가 선택한 문서 근거'}
          </Text>
          <Text style={s.body}>질문: {result.question}</Text>
          {result.status !== 'abstained' &&
            sources.map((source) => (
              <View key={source.source_id} style={s.source}>
                <View style={s.sourceBadge}>
                  <Text style={s.sourceBadgeText}>{statusNames[source.status]}</Text>
                </View>
                <Text style={s.sourceTitle}>{source.document_title}</Text>
                <Text style={s.detail}>{source.location}</Text>
                <Text selectable style={s.quote}>
                  {source.quote}
                </Text>
              </View>
            ))}
          {result.limitations.map((item, index) => (
            <Text key={index} style={s.body}>
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
  card: { gap: 24, borderColor: '#D8E1ED' },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  headerIcon: { padding: 10, borderRadius: 12, backgroundColor: '#EDF3FF' },
  headerCopy: { flex: 1, gap: 8 },
  heading: { color: C.ink, fontSize: 22, lineHeight: 30, fontWeight: '800', letterSpacing: -0.5 },
  body: { color: '#475569', fontSize: 15, lineHeight: 24 },
  form: { gap: 12 },
  labelRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8 },
  label: { color: C.ink, fontSize: 16, lineHeight: 24, fontWeight: '700' },
  question: {
    minHeight: 128,
    padding: 16,
    textAlignVertical: 'top',
    color: C.ink,
    fontSize: 16,
    lineHeight: 26,
    borderWidth: 1,
    borderColor: '#94A3B8',
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
  },
  questionFocused: { borderColor: '#1455D9', backgroundColor: '#F8FAFF' },
  examples: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  examplesLabel: { color: '#475569', fontSize: 14, lineHeight: 22, marginRight: 2 },
  example: {
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 10,
    backgroundColor: '#F8FAFC',
  },
  exampleText: { color: '#334155', fontSize: 14, lineHeight: 21, fontWeight: '600' },
  selectedExample: { borderColor: '#1D4ED8', backgroundColor: '#EFF6FF' },
  actionSection: { gap: 10 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  action: {
    flexGrow: 1,
    flexBasis: 240,
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1455D9',
    backgroundColor: '#1455D9',
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 9,
  },
  actionText: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '700',
    flexShrink: 1,
    textAlign: 'center',
  },
  secondaryAction: { backgroundColor: '#FFFFFF', borderColor: '#6A84AF' },
  disabledAction: { backgroundColor: '#F1F5F9', borderColor: '#CBD5E1' },
  pressedAction: { opacity: 0.8 },
  detail: { color: '#475569', fontSize: 14, lineHeight: 22 },
  usage: {
    borderTopWidth: 1,
    borderTopColor: '#E2E8F0',
    paddingTop: 16,
    flexDirection: 'row',
    gap: 8,
  },
  usageText: { flex: 1, color: '#475569', fontSize: 14, lineHeight: 22 },
  loginNotice: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#F1F5F9',
  },
  loginText: { flexGrow: 1, flexBasis: 180, color: '#334155', fontSize: 15, lineHeight: 23 },
  loginLink: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6 },
  linkText: { color: '#174AA4', fontSize: 15, fontWeight: '700' },
  results: { gap: 16, borderTopWidth: 1, borderTopColor: '#CBD5E1', paddingTop: 24 },
  title: { color: C.ink, fontSize: 20, lineHeight: 28, fontWeight: '800' },
  source: { borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 12, padding: 18, gap: 12 },
  sourceTitle: { color: C.ink, fontSize: 18, lineHeight: 26, fontWeight: '700' },
  sourceBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#EDF3FF',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  sourceBadgeText: { color: '#174AA4', fontSize: 13, lineHeight: 20, fontWeight: '600' },
  quote: {
    color: C.ink,
    fontSize: 16,
    lineHeight: 28,
    paddingLeft: 14,
    borderLeftWidth: 3,
    borderLeftColor: '#CBD5E1',
    maxWidth: 780,
  },
});
