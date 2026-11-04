import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button, C, Card, Field, Notice, shared } from '../components/ui';
import type { Vehicle } from '../domain/types';
import { requestAuction, type AuctionResult } from '../services/onbidValuation';
import { useBackend } from '../state/BackendProvider';

const money = (won: number) => (won / 10_000).toLocaleString('ko-KR', { maximumFractionDigits: 1 });
function ValuationContent({ vehicle }: { vehicle: Vehicle }) {
  const { client, session, isCurrentClient } = useBackend();
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState(vehicle.model.match(/(?:19|20)\d{2}/g)?.at(-1) ?? '');
  const [mileage, setMileage] = useState(String(vehicle.odometerKm));
  const [fuel, setFuel] = useState('');
  const [category, setCategory] = useState('승용차');
  const [engine, setEngine] = useState('');
  const [monthlyKm, setMonthlyKm] = useState('1000');
  const [upkeep, setUpkeep] = useState('15');
  const [result, setResult] = useState<AuctionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const sequence = useRef(0);
  useEffect(() => {
    return () => {
      sequence.current += 1;
    };
  }, []);
  async function analyze(useLlm: boolean) {
    const numeric = (value: string) =>
      /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : Number.NaN;
    const modelYear = numeric(year);
    const distance = numeric(mileage);
    const monthly = numeric(monthlyKm);
    const cost = numeric(upkeep);
    const cc = engine.trim() ? numeric(engine) : null;
    if (
      !model.trim() ||
      !Number.isInteger(modelYear) ||
      modelYear < 1970 ||
      modelYear > new Date().getFullYear() ||
      !Number.isFinite(distance) ||
      distance < 0 ||
      distance > 2_000_000 ||
      !Number.isFinite(monthly) ||
      monthly > 100_000 ||
      !Number.isFinite(cost) ||
      cost > 10_000 ||
      (cc !== null && (!Number.isFinite(cc) || cc > 30_000))
    ) {
      setError('차종, 실제 연식, 주행거리와 비용을 확인해 주세요.');
      return;
    }
    const current = ++sequence.current;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const next = await requestAuction(client, {
        vehicle: {
          make: make.trim() || null,
          model: model.trim(),
          fuel: fuel.trim() || null,
          vehicle_category: category.trim() || null,
          age_years: new Date().getFullYear() - modelYear,
          odometer_km: distance,
          engine_cc: cc,
        },
        monthly_km: monthly,
        months: [0, 6, 12],
        monthly_upkeep_krw: Math.round(cost * 10_000),
        use_llm: useLlm,
      });
      if (sequence.current === current && isCurrentClient(client)) setResult(next);
    } catch (cause) {
      if (sequence.current === current && isCurrentClient(client))
        setError(cause instanceof Error ? cause.message : '분석 요청을 처리하지 못했어요.');
    } finally {
      if (sequence.current === current) setBusy(false);
    }
  }
  return (
    <Card style={s.card}>
      <Text accessibilityRole="header" style={s.title}>
        공매 데이터로 차량 분석
      </Text>
      <Text style={shared.muted}>
        온비드 실제 낙찰 자료로 현재 조건과 6·12개월 보유 조건을 비교해요. 소비자 시세와는 다르며,
        미래 시장 가격을 보장하지 않아요.
      </Text>
      {!session ? (
        <Notice
          title="서버 로그인 후 사용할 수 있어요"
          body="설정에서 서버에 로그인하면 학습 모델과 근거 설명을 사용할 수 있어요."
        />
      ) : (
        <Button
          title={showForm ? '차량 분석 입력 접기' : '공매 차량 분석 열기'}
          variant="secondary"
          onPress={() => setShowForm(!showForm)}
        />
      )}
      {session && showForm && (
        <View style={s.stack}>
          <Text style={shared.muted}>
            등록 정보: {vehicle.model}. 제조사·차종·연료는 실제 차량 정보를 확인해 입력해 주세요.
            이름이 학습 자료와 다르면 분석을 보류할 수 있어요.
          </Text>
          <View style={s.fields}>
            <View style={s.column}>
              <Field
                label="공매 분석 제조사 (선택)"
                value={make}
                onChangeText={setMake}
                placeholder="현대"
              />
              <Field
                label="공매 분석 차종"
                value={model}
                onChangeText={setModel}
                placeholder="아반떼"
              />
              <Field
                label="공매 분석 연식"
                value={year}
                onChangeText={setYear}
                keyboardType="numeric"
              />
              <Field
                label="공매 분석 주행거리 (km)"
                value={mileage}
                onChangeText={setMileage}
                keyboardType="numeric"
              />
            </View>
            <View style={s.column}>
              <Field
                label="연료 (선택)"
                value={fuel}
                onChangeText={setFuel}
                placeholder="휘발유 / 경유 / LPG"
              />
              <Field
                label="차량 분류"
                value={category}
                onChangeText={setCategory}
                placeholder="승용차 / SUV / 경차"
              />
              <Field
                label="배기량 (cc, 선택)"
                value={engine}
                onChangeText={setEngine}
                keyboardType="numeric"
              />
              <Field
                label="공매 분석 월 주행거리 (km)"
                value={monthlyKm}
                onChangeText={setMonthlyKm}
                keyboardType="numeric"
              />
              <Field
                label="공매 분석 월 유지비 (만원)"
                value={upkeep}
                onChangeText={setUpkeep}
                keyboardType="numeric"
              />
            </View>
          </View>
          <Button title="학습 모델로 비교" loading={busy} onPress={() => void analyze(false)} />
          <Button
            title="GPT 근거 설명과 함께 비교"
            variant="secondary"
            disabled={busy}
            onPress={() => void analyze(true)}
          />
          <Text style={shared.muted}>
            GPT는 검증된 가격·사례·한계 중 설명할 근거를 선택해요. 새 가격을 만들지 않으며, 이
            버튼은 API 사용료가 발생해요.
          </Text>
        </View>
      )}
      {!!error && <Notice title="분석을 완료하지 못했어요" body={error} tone="error" />}
      {result && (
        <View style={s.stack} testID="onbid-result">
          <Text style={s.title}>
            {result.evidence.status === 'deferred'
              ? '근거가 부족해 가격 제시를 보류해요'
              : `예상 공매 낙찰가 ${money(result.evidence.prediction_krw!)}만원`}
          </Text>
          {result.evidence.status !== 'deferred' && (
            <Text style={shared.muted}>
              참고 범위 {money(result.evidence.interval_low_krw!)} ~{' '}
              {money(result.evidence.interval_high_krw!)}만원
            </Text>
          )}
          <Text style={shared.muted}>
            전체 시험 평균 오차 {money(result.evidence.test_mae_krw)}만원 · 참고 구간 포함률{' '}
            {result.evidence.test_interval_coverage_pct.toFixed(1)}%
          </Text>
          {result.evidence.scenarios.map((scenario) => (
            <View key={scenario.months} style={s.scenario}>
              <Text style={s.label}>
                {scenario.months === 0 ? '현재 조건' : `${scenario.months}개월 보유 가정`}
              </Text>
              <Text style={s.label}>
                {scenario.prediction_krw === undefined
                  ? '범위를 벗어나 보류'
                  : `${money(scenario.prediction_krw)}만원`}
              </Text>
              {scenario.assumed_combined_cost_krw !== undefined && (
                <Text style={shared.muted}>
                  가정 감가 + 유지비 {money(scenario.assumed_combined_cost_krw)}만원
                </Text>
              )}
            </View>
          ))}
          <Text style={s.label}>
            {result.explanation.mode === 'llm_selected_verified_facts'
              ? 'GPT가 선택한 근거 설명'
              : '검증된 근거 요약'}
          </Text>
          <Text style={s.explanation}>{result.explanation.text}</Text>
          {result.evidence.warnings.map((warning) => (
            <Text key={warning} style={shared.muted}>
              {warning}
            </Text>
          ))}
        </View>
      )}
    </Card>
  );
}
export default function OnbidValuation({ vehicle }: { vehicle: Vehicle }) {
  const { url, session } = useBackend();
  return (
    <ValuationContent
      key={`${url}:${session?.user.id ?? 'anonymous'}:${session?.expires_at ?? ''}:${vehicle.id}`}
      vehicle={vehicle}
    />
  );
}
const s = StyleSheet.create({
  card: { gap: 14 },
  stack: { gap: 12 },
  title: { color: C.ink, fontSize: 20, fontWeight: '800' },
  fields: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  column: { flex: 1, minWidth: 220, gap: 12 },
  label: { color: C.ink, fontSize: 15, fontWeight: '700' },
  explanation: { color: C.ink, fontSize: 14, lineHeight: 23 },
  scenario: { borderColor: C.line, borderWidth: 1, padding: 14, borderRadius: 12, gap: 6 },
});
