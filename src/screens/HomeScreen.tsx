import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { Button, C, Card, Icon, Screen, shared } from '../components/ui';
import { VehiclePicker } from '../components/VehiclePicker';
import { useApp } from '../state/AppProvider';
import { useBackend } from '../state/BackendProvider';
import { useAuctionValuation } from '../services/useAuctionValuation';
import { getVehicleMaintenance } from '../domain/maintenance';
import { departureAt } from '../domain/helpers';
import { dateLabel, timeLabel } from './tripParts';
import { useNow } from './useNow';

const money = (won: number) => Math.round(won / 10_000).toLocaleString('ko-KR');

export default function HomeScreen() {
  const { state } = useApp();
  const { session } = useBackend();
  const [question, setQuestion] = useState('');
  const now = useNow();
  const vehicle =
    state.vehicles.find((item) => item.id === state.selectedVehicleId) ?? state.vehicles[0];
  const { cached } = useAuctionValuation(vehicle);
  const evidence = cached?.result.evidence;
  const supported =
    evidence?.status === 'supported_exploratory' && evidence.prediction_krw !== undefined;
  const scenarios = evidence
    ? [
        { months: 0, prediction_krw: evidence.prediction_krw },
        ...evidence.scenarios.filter((item) => [6, 12].includes(item.months)),
      ]
    : [];
  const maximum = Math.max(1, ...scenarios.map((item) => item.prediction_krw ?? 0));
  const attention = vehicle
    ? getVehicleMaintenance(vehicle, state.maintenance, new Date(now)).filter(
        (item) => item.status === 'dueSoon' || item.status === 'overdue',
      )
    : [];
  const nextPlan = [...state.plans]
    .filter(
      (item) =>
        item.vehicleId === vehicle?.id &&
        item.eventAt &&
        Date.parse(item.eventAt) > now &&
        !state.trips.some((trip) => trip.planId === item.id),
    )
    .sort((left, right) => (left.eventAt ?? '').localeCompare(right.eventAt ?? ''))[0];
  const departure = nextPlan ? departureAt(nextPlan) : null;
  function ask(text = question) {
    router.push({
      pathname: '/ai',
      params: { question: text.trim() || '내 차 가격과 앞으로의 유지비를 비교해 주세요.' },
    });
  }
  return (
    <Screen>
      {!vehicle ? (
        <Card style={s.empty}>
          <Text accessibilityRole="header" style={s.heading}>
            내 차부터 등록해 주세요
          </Text>
          <Text style={shared.text}>차량 정보로 가격을 비교하고 이동 계획을 관리할 수 있어요.</Text>
          <Button title="내 차 등록" icon="plus" onPress={() => router.push('/vehicle')} />
        </Card>
      ) : (
        <Card style={s.home}>
          <VehiclePicker />
          <View style={s.valuation} testID="home-auction-summary">
            <View style={s.priceCopy}>
              <View style={s.titleRow}>
                <Text style={s.sectionTitle}>공매 참고 가격</Text>
                {state.demoMode && <Text style={s.sample}>예시 차량 조건</Text>}
              </View>
              {supported && evidence ? (
                <>
                  <Text style={s.price}>
                    {money(evidence.prediction_krw!)}
                    <Text style={s.priceUnit}>만원</Text>
                  </Text>
                  <Text style={s.caption}>
                    참고 범위 {money(evidence.interval_low_krw!)} ~{' '}
                    {money(evidence.interval_high_krw!)}만원
                  </Text>
                  <Text style={s.caption}>
                    같은 모델 학습 자료 {evidence.training_same_model_count.toLocaleString('ko-KR')}
                    건 · 소비자 시세와 달라요
                  </Text>
                </>
              ) : (
                <>
                  <Text style={s.emptyPrice}>
                    {evidence?.status === 'deferred'
                      ? '가격을 제시할 근거가 부족해요'
                      : '아직 분석한 가격이 없어요'}
                  </Text>
                  <Text style={s.caption}>
                    {session
                      ? '차량 조건을 확인하면 모델로 비교할 수 있어요.'
                      : '로그인하면 등록 차량의 공매 가격을 비교할 수 있어요.'}
                  </Text>
                </>
              )}
            </View>
            {supported && (
              <View style={s.chart} accessibilityLabel="현재와 보유 기간별 공매 가격 비교">
                {scenarios.map((scenario) => (
                  <View key={scenario.months} style={s.barColumn}>
                    <Text style={s.barValue}>
                      {scenario.prediction_krw === undefined
                        ? '보류'
                        : money(scenario.prediction_krw)}
                    </Text>
                    <View
                      style={[
                        s.bar,
                        {
                          height:
                            scenario.prediction_krw === undefined
                              ? 3
                              : Math.max(8, (scenario.prediction_krw / maximum) * 72),
                          backgroundColor: scenario.months === 0 ? C.primary : '#CBD7EE',
                        },
                      ]}
                    />
                    <Text style={s.barLabel}>
                      {scenario.months === 0 ? '지금' : `${scenario.months}개월`}
                    </Text>
                  </View>
                ))}
              </View>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="공매 가격 비교"
              onPress={() => ask()}
              style={s.priceLink}
            >
              <Text style={s.linkText}>{supported ? '비교 내용 보기' : '공매 가격 분석하기'}</Text>
              <Icon name="chevron-right" size={17} color={C.primary} />
            </Pressable>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={nextPlan ? '다음 이동 계획 보기' : '새 이동 계획'}
            onPress={() =>
              nextPlan
                ? router.push({ pathname: '/route', params: { id: nextPlan.id } })
                : router.push('/plan')
            }
            style={s.row}
          >
            <View style={s.rowIcon}>
              <Icon name="calendar" size={19} color={C.primary} />
            </View>
            <View style={s.rowCopy}>
              <Text style={s.rowTitle}>
                {nextPlan ? nextPlan.eventTitle || nextPlan.destination : '예정된 이동이 없어요'}
              </Text>
              <Text style={s.caption}>
                {nextPlan?.eventAt
                  ? `${dateLabel(nextPlan.eventAt)} ${timeLabel(nextPlan.eventAt)} 도착`
                  : '도착 시간에 맞춰 출발 계획을 만들어 보세요.'}
              </Text>
            </View>
            {departure && <Text style={s.departure}>{timeLabel(departure)} 출발</Text>}
            <Icon name="chevron-right" size={17} color={C.muted} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="차량 점검 기록 보기"
            onPress={() => router.push('/maintenance')}
            style={s.row}
          >
            <View style={[s.rowIcon, { backgroundColor: '#FFF4E9' }]}>
              <Icon name="tool" size={19} color="#8A5A2B" />
            </View>
            <View style={s.rowCopy}>
              <Text style={s.rowTitle}>
                {attention.length ? `점검할 항목 ${attention.length}개` : '차량 점검 기록'}
              </Text>
              <Text style={s.caption}>
                {attention.length
                  ? `${attention
                      .slice(0, 2)
                      .map((item) => item.item.name)
                      .join(' · ')} · 예시 주기 기준`
                  : '마지막 점검일과 주행거리를 관리해요.'}
              </Text>
            </View>
            <Icon name="chevron-right" size={17} color={C.muted} />
          </Pressable>
          <View style={s.composer}>
            <Icon name="message-circle" size={19} color={C.muted} />
            <TextInput
              accessibilityLabel="AI에게 물어볼 질문"
              placeholder="내 차에 대해 궁금한 점을 물어보세요"
              placeholderTextColor={C.muted}
              value={question}
              onChangeText={setQuestion}
              maxLength={1000}
              onSubmitEditing={() => ask()}
              style={s.input}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="AI 상담 열기"
              onPress={() => ask()}
              style={s.send}
            >
              <Icon name="arrow-right" color="#FFFFFF" size={20} />
            </Pressable>
          </View>
        </Card>
      )}
    </Screen>
  );
}
const s = StyleSheet.create({
  home: { gap: 24 },
  heading: { fontSize: 24, lineHeight: 32, fontWeight: '700', color: C.ink },
  empty: { gap: 20, paddingVertical: 32 },
  valuation: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 18,
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 14,
    padding: 18,
  },
  priceCopy: { flexGrow: 1, flexShrink: 1, flexBasis: 200, minWidth: 0, gap: 6 },
  titleRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  sectionTitle: { color: C.ink, fontSize: 17, lineHeight: 25, fontWeight: '700' },
  sample: {
    color: '#994515',
    backgroundColor: '#FFF1E8',
    fontSize: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  price: { color: C.primary, fontSize: 34, lineHeight: 45, fontWeight: '700', letterSpacing: -1 },
  priceUnit: { fontSize: 18 },
  emptyPrice: { color: C.ink, fontSize: 20, lineHeight: 29, fontWeight: '600', paddingVertical: 5 },
  caption: { color: C.muted, fontSize: 14, lineHeight: 22 },
  priceLink: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 5 },
  linkText: { color: C.primary, fontSize: 14, fontWeight: '600' },
  chart: { flexDirection: 'row', gap: 12, alignItems: 'flex-end', minHeight: 120 },
  barColumn: { width: 50, gap: 6, alignItems: 'center' },
  barValue: { color: C.ink, fontSize: 12, fontWeight: '600' },
  bar: { width: 42, borderTopLeftRadius: 7, borderTopRightRadius: 7 },
  barLabel: { color: C.muted, fontSize: 12 },
  row: {
    minHeight: 76,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 12,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: C.line,
  },
  rowIcon: { padding: 10, backgroundColor: C.mint, borderRadius: 10 },
  rowCopy: { flexGrow: 1, flexBasis: 160, gap: 3 },
  rowTitle: { color: C.ink, fontSize: 16, lineHeight: 24, fontWeight: '600' },
  departure: { color: C.primary, fontSize: 14, lineHeight: 23, fontWeight: '700' },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 12,
    padding: 10,
    backgroundColor: '#FAFBFD',
  },
  input: { flex: 1, minWidth: 0, minHeight: 44, fontSize: 15, lineHeight: 23, color: C.ink },
  send: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: C.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
