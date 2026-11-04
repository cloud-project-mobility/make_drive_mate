import { useEffect, useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Button, C, Card, Field, Icon, Notice, Screen } from '../components/ui';
import type { Vehicle } from '../domain/types';
import {
  auctionInputFromDraft,
  consultationContext,
  createAuctionDraft,
  type AuctionDraft,
} from '../domain/aiConsultation';
import { useApp } from '../state/AppProvider';
import { useBackend } from '../state/BackendProvider';
import { backendMessage } from '../services/backend';
import { queryAssistant, type AssistantResult } from '../services/aiConsultation';
import {
  useAuctionValuation,
  type AuctionAnalysisInput,
  type AuctionCacheEntry,
} from '../services/useAuctionValuation';

const money = (value: number) =>
  `${(value / 10_000).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}만원`;
const sourceUrl = 'https://data.go.kr/data/15157252/openapi.do';
const examples = [
  '지금 팔아도 괜찮을까요?',
  '다음 정비는 무엇을 확인할까요?',
  '다음 이동은 언제 출발하면 될까요?',
];

function PriceEvidence({ entry }: { entry: AuctionCacheEntry }) {
  const [expanded, setExpanded] = useState(false);
  const { evidence } = entry.result;
  const cases = evidence.comparable_cases;
  const months = [0, 6, 12];
  const values = months.map((month) =>
    month === 0
      ? evidence.prediction_krw
      : evidence.scenarios.find((item) => item.months === month)?.prediction_krw,
  );
  const maximum = Math.max(1, ...values.filter((item): item is number => typeof item === 'number'));
  return (
    <Card style={s.evidence}>
      <View style={s.row}>
        <Icon name="bar-chart-2" color={C.primary} />
        <Text style={s.cardTitle}>공매 조건 비교</Text>
      </View>
      {entry.demoInput && <Text style={s.warning}>예시 차량을 입력한 분석이에요.</Text>}
      <Text style={s.body}>
        소비자 시세가 아닌 온비드 낙찰가 기준이에요. 미래 시장을 고정하고 차령·주행거리만 바꿔
        비교해요.
      </Text>
      {evidence.status === 'deferred' ? (
        <Notice
          tone="warning"
          title="표본 또는 지원 범위가 부족해 가격을 보류했어요"
          body="실제 모델명과 차량 조건을 확인해 주세요. 지원되지 않는 차량의 값을 대신 만들지 않아요."
        />
      ) : (
        <>
          <View style={s.metrics}>
            {months.map((month, index) => (
              <View key={month} style={s.metric}>
                <Text style={s.caption}>
                  {month === 0 ? '현재 조건' : `${month}개월 보유 조건`}
                </Text>
                <Text style={s.price}>
                  {values[index] === undefined ? '비교 보류' : money(values[index]!)}
                </Text>
                <View
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                  style={s.track}
                >
                  <View
                    style={[
                      s.bar,
                      { width: `${Math.max(0, ((values[index] ?? 0) / maximum) * 100)}%` },
                    ]}
                  />
                </View>
              </View>
            ))}
          </View>
          <Text style={s.body}>
            현재 참고 범위 {money(evidence.interval_low_krw!)} ~{' '}
            {money(evidence.interval_high_krw!)}
          </Text>
        </>
      )}
      <View style={s.assumption}>
        <Text style={s.body}>
          입력 가정 · 월 {entry.input.monthly_km.toLocaleString('ko-KR')}km · 월 유지비{' '}
          {money(entry.input.monthly_upkeep_krw)}
        </Text>
        <Text style={s.caption}>
          유지비는 사용자가 입력한 금액이며 실제 지출이나 정비 견적이 아니에요.
        </Text>
      </View>
      <Text style={s.body}>
        같은 모델 학습 자료 {evidence.training_same_model_count.toLocaleString('ko-KR')}건 · 표시
        가능한 실제 비교 사례 {cases === undefined ? '미제공' : `${cases.length}건`}
      </Text>
      {evidence.training_same_model_count < 10 && (
        <Notice
          title="같은 모델 표본이 적어요"
          body="결과의 불확실성이 커요. 실제 매입 견적과 차량 상태를 함께 확인하세요."
          tone="warning"
        />
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={expanded ? '가격 근거 접기' : '가격 근거와 출처 보기'}
        aria-expanded={expanded}
        onPress={() => setExpanded(!expanded)}
        style={s.details}
      >
        <Text style={s.link}>{expanded ? '근거 접기' : '가격 근거와 출처 보기'}</Text>
        <Icon name={expanded ? 'chevron-up' : 'chevron-down'} color={C.primary} />
      </Pressable>
      {expanded && (
        <View style={s.stack}>
          <Text style={s.caption}>
            전체 시험 자료 평균 절대오차 {money(evidence.test_mae_krw)}. 이 차량의 오차를 보장하지
            않아요. 참고 범위의 시험 포함률은 {evidence.test_interval_coverage_pct.toFixed(1)}%예요.
          </Text>
          {cases?.map((item) => (
            <View key={item.evidence_id} style={s.case}>
              <Text style={s.caseTitle}>
                {item.model} · {money(item.auction_award_krw)}
              </Text>
              <Text style={s.caption}>
                {item.event_date} 개찰 · 근사 차령 {item.age_years}년 ·{' '}
                {item.odometer_km.toLocaleString('ko-KR')}km
              </Text>
            </View>
          ))}
          <Text style={s.caption}>
            학습 자료 중 같은 모델에서 차령·주행거리가 가까운 사례예요. 사고·옵션까지 같은
            차량이거나 최근 전체 거래 목록이라는 뜻은 아니에요.
          </Text>
          {evidence.limitations.map((item, index) => (
            <Text key={index} style={s.caption}>
              • {item}
            </Text>
          ))}
          {evidence.warnings.length > 0 && (
            <Text style={s.warning}>
              일부 입력 범주 또는 조건 변화에 경고가 있어요. 가격이 일정하게 내려간다고 가정하지
              마세요.
            </Text>
          )}
          <Button
            title="온비드 데이터 공식 출처"
            variant="ghost"
            icon="external-link"
            onPress={() => {
              void Linking.openURL(sourceUrl);
            }}
          />
        </View>
      )}
    </Card>
  );
}

type Message = { question: string; result: AssistantResult };
function Consultation({
  vehicle,
  initialQuestion,
}: {
  vehicle?: Vehicle;
  initialQuestion: string;
}) {
  const { state } = useApp();
  const { client, session, isCurrentClient } = useBackend();
  const valuation = useAuctionValuation(vehicle);
  const [question, setQuestion] = useState(initialQuestion.slice(0, 1000));
  const [draft, setDraft] = useState<AuctionDraft>(() => createAuctionDraft(vehicle));
  const [confirmedInput, setConfirmedInput] = useState<AuctionAnalysisInput | null>(null);
  const [draftDirty, setDraftDirty] = useState(false);
  const [showForm, setShowForm] = useState(initialQuestion.includes('가격'));
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showPrivacy, setShowPrivacy] = useState(false);
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const [previousParam, setPreviousParam] = useState(initialQuestion);
  if (previousParam !== initialQuestion) {
    setPreviousParam(initialQuestion);
    setQuestion(initialQuestion.slice(0, 1000));
  }
  const [previousClient, setPreviousClient] = useState(client);
  if (previousClient !== client) {
    setPreviousClient(client);
    setQuestion('');
    setMessages([]);
    setBusy(false);
    setError('');
    setConfirmedInput(null);
  }
  useEffect(() => {
    sequence.current += 1;
    inFlight.current = false;
    return () => {
      sequence.current += 1;
    };
  }, [client]);
  const update = (field: keyof AuctionDraft, value: string) => {
    setDraft((previous) => ({ ...previous, [field]: value }));
    setConfirmedInput(null);
    setDraftDirty(true);
    valuation.clearError();
  };
  async function analyze() {
    try {
      const input = auctionInputFromDraft(draft);
      setError('');
      const result = await valuation.analyze(input);
      if (result) {
        setConfirmedInput(input);
        setDraftDirty(false);
        setShowForm(false);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '차량 입력을 확인해 주세요.');
    }
  }
  async function send() {
    if (!session || inFlight.current || valuation.busy) return;
    const value = question.trim();
    if (!value || value.length > 1000) {
      setError('질문을 1~1,000자로 입력해 주세요.');
      return;
    }
    const current = ++sequence.current;
    inFlight.current = true;
    setBusy(true);
    setError('');
    const input = confirmedInput ?? (!draftDirty ? valuation.cached?.input : null);
    try {
      const result = await queryAssistant(client, {
        question: value,
        ...(messages.length ? { previous_question: messages.at(-1)!.question } : {}),
        context: consultationContext(state, vehicle),
        ...(input && !showForm ? { analysis: input } : {}),
      });
      if (current !== sequence.current || !isCurrentClient(client)) return;
      if (result.valuation && input) valuation.remember(result.valuation, input);
      setMessages((previous) => [...previous, { question: value, result }].slice(-8));
      setQuestion('');
    } catch (cause) {
      if (current === sequence.current && isCurrentClient(client)) setError(backendMessage(cause));
    } finally {
      if (current === sequence.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  const fields: { key: keyof AuctionDraft; label: string; numeric?: boolean; hint?: string }[] = [
    { key: 'make', label: '제조사 (미상이면 비움)' },
    { key: 'model', label: '실제 모델명' },
    { key: 'year', label: '연식', numeric: true },
    { key: 'mileage', label: '누적 주행거리 (km)', numeric: true },
    { key: 'fuel', label: '연료 (미상이면 비움)' },
    { key: 'category', label: '차종 분류 (미상이면 비움)', hint: '예: 승용차, SUV, 경차' },
    { key: 'engine', label: '배기량 (cc, 미상이면 비움)', numeric: true },
    {
      key: 'monthlyKm',
      label: '월 예상 주행거리 (km)',
      numeric: true,
      hint: '초기 1,000km는 변경 가능한 가정이에요.',
    },
    {
      key: 'upkeep',
      label: '월 유지비 (만원)',
      numeric: true,
      hint: '직접 입력한 보유비용 가정. 제외하려면 0을 입력하세요.',
    },
  ];
  return (
    <Card style={s.chatShell}>
      <View style={s.context}>
        <Icon name="message-circle" color={C.primary} />
        <View style={s.flex}>
          <Text style={s.contextTitle} numberOfLines={1}>
            {vehicle ? vehicle.model : '선택한 차량 없음'}
          </Text>
          {state.demoMode && <Text style={s.caption}>예시 차량 · 실제 기록 아님</Text>}
        </View>
      </View>
      {!session && (
        <View style={s.loginRow}>
          <Text style={[s.caption, s.flex]}>로그인이 필요해요</Text>
          <Button title="서비스 로그인" variant="ghost" onPress={() => router.push('/settings')} />
        </View>
      )}
      {messages.length === 0 && (
        <View style={s.chips}>
          {examples.map((item, index) => (
            <Pressable
              key={item}
              accessibilityRole="button"
              accessibilityLabel={item}
              disabled={busy}
              onPress={() => setQuestion(item)}
              style={s.chip}
            >
              <Text style={s.chipText}>
                {['매도 조건 비교', '정비 기록 확인', '다음 출발 시간'][index]}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      {vehicle && (
        <View style={s.smallAction}>
          <Button
            title={showForm ? '차량 분석 입력 접기' : '차량 조건·유지비 확인'}
            variant="ghost"
            icon="sliders"
            disabled={busy || valuation.busy}
            onPress={() => setShowForm(!showForm)}
          />
        </View>
      )}
      {showForm && vehicle && (
        <Card style={s.stack}>
          <Text style={s.cardTitle}>분석할 차량 조건</Text>
          <Text style={s.body}>
            자동으로 채운 카탈로그 정보도 실제 차량과 일치하는지 확인해 주세요. 구동 방식만으로
            연료·배기량을 추정하지 않아요.
          </Text>
          <View style={s.form}>
            {fields.map((field) => (
              <View key={field.key} style={s.formCell}>
                <Field
                  label={field.label}
                  hint={field.hint}
                  value={draft[field.key]}
                  onChangeText={(value) => update(field.key, value)}
                  keyboardType={field.numeric ? 'decimal-pad' : 'default'}
                  maxLength={100}
                  editable={!busy && !valuation.busy}
                />
              </View>
            ))}
          </View>
          <Button
            title="입력 확인하고 공매 가격 분석"
            onPress={() => {
              void analyze();
            }}
            loading={valuation.busy}
            disabled={!session || busy}
            icon="bar-chart-2"
          />
          <Text style={s.caption}>
            이 버튼은 가격 모델만 실행해요. GPT 상담은 아래 전송 버튼을 눌렀을 때 별도로 실행해요.
          </Text>
        </Card>
      )}
      {valuation.cached && <PriceEvidence entry={valuation.cached} />}
      <View style={s.messages} accessibilityLiveRegion="polite">
        {messages.map((message, index) => (
          <View style={s.stack} key={index}>
            <View style={s.userBubble}>
              <Text style={s.userText}>{message.question}</Text>
            </View>
            <Card style={s.answer}>
              <View style={s.row}>
                <Icon name="message-circle" color={C.primary} />
                <Text style={s.cardTitle}>DriveMate AI</Text>
                <Text style={s.caption}>
                  {message.result.status === 'abstained' ? '답변 유보' : '근거와 함께'}
                </Text>
              </View>
              <Text style={s.answerText}>{message.result.answer}</Text>
              {message.result.facts.map((fact) => (
                <Text key={fact.id} style={fact.kind === 'caution' ? s.caption : s.body}>
                  • {fact.statement}
                </Text>
              ))}
              <Text style={s.caption}>
                AI 설명은 잘못될 수 있어요. 가격 숫자는 모델 계산값이며 거래를 보장하지 않아요.
              </Text>
            </Card>
          </View>
        ))}
      </View>
      {(error || valuation.error) && <Notice title={error || valuation.error} tone="error" />}
      {valuation.cached && (
        <View style={s.chips}>
          {[
            '6개월 더 보유하면 어떤 점을 비교해야 하나요?',
            '비슷한 차량의 실제 낙찰 근거를 설명해 주세요.',
            '유지비를 바꿔 비교하고 싶어요.',
          ].map((item) => (
            <Pressable
              key={item}
              style={s.chip}
              accessibilityRole="button"
              onPress={() => {
                setQuestion(item);
                if (item.includes('유지비')) setShowForm(true);
              }}
              disabled={busy}
            >
              <Text style={s.chipText}>{item}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <View style={s.composer}>
        <TextInput
          accessibilityLabel="AI 상담 질문"
          placeholder="지금 팔기 전에 무엇을 비교하면 좋을까요?"
          placeholderTextColor="#58677E"
          multiline
          maxLength={1000}
          value={question}
          onChangeText={setQuestion}
          editable={!busy}
          style={s.input}
        />
        <View style={s.composeActions}>
          <Text style={s.caption}>{question.length}/1,000</Text>
          <Button
            title={busy ? '답변 확인 중' : 'AI에게 보내기'}
            icon="arrow-up"
            loading={busy}
            disabled={!session || !question.trim() || valuation.busy}
            onPress={() => {
              void send();
            }}
          />
        </View>
        <Text style={s.caption}>질문·기록 요약을 OpenAI로 전송해요.</Text>
        <Pressable
          style={s.privacyButton}
          accessibilityRole="button"
          aria-expanded={showPrivacy}
          onPress={() => setShowPrivacy(!showPrivacy)}
        >
          <Icon name="info" size={15} color={C.muted} />
          <Text style={s.caption}>전송 정보·이용 안내 {showPrivacy ? '접기' : '보기'}</Text>
        </Pressable>
        {showPrivacy && (
          <Text style={s.caption}>
            전송 시 질문, 직전 질문, 차량 분석 입력·계산 근거, 정비 항목 상태와 다음 일정 시각을
            OpenAI로 보내요. 주소·좌표·메모·일정 제목은 자동 전송하지 않아요. 질문에 개인정보를 넣지
            마세요. 전송마다 서버의 AI 이용 한도가 적용되며 운영자 API 비용이 발생해요. 상담은
            메모리에만 남고 차량·계정 변경 시 비워져요.
          </Text>
        )}
      </View>
    </Card>
  );
}

export default function AiConsultation() {
  const { state } = useApp();
  const { session, url } = useBackend();
  const params = useLocalSearchParams<{ question?: string | string[] }>();
  const vehicle = state.vehicles.find((item) => item.id === state.selectedVehicleId);
  const initialQuestion = typeof params.question === 'string' ? params.question : '';
  return (
    <Screen title="AI 상담">
      <Consultation
        key={JSON.stringify([vehicle, state.demoMode, url, session?.user.id, session?.expires_at])}
        vehicle={vehicle}
        initialQuestion={initialQuestion}
      />
    </Screen>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  stack: { gap: 14 },
  chatShell: { gap: 12, padding: 16, minHeight: 480 },
  smallAction: { alignSelf: 'flex-start' },
  loginRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  context: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
    backgroundColor: '#F5F7FC',
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  contextTitle: { color: C.ink, fontSize: 16, fontWeight: '700', lineHeight: 24 },
  body: { color: C.ink, fontSize: 15, lineHeight: 24 },
  caption: { color: C.muted, fontSize: 13, lineHeight: 21 },
  cardTitle: { color: C.ink, fontSize: 17, fontWeight: '700', lineHeight: 25 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#D8E2FC',
    borderRadius: 24,
    backgroundColor: '#FFF',
    maxWidth: '100%',
  },
  chipText: { color: '#2149AF', fontSize: 14, lineHeight: 21, flexShrink: 1 },
  evidence: { gap: 16, borderColor: '#CFDBFA' },
  metrics: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  metric: {
    flexGrow: 1,
    flexBasis: 180,
    minWidth: 0,
    gap: 9,
    backgroundColor: '#F5F7FC',
    padding: 14,
    borderRadius: 12,
  },
  price: { color: C.primary, fontSize: 23, fontWeight: '800', lineHeight: 32 },
  track: { height: 6, backgroundColor: '#DCE4F7', borderRadius: 3, overflow: 'hidden' },
  bar: { height: 6, backgroundColor: C.primary, borderRadius: 3 },
  assumption: { gap: 4, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 14 },
  warning: { color: C.amber, fontSize: 14, lineHeight: 23 },
  details: {
    minHeight: 44,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  link: { color: '#2149AF', fontSize: 14, fontWeight: '700' },
  case: { gap: 4, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 12 },
  caseTitle: { color: C.ink, fontSize: 15, fontWeight: '700', lineHeight: 23 },
  form: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  formCell: { flexBasis: 230, flexGrow: 1, minWidth: 0 },
  messages: { gap: 22 },
  userBubble: {
    alignSelf: 'flex-end',
    maxWidth: '94%',
    paddingHorizontal: 18,
    paddingVertical: 14,
    backgroundColor: C.primary,
    borderRadius: 18,
    borderBottomRightRadius: 4,
  },
  userText: { color: '#FFF', fontSize: 16, lineHeight: 25 },
  answer: { gap: 14 },
  answerText: { color: C.ink, fontSize: 16, lineHeight: 27, maxWidth: 780 },
  composer: { gap: 8, marginTop: 'auto', paddingTop: 12, borderColor: C.line, borderTopWidth: 1 },
  input: {
    minHeight: 72,
    fontSize: 16,
    lineHeight: 25,
    textAlignVertical: 'top',
    color: C.ink,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#BDCAE0',
    backgroundColor: '#FFF',
  },
  composeActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
  },
  privacyButton: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 7 },
});
