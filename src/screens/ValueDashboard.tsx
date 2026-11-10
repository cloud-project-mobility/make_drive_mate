import { useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { Button, C, Card, Chip, Field, Icon, Notice, SectionTitle, shared } from '../components/ui';
import { VehicleArt } from '../components/VehicleArt';
import { ValuationChart } from '../components/ValuationChart';
import OnbidAnalytics from './OnbidAnalytics';
import OnbidValuation from './OnbidValuation';
import {
  createValuationInput,
  simulateValuation,
  validateValuationInput,
  VALUATION_AS_OF,
  VALUATION_MONTHS,
  type ValuationErrors,
  type ValuationInput,
  type ValuationMonth,
} from '../domain/valuation';
import type { Vehicle } from '../domain/types';

type NumericField = Exclude<
  keyof ValuationInput,
  'minimumHoldMonths' | 'historyKnown' | 'recentQuoteManwon' | 'recentQuoteDate'
>;
type Draft = Record<NumericField, string> &
  Pick<ValuationInput, 'minimumHoldMonths' | 'historyKnown'> & {
    recentQuoteManwon: string;
    recentQuoteDate: string;
  };
const format = (value: number) => Math.round(value).toLocaleString('ko-KR');
const monthLabel = (month: number) => (month === 0 ? '지금' : `${month}개월 후`);

function toDraft(input: ValuationInput): Draft {
  return {
    modelYear: Number.isFinite(input.modelYear) ? String(input.modelYear) : '',
    odometerKm: String(input.odometerKm),
    originalPriceManwon: String(input.originalPriceManwon),
    monthlyKm: String(input.monthlyKm),
    monthlyUpkeepManwon: String(input.monthlyUpkeepManwon),
    holdingBudgetManwon: String(input.holdingBudgetManwon),
    targetSaleManwon: String(input.targetSaleManwon),
    minimumHoldMonths: input.minimumHoldMonths,
    historyKnown: input.historyKnown,
    recentQuoteManwon: input.recentQuoteManwon === undefined ? '' : String(input.recentQuoteManwon),
    recentQuoteDate: input.recentQuoteDate ?? '',
  };
}

function fromDraft(draft: Draft): ValuationInput {
  const numeric = (key: NumericField) => {
    const text = draft[key].trim().replaceAll(',', '');
    return /^\d+(\.\d+)?$/.test(text) ? Number(text) : Number.NaN;
  };
  return {
    modelYear: numeric('modelYear'),
    odometerKm: numeric('odometerKm'),
    originalPriceManwon: numeric('originalPriceManwon'),
    monthlyKm: numeric('monthlyKm'),
    monthlyUpkeepManwon: numeric('monthlyUpkeepManwon'),
    holdingBudgetManwon: numeric('holdingBudgetManwon'),
    targetSaleManwon: numeric('targetSaleManwon'),
    minimumHoldMonths: draft.minimumHoldMonths,
    historyKnown: draft.historyKnown,
    ...(draft.recentQuoteManwon.trim() || draft.recentQuoteDate.trim()
      ? {
          recentQuoteManwon: /^\d+(\.\d+)?$/.test(
            draft.recentQuoteManwon.trim().replaceAll(',', ''),
          )
            ? Number(draft.recentQuoteManwon.trim().replaceAll(',', ''))
            : Number.NaN,
          recentQuoteDate: draft.recentQuoteDate.trim(),
        }
      : {}),
  };
}

export default function ValueDashboard({
  vehicle,
  onApplied,
  onOfflineLayout,
}: {
  vehicle: Vehicle;
  onApplied?: () => void;
  onOfflineLayout?: (offset: number) => void;
}) {
  const { width } = useWindowDimensions();
  const wide = width >= 820;
  const [input, setInput] = useState(() => createValuationInput(vehicle));
  const [draft, setDraft] = useState(() => toDraft(input));
  const [errors, setErrors] = useState<ValuationErrors>({});
  const [editing, setEditing] = useState(
    () => Object.keys(validateValuationInput(input)).length > 0,
  );
  const [selected, setSelected] = useState<ValuationMonth>(() =>
    Object.keys(validateValuationInput(input)).length
      ? 0
      : (simulateValuation(input).recommendation.month ?? 0),
  );
  const [showMethod, setShowMethod] = useState(false);
  const [applied, setApplied] = useState(false);
  const appliedNotice = useRef<View>(null);
  const editButton = useRef<View>(null);
  const fields = useRef<Partial<Record<keyof ValuationInput, TextInput | null>>>({});
  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(input));
  const result = useMemo(
    () => (Object.keys(validateValuationInput(input)).length ? null : simulateValuation(input)),
    [input],
  );
  const active = result?.scenarios.find((s) => s.month === selected);

  function apply(next: ValuationInput) {
    const validation = validateValuationInput(next);
    setErrors(validation);
    if (Object.keys(validation).length) {
      const first = Object.keys(validation)[0] as keyof ValuationInput;
      fields.current[first]?.focus();
      return;
    }
    setInput(next);
    setDraft(toDraft(next));
    setSelected(simulateValuation(next).recommendation.month ?? 0);
    setEditing(false);
    setApplied(true);
    requestAnimationFrame(() => {
      appliedNotice.current?.focus();
      onApplied?.();
    });
  }

  function cancelEditing() {
    setDraft(toDraft(input));
    setErrors({});
    setEditing(false);
    requestAnimationFrame(() => editButton.current?.focus());
  }

  function openEditing() {
    setApplied(false);
    setEditing(true);
    requestAnimationFrame(() => fields.current.modelYear?.focus());
  }

  return (
    <View style={s.stack} testID="valuation-dashboard">
      <OnbidValuation key={vehicle.id} vehicle={vehicle} />
      <OnbidAnalytics />
      <View
        style={s.stack}
        testID="offline-valuation"
        onLayout={(event) => onOfflineLayout?.(event.nativeEvent.layout.y)}
      >
        <SectionTitle title="오프라인 가정 계산" />
        <View style={s.statusRow}>
          <View style={s.statusPill}>
            <View style={s.statusDot} />
            <Text style={s.statusText}>
              {result?.source === 'input-quote'
                ? '입력 견적 기준 · 미래는 가정'
                : '합성 데이터 · 규칙 기반 목업'}
            </Text>
          </View>
          <Text style={s.small}>아래는 오프라인 가정 계산 · {VALUATION_AS_OF} 기준</Text>
        </View>

        {applied && !editing && (
          <Notice
            noticeRef={appliedNotice}
            testID="valuation-applied"
            title="분석 조건을 적용했어요"
            body="선택한 비교 시점과 비용 내역도 함께 바뀌었어요."
          />
        )}
        {editing && dirty && (
          <Notice
            title="아직 적용하지 않은 변경이 있어요"
            body={
              result
                ? '표시된 결과는 이전 조건 기준이에요. 다시 비교를 누르면 변경한 조건이 적용돼요.'
                : '입력한 조건으로 다시 비교하면 결과를 확인할 수 있어요.'
            }
            tone="warning"
          />
        )}
        {result && (
          <View style={[s.advice, result.recommendation.status !== 'candidate' && s.cautious]}>
            {width >= 420 && (
              <View style={s.adviceIcon}>
                <Icon
                  name={result.recommendation.status === 'deferred' ? 'pause-circle' : 'compass'}
                  color={C.primary}
                  size={23}
                />
              </View>
            )}
            <View style={{ flex: 1, gap: 8 }}>
              <Text style={s.overline}>
                {result.recommendation.status === 'deferred'
                  ? '판단을 보류하는 이유'
                  : result.recommendation.status === 'conditional'
                    ? '가격·비용 조건 재확인 필요'
                    : '나의 조건에 맞는 비교 시점'}
              </Text>
              <Text accessibilityRole="header" style={s.adviceTitle} testID="valuation-advice">
                {result.recommendation.title}
              </Text>
              {result.recommendation.reasons.map((reason) => (
                <Text style={s.adviceBody} key={reason}>
                  {reason}
                </Text>
              ))}
              {!editing && (
                <Button
                  title="내 조건으로 비교하기"
                  variant="secondary"
                  icon="sliders"
                  onPress={openEditing}
                />
              )}
            </View>
          </View>
        )}

        {result && (
          <View style={[s.heroRow, wide && s.horizontal]}>
            <View style={[s.valueHero, wide && { flex: 0.85 }]}>
              <View style={shared.between}>
                <Text style={s.lightLabel}>
                  {result.source === 'input-quote' ? '입력 견적 기준값' : '내 차의 가정 가치'}
                </Text>
                <Icon name="trending-down" color="#9FE2C9" size={20} />
              </View>
              <Text style={s.heroVehicle}>{vehicle.name}</Text>
              <Text style={s.value} testID="current-simulated-value">
                {format(result.currentValueManwon)}
                <Text style={s.valueUnit}> 만원</Text>
              </Text>
              <Text style={s.range}>
                {format(result.scenarios[0].lowManwon)} ~ {format(result.scenarios[0].highManwon)}
                만원
              </Text>
              <Text style={s.lightSmall}>가정 변화 범위 · 거래 확정가 아님</Text>
              <VehicleArt
                type={vehicle.powertrain}
                model={vehicle.model}
                catalogId={vehicle.catalogId}
                caption={false}
                style={{ height: wide ? 190 : 175, marginVertical: 14 }}
              />
              <View style={s.heroDivider} />
              <Text style={s.heroSummary}>
                {input.modelYear}년식 · 분석 주행 {format(input.odometerKm)}km
              </Text>
              <Text style={s.lightSmall}>
                {result.source === 'input-quote'
                  ? `견적일 ${input.recentQuoteDate} · 사용자 직접 입력`
                  : `가상 기준가 ${format(input.originalPriceManwon)}만원 가정`}
              </Text>
            </View>
            <Card style={[s.chartCard, wide && { flex: 1.35 }]}>
              <View style={shared.between}>
                <View style={{ flex: 1, gap: 5 }}>
                  <Text accessibilityRole="header" style={s.cardTitle}>
                    시간에 따른 가치의 흐름
                  </Text>
                  <Text style={s.small}>
                    {result.source === 'input-quote'
                      ? '입력 견적과 월 예상 주행량을 기준으로 비교해요'
                      : '연식과 주행거리를 바꾸면 곡선도 달라져요'}
                  </Text>
                </View>
                <View style={s.chartTag}>
                  <Text style={s.tagText}>24개월 비교</Text>
                </View>
              </View>
              <ValuationChart
                scenarios={result.scenarios}
                selected={selected}
                quoteAnchored={result.source === 'input-quote'}
              />
              <Text style={s.chartFootnote}>
                공통 감가식의 예시 계산이에요. 색칠 영역은 임의의 가정 변화 범위이며, 통계적
                신뢰구간이 아니에요.
              </Text>
            </Card>
          </View>
        )}

        <Card style={s.conditions}>
          <View style={[s.conditionsHeading, wide && s.horizontal]}>
            <View style={{ flex: 1, gap: 5 }}>
              <Text accessibilityRole="header" style={s.cardTitle}>
                내가 정하는 매도 조건
              </Text>
              <Text style={shared.muted} testID="condition-summary">
                최소 {input.minimumHoldMonths}개월 보유 · 누적 비용{' '}
                {format(input.holdingBudgetManwon)}만원 이내 · 매도가{' '}
                {format(input.targetSaleManwon)}
                만원 이상
              </Text>
            </View>
            <Button
              buttonRef={editButton}
              title={editing ? '입력창 닫기' : '분석 조건 바꾸기'}
              icon="sliders"
              variant="secondary"
              onPress={() => {
                if (editing) cancelEditing();
                else openEditing();
              }}
            />
          </View>
          {editing && (
            <View style={s.form}>
              <Text style={s.formIntro}>
                값을 바꾼 뒤 다시 비교해 주세요. 입력창을 닫으면 적용하지 않은 변경은 취소돼요.
              </Text>
              <Text style={s.formIntro}>
                연식은 등록 문구의 마지막 연도에서 추정하므로 실제 연식을 확인해 주세요. 주행거리는
                등록 정보, 나머지는 분석용 예시값으로 시작해요. 등록월이 없어 연식 차이로 차령을
                계산해요.
              </Text>
              <View style={[s.fields, wide && s.horizontal]}>
                <View style={s.fieldColumn}>
                  <Field
                    label="분석 연식 (년)"
                    value={draft.modelYear}
                    keyboardType="numeric"
                    onChangeText={(value) => setDraft({ ...draft, modelYear: value })}
                    error={errors.modelYear}
                    inputRef={(node) => {
                      fields.current.modelYear = node;
                    }}
                  />
                  <Field
                    label="분석 누적 주행거리 (km)"
                    value={draft.odometerKm}
                    keyboardType="numeric"
                    onChangeText={(value) => setDraft({ ...draft, odometerKm: value })}
                    error={errors.odometerKm}
                    inputRef={(node) => {
                      fields.current.odometerKm = node;
                    }}
                  />
                  <Field
                    label="가상 기준가 (만원)"
                    value={draft.originalPriceManwon}
                    keyboardType="numeric"
                    onChangeText={(value) => setDraft({ ...draft, originalPriceManwon: value })}
                    error={errors.originalPriceManwon}
                    inputRef={(node) => {
                      fields.current.originalPriceManwon = node;
                    }}
                    hint="차종별 실제 신차가를 조회한 값이 아니에요."
                  />
                </View>
                <View style={s.fieldColumn}>
                  <Field
                    label="월 예상 주행거리 (km)"
                    value={draft.monthlyKm}
                    keyboardType="numeric"
                    onChangeText={(value) => setDraft({ ...draft, monthlyKm: value })}
                    error={errors.monthlyKm}
                    inputRef={(node) => {
                      fields.current.monthlyKm = node;
                    }}
                  />
                  <Field
                    label="월 유지비 가정 (만원)"
                    value={draft.monthlyUpkeepManwon}
                    keyboardType="numeric"
                    onChangeText={(value) => setDraft({ ...draft, monthlyUpkeepManwon: value })}
                    error={errors.monthlyUpkeepManwon}
                    inputRef={(node) => {
                      fields.current.monthlyUpkeepManwon = node;
                    }}
                    hint="보험·세금·정비·연료 등 월평균 합계. 감가 제외."
                  />
                  <Field
                    label="누적 추가 보유 비용 한도 (만원)"
                    value={draft.holdingBudgetManwon}
                    keyboardType="numeric"
                    onChangeText={(value) => setDraft({ ...draft, holdingBudgetManwon: value })}
                    error={errors.holdingBudgetManwon}
                    inputRef={(node) => {
                      fields.current.holdingBudgetManwon = node;
                    }}
                    hint="지금부터 매도까지의 감가 + 유지비 총액."
                  />
                </View>
                <View style={s.fieldColumn}>
                  <Field
                    label="목표 최소 매도가 (만원)"
                    value={draft.targetSaleManwon}
                    keyboardType="numeric"
                    onChangeText={(value) => setDraft({ ...draft, targetSaleManwon: value })}
                    error={errors.targetSaleManwon}
                    inputRef={(node) => {
                      fields.current.targetSaleManwon = node;
                    }}
                  />
                  <Text style={s.label}>최소 보유 기간</Text>
                  <View style={s.wrap}>
                    {VALUATION_MONTHS.map((month) => (
                      <Chip
                        key={month}
                        label={`${month}개월 이상`}
                        selected={draft.minimumHoldMonths === month}
                        onPress={() => setDraft({ ...draft, minimumHoldMonths: month })}
                      />
                    ))}
                  </View>
                  <Text style={s.label}>시뮬레이션 이력 가정</Text>
                  <View style={s.wrap}>
                    <Chip
                      label="무사고·비침수 가정"
                      selected={draft.historyKnown}
                      onPress={() => setDraft({ ...draft, historyKnown: true })}
                    />
                    <Chip
                      label="이력 미확인"
                      selected={!draft.historyKnown}
                      onPress={() => setDraft({ ...draft, historyKnown: false })}
                    />
                  </View>
                  <Text style={s.small}>
                    사고차·침수차에는 이 공통식을 적용할 수 없어요. 이력 미확인을 선택하면 시점
                    제안을 유보해요.
                  </Text>
                </View>
              </View>
              <View style={s.quoteFields}>
                <Text style={s.cardTitle}>최근 매입견적이 있다면 (선택)</Text>
                <Text style={s.small}>
                  두 칸을 비우면 합성 기준가를 사용해요. 입력하면 견적일 가격을 현재 기준값으로
                  고정하고, 이후 감가 비율만 적용해요. 견적의 진위나 거래 성립은 확인하지 않아요.
                </Text>
                <View style={[s.fields, wide && s.horizontal]}>
                  <View style={s.fieldColumn}>
                    <Field
                      label="최근 매입견적 (만원, 선택)"
                      value={draft.recentQuoteManwon}
                      keyboardType="numeric"
                      onChangeText={(value) => setDraft({ ...draft, recentQuoteManwon: value })}
                      error={errors.recentQuoteManwon}
                      inputRef={(node) => {
                        fields.current.recentQuoteManwon = node;
                      }}
                      placeholder="예: 1850"
                    />
                  </View>
                  <View style={s.fieldColumn}>
                    <Field
                      label="견적일 (YYYY-MM-DD, 선택)"
                      value={draft.recentQuoteDate}
                      onChangeText={(value) => setDraft({ ...draft, recentQuoteDate: value })}
                      error={errors.recentQuoteDate}
                      inputRef={(node) => {
                        fields.current.recentQuoteDate = node;
                      }}
                      placeholder="2026-11-02"
                      hint="이 목업 기준일인 2026-11-02까지 최근 30일 이내."
                    />
                  </View>
                </View>
              </View>
              {!!Object.keys(errors).length && (
                <Notice
                  title="입력값을 확인해 주세요"
                  body={
                    result
                      ? '오류를 고친 후 다시 비교해 주세요. 결과는 마지막으로 적용한 조건이에요.'
                      : '표시된 입력 오류를 고친 후 다시 비교해 주세요.'
                  }
                  tone="error"
                />
              )}
              <View style={[s.actions, wide && s.horizontal]}>
                <Button
                  title="이 조건으로 다시 비교"
                  onPress={() => apply(fromDraft(draft))}
                  icon="refresh-cw"
                />
                <Button title="변경 취소" variant="secondary" onPress={cancelEditing} />
                <Button
                  title="기본 예시로 되돌리기"
                  variant="ghost"
                  onPress={() => apply(createValuationInput(vehicle))}
                />
              </View>
              <Text style={s.small}>
                분석 조건은 이 화면에서만 사용하며, 등록 차량의 주행거리나 기존 백업을 바꾸지
                않아요. 화면을 새로 열면 예시값으로 돌아가요.
              </Text>
            </View>
          )}
        </Card>

        {!result && (
          <Notice
            title="분석할 수 있는 범위를 확인해 주세요"
            body="연식은 2006~2026년, 현재 주행거리는 0~300,000km까지 비교할 수 있어요. 분석 조건을 입력해 주세요."
            tone="warning"
          />
        )}

        {result && active && (
          <>
            <View style={{ gap: 12 }}>
              <SectionTitle title="지금 팔까, 조금 더 탈까?" />
              <Text style={shared.muted}>
                {result.source === 'input-quote'
                  ? '현재는 직접 입력한 견적, 미래는 가정값이에요. 시점을 눌러 예상 지출의 구성을 비교해 보세요.'
                  : '시점을 눌러 예상 지출의 구성을 비교해 보세요. 금액은 모두 합성 가정값이에요.'}
              </Text>
              <View style={s.scenarios}>
                {result.scenarios.map((scenario) => (
                  <Pressable
                    key={scenario.month}
                    testID={`scenario-${scenario.month}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected: selected === scenario.month }}
                    aria-pressed={selected === scenario.month}
                    accessibilityHint="선택하면 아래 비용 내역과 그래프의 비교 시점이 바뀝니다."
                    onPress={() => setSelected(scenario.month)}
                    style={[
                      s.scenario,
                      { width: wide ? '23.8%' : '48%' },
                      selected === scenario.month && s.selectedScenario,
                    ]}
                  >
                    <View style={s.scenarioTop}>
                      <Text style={s.scenarioMonth}>{monthLabel(scenario.month)}</Text>
                      {result.recommendation.month === scenario.month && (
                        <Text style={s.candidateBadge}>검토</Text>
                      )}
                    </View>
                    <Text style={s.small}>{scenario.saleDate.slice(0, 7).replace('-', '.')}</Text>
                    <Text style={s.scenarioPrice}>
                      {format(scenario.valueManwon)}
                      <Text style={s.scenarioUnit}> 만원</Text>
                    </Text>
                    <Text style={s.scenarioRange}>
                      {format(scenario.lowManwon)}~{format(scenario.highManwon)}만원
                    </Text>
                    <View style={s.scenarioDivider} />
                    <Text style={s.small}>추가 보유 비용</Text>
                    <Text style={s.scenarioCost}>{format(scenario.totalCostManwon)}만원</Text>
                    <Text style={[s.eligibility, !scenario.eligible && { color: C.muted }]}>
                      {scenario.eligible ? '입력 조건 충족' : scenario.reasons.join(' · ')}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <Card style={s.breakdown}>
              <Text
                accessibilityRole="header"
                accessibilityLiveRegion="polite"
                style={s.cardTitle}
                testID="scenario-detail-title"
              >
                {monthLabel(selected)} 매도하면, 추가 보유 비용은
              </Text>
              <View style={[s.costEquation, width < 420 && s.stackedEquation]}>
                <View style={[s.costItem, width < 420 && s.stackedCostItem]}>
                  <Text style={s.small}>가치 감소</Text>
                  <Text style={s.costValue}>{format(active.depreciationManwon)}만원</Text>
                </View>
                <Text style={s.symbol}>+</Text>
                <View style={[s.costItem, width < 420 && s.stackedCostItem]}>
                  <Text style={s.small}>유지비 누적</Text>
                  <Text style={s.costValue}>{format(active.upkeepManwon)}만원</Text>
                </View>
                <Text style={s.symbol}>=</Text>
                <View style={[s.costItem, width < 420 && s.stackedCostItem]}>
                  <Text style={s.small}>총 추가 비용</Text>
                  <Text style={[s.costValue, { color: C.primary }]}>
                    {format(active.totalCostManwon)}만원
                  </Text>
                </View>
              </View>
              <Text style={s.small}>
                예상 누적 주행 {format(active.odometerKm)}km · 유지비{' '}
                {format(input.monthlyUpkeepManwon)}만원 × {selected}개월
              </Text>
              <View style={s.marginalCost}>
                <Icon name="clock" color={C.primary} size={17} />
                <Text style={s.marginalText}>
                  6개월 → 12개월 더 타는 비용: 월평균{' '}
                  {(
                    (result.scenarios[2].totalCostManwon - result.scenarios[1].totalCostManwon) /
                    6
                  ).toFixed(1)}
                  만원
                </Text>
              </View>
              <Text style={s.small}>
                매각 수수료·대출 이자·대체 차량 구매비는 제외돼요. 보유 비용만으로 교체의 총 이익을
                판단할 수는 없어요.
              </Text>
            </Card>

            <View style={s.method}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="계산 가정과 데이터 상태"
                accessibilityState={{ expanded: showMethod }}
                aria-expanded={showMethod}
                onPress={() => setShowMethod(!showMethod)}
                style={s.methodButton}
              >
                <Icon name="info" size={17} color={C.muted} />
                <Text style={s.methodTitle}>계산 가정과 데이터 상태</Text>
                <Icon name={showMethod ? 'chevron-up' : 'chevron-down'} color={C.muted} size={17} />
              </Pressable>
              {showMethod && (
                <View style={s.methodBody}>
                  <Text style={s.methodText}>
                    이 오프라인 계산은 학습된 AI나 실거래 가격 예측기가 아니에요. 모든 차량에 같은
                    감가식을 적용하며, 차종·트림·옵션·사고 이력·지역·계절의 실제 효과는 반영하지
                    않아요.
                  </Text>
                  <Text style={s.methodText}>
                    가치 = 가상 기준가 × 0.84^min(차령, 1) × 0.90^max(차령−1, 0) ×
                    exp(−누적km/400,000). 차령 = 2026−연식+경과개월/12. 누적km에는 월 예상 주행량을
                    더해요.
                  </Text>
                  <Text style={s.methodText}>
                    견적 입력 시에는 입력 견적 × (미래 감가식 값 / 현재 감가식 값)으로 계산해요.
                    견적 날짜는 출처 표시와 최근 30일 검증에 사용하며, 견적일부터 기준일까지의 가격
                    변동은 반영하지 않아요.
                  </Text>
                  <Text style={s.methodText}>
                    범위는 기준값의 ±(8%+경과연수×2%)로 임의 설정했어요. 정확도·신뢰수준·시장 변동
                    확률을 의미하지 않아요.
                  </Text>
                  <Text style={s.methodText}>
                    제안은 네 비교 시점 중 보유 기간·누적 비용·목표 가격 조건을 만족하는 마지막
                    시점을 고른 결과예요. 연속적인 최적 매도일이나 수익을 보장하지 않아요. 실제 판매
                    전 이력과 견적을 확인해 주세요.
                  </Text>
                  <View style={s.dataStatus}>
                    <Icon name="cloud-off" color={C.muted} size={16} />
                    <Text style={s.methodText}>
                      이 영역은 합성 규칙을 사용하며 브라우저/기기에서 계산해요. 위의 공매 학습 모델
                      결과와 별개예요.
                    </Text>
                  </View>
                </View>
              )}
            </View>
          </>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  stack: { gap: 20 },
  horizontal: { flexDirection: 'row' },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10,
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: '#E9F5F1',
  },
  statusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.primary },
  statusText: { color: C.primary, fontSize: 11, fontWeight: '700' },
  small: { fontSize: 11, lineHeight: 18, color: C.muted },
  heroRow: { gap: 16, alignItems: 'stretch' },
  valueHero: { backgroundColor: '#163936', borderRadius: 22, padding: 24, overflow: 'hidden' },
  lightLabel: { color: '#B6D8CC', fontSize: 12, fontWeight: '600' },
  heroVehicle: { color: '#FFFFFF', fontSize: 17, fontWeight: '700', marginTop: 18 },
  value: { color: '#FFFFFF', fontSize: 45, fontWeight: '800', letterSpacing: -1.6, marginTop: 7 },
  valueUnit: { fontSize: 17, color: '#D0E8DE', fontWeight: '500', letterSpacing: 0 },
  range: { color: '#BCE9D7', fontSize: 14, marginTop: 9 },
  lightSmall: { color: '#B6D8CC', fontSize: 11, lineHeight: 18, marginTop: 4 },
  heroDivider: { height: 1, backgroundColor: '#3D5A52', marginVertical: 9 },
  heroSummary: { color: '#EDF7F2', fontSize: 12, fontWeight: '500' },
  chartCard: { gap: 9, justifyContent: 'space-between', paddingHorizontal: 18 },
  cardTitle: { color: C.ink, fontSize: 17, fontWeight: '700', lineHeight: 25, letterSpacing: -0.4 },
  chartTag: { backgroundColor: C.mint, borderRadius: 6, padding: 7 },
  tagText: { fontSize: 10, color: C.primary, fontWeight: '600' },
  chartFootnote: { fontSize: 11, lineHeight: 18, color: C.muted, marginTop: 5 },
  conditions: { padding: 20 },
  conditionsHeading: { gap: 16, alignItems: 'stretch' },
  form: { marginTop: 20, paddingTop: 20, borderTopWidth: 1, borderTopColor: C.line, gap: 20 },
  formIntro: { fontSize: 13, lineHeight: 22, color: C.muted },
  fields: { gap: 20 },
  fieldColumn: { flex: 1, gap: 16 },
  quoteFields: { gap: 12, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 18 },
  label: { fontSize: 14, fontWeight: '600', color: C.ink },
  wrap: { flexDirection: 'row', gap: 7, flexWrap: 'wrap' },
  actions: { gap: 10 },
  advice: {
    flexDirection: 'row',
    gap: 16,
    borderRadius: 20,
    padding: 22,
    backgroundColor: '#E4F2EB',
    borderWidth: 1,
    borderColor: '#CCE4D8',
  },
  cautious: { backgroundColor: '#FFF8E9', borderColor: '#EBDFC2' },
  adviceIcon: {
    backgroundColor: '#FFFFFFB3',
    width: 43,
    height: 43,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
  },
  overline: { fontSize: 10, color: C.primary, fontWeight: '700', letterSpacing: 0.7 },
  adviceTitle: {
    color: C.ink,
    fontSize: 21,
    fontWeight: '800',
    lineHeight: 29,
    letterSpacing: -0.7,
  },
  adviceBody: { fontSize: 12, lineHeight: 20, color: C.muted },
  scenarios: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 12,
  },
  scenario: {
    minHeight: 220,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: C.line,
    backgroundColor: '#FFFFFF',
    padding: 15,
    gap: 6,
  },
  selectedScenario: {
    borderColor: C.primary,
    backgroundColor: '#F0F9F5',
    borderWidth: 2,
    padding: 14,
  },
  scenarioTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 4,
    flexWrap: 'wrap',
  },
  scenarioMonth: { fontSize: 14, fontWeight: '700', color: C.ink },
  candidateBadge: {
    fontSize: 9,
    color: '#FFFFFF',
    backgroundColor: C.primary,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
  },
  scenarioPrice: {
    fontSize: 24,
    fontWeight: '800',
    color: C.ink,
    marginTop: 5,
    letterSpacing: -0.8,
  },
  scenarioUnit: { fontSize: 11, fontWeight: '500', letterSpacing: 0 },
  scenarioRange: { fontSize: 10, color: C.muted, lineHeight: 16 },
  scenarioDivider: { height: 1, backgroundColor: C.line, marginVertical: 5 },
  scenarioCost: { fontSize: 16, color: C.ink, fontWeight: '700' },
  eligibility: { fontSize: 10, color: C.primary, lineHeight: 16, marginTop: 5 },
  breakdown: { gap: 16 },
  costEquation: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 4,
  },
  costItem: { flex: 1, gap: 7 },
  stackedEquation: { flexDirection: 'column', alignItems: 'stretch', gap: 10 },
  stackedCostItem: {
    flex: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  marginalCost: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    borderRadius: 10,
    backgroundColor: C.mint,
    padding: 12,
  },
  marginalText: { flex: 1, color: C.primary, fontSize: 12, fontWeight: '600', lineHeight: 20 },
  costValue: { fontSize: 21, fontWeight: '800', color: C.ink, letterSpacing: -0.5 },
  symbol: { color: '#7B918A', fontSize: 18, paddingHorizontal: 3 },
  method: { borderTopWidth: 1, borderBottomWidth: 1, borderColor: C.line },
  methodButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    minHeight: 52,
    paddingVertical: 10,
  },
  methodTitle: { flex: 1, fontSize: 12, color: C.muted, fontWeight: '600' },
  methodBody: { gap: 12, paddingVertical: 15 },
  methodText: { fontSize: 12, lineHeight: 21, color: C.muted, flexShrink: 1 },
  dataStatus: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    backgroundColor: '#EDF1EF',
    borderRadius: 10,
    padding: 13,
  },
});
