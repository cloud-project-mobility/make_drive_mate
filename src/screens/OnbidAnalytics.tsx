import { useState } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Button, C, Card, Chip, Notice, SectionTitle, shared } from '../components/ui';
import { backendMessage } from '../services/backend';
import { loadOnbidAnalytics, type OnbidAnalytics as Analytics } from '../services/onbidAnalytics';
import { useBackend } from '../state/BackendProvider';

const format = (value: number, digits = 0) =>
  value.toLocaleString('ko-KR', { maximumFractionDigits: digits });
const modelNames: Record<string, string> = {
  median: '전체 중앙값',
  model_age_median: '차종·차령 중앙값',
  extra_trees_log: 'Extra Trees',
  random_forest_log: 'Random Forest',
};
const nameModel = (name: string) => modelNames[name] ?? name;

function Bars({
  title,
  description,
  rows,
  unit = '건',
  decimals = 0,
}: {
  title: string;
  description: string;
  rows: { label: string; value: number }[];
  unit?: string;
  decimals?: number;
}) {
  const maximum = Math.max(1, ...rows.map((row) => row.value));
  return (
    <Card style={s.chart}>
      <Text accessibilityRole="header" style={s.title}>
        {title}
      </Text>
      <Text style={shared.muted}>{description}</Text>
      {rows.length ? (
        rows.map((row, index) => (
          <View
            key={`${row.label}:${index}`}
            style={s.barRow}
            accessible
            accessibilityLabel={`${row.label}, ${format(row.value, decimals)}${unit}`}
          >
            <View style={s.barHeading}>
              <Text style={s.barLabel}>{row.label}</Text>
              <Text style={s.barValue}>
                {format(row.value, decimals)}
                {unit}
              </Text>
            </View>
            <View style={s.barTrack} accessible={false}>
              <View style={[s.bar, { width: `${(row.value / maximum) * 100}%` }]} />
            </View>
          </View>
        ))
      ) : (
        <Text style={shared.muted}>표시할 집계가 없어요.</Text>
      )}
    </Card>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <View style={s.metric}>
      <Text style={shared.muted}>{label}</Text>
      <Text style={s.metricValue}>{value}</Text>
      <Text style={s.detail}>{detail}</Text>
    </View>
  );
}

function AnalyticsContent() {
  const { client, session, isCurrentClient } = useBackend();
  const wide = useWindowDimensions().width >= 820;
  const [data, setData] = useState<Analytics | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function refresh() {
    if (!session || busy) return;
    setBusy(true);
    setError('');
    setData(null);
    try {
      const result = await loadOnbidAnalytics(client);
      if (isCurrentClient(client)) setData(result);
    } catch (cause) {
      if (isCurrentClient(client)) setError(backendMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const support = data?.model.service_support_audit;
  return (
    <View style={shared.stack} testID="onbid-analytics">
      <Card style={s.intro}>
        <SectionTitle title="실제 데이터로 확인한 분석 과정" />
        <Text style={shared.muted}>
          공매 낙찰 데이터를 수집하고 정제한 뒤, 별도 시험 자료에서 모델을 평가한 결과예요. 소비자
          시세와 내 차량의 판매가격을 검증한 결과는 아니에요.
        </Text>
        <View style={s.steps}>
          {['수집', '원본 저장', '전처리', '모델 비교', '결과 시각화'].map((step, index) => (
            <View style={s.step} key={step}>
              <Text style={s.stepNumber}>{index + 1}</Text>
              <Text style={s.stepText}>{step}</Text>
            </View>
          ))}
        </View>
        <Button
          title={data ? '최신 분석 결과 다시 조회' : '완료된 분석 결과 조회'}
          onPress={refresh}
          loading={busy}
          disabled={!session}
          variant="secondary"
          icon="bar-chart-2"
          testID="load-onbid-analytics"
        />
        {!session && (
          <Text style={shared.muted}>설정에서 서버에 로그인하면 분석 결과를 조회할 수 있어요.</Text>
        )}
        <Text style={s.detail}>
          조회 버튼은 저장된 결과를 읽어요. 데이터 재수집이나 모델 교체를 실행하지 않아요.
        </Text>
      </Card>
      {error ? <Notice title="분석 결과를 불러오지 못했어요" body={error} tone="error" /> : null}
      {data && support && (
        <>
          <View style={s.status}>
            <Chip label="실제 공매 데이터 · 실험 평가" selected />
            <Text style={shared.muted}>
              {data.source.date_start} ~ {data.source.date_end}
            </Text>
          </View>
          <Text style={s.detail}>
            결과 생성: {new Date(data.generated_at).toLocaleString('ko-KR')} ·{' '}
            {data.source.mode === 'reuse' ? '저장된 원본으로 재분석' : 'API에서 새로 수집'}
          </Text>
          <View style={s.metrics}>
            <Metric
              label="수집된 원본"
              value={`${format(data.quality.raw_rows)}건`}
              detail="모든 자동차 범주"
            />
            <Metric
              label="정제 후 승용차"
              value={`${format(data.quality.clean_rows)}건`}
              detail={`승용차 범주의 ${format(data.quality.usable_percent_of_passenger, 1)}%`}
            />
            <Metric
              label="제외·검토 대기"
              value={`${format(data.quality.excluded_rows)}건`}
              detail="다른 차종·필수 값·매각 단위 검토"
            />
            <Metric
              label="반복 차량 그룹"
              value={`${format(data.quality.repeated_vehicle_groups)}개`}
              detail="훈련·시험 중복을 따로 통제"
            />
          </View>
          <Notice
            title="한 대 가격인지 먼저 확인했어요"
            body="폐차·고철·점검용, 여러 대 묶음 또는 가격 단위가 불명확한 물건은 모델 입력에서 제외해요. 제조사·연료 등 모르는 값은 임의로 채우지 않아요."
          />
          <Card style={shared.stack}>
            <SectionTitle title="모델이 설명할 수 있는 범위" />
            <Text style={shared.text}>
              검증 자료로 선택한 모델: {nameModel(data.model.selected_model)}
            </Text>
            <View style={s.metrics}>
              <Metric
                label="전체 시험 자료 평균 오차"
                value={`${format(data.model.test_metrics.mae_manwon, 1)}만원`}
                detail={`${format(data.model.test_metrics.rows)}건 전체 평가`}
              />
              <Metric
                label="제공 조건에 맞는 자료 평균 오차"
                value={
                  support.supported_test_metrics
                    ? `${format(support.supported_test_metrics.mae_manwon, 1)}만원`
                    : '평가 자료 없음'
                }
                detail={`${format(support.supported_rows)}건에 한정한 결과`}
              />
              <Metric
                label="가격 제시 가능 비율"
                value={`${format(support.supported_percent, 1)}%`}
                detail={`${format(support.deferred_rows)}건은 자료 부족 등으로 보류`}
              />
            </View>
            <Text style={shared.muted}>
              평균 절대오차는 실제 낙찰가와 예측값의 차이를 평균한 값이에요. 제공 가능한 자료만의
              오차는 전체 성능과 함께 봐야 하며, 내 차량 한 대의 오차를 보장하지 않아요.
            </Text>
            <Text style={s.detail}>
              훈련 {format(data.model.split_counts.train)} · 검증{' '}
              {format(data.model.split_counts.validation)} · 범위 보정{' '}
              {format(data.model.split_counts.calibration)} · 시험{' '}
              {format(data.model.split_counts.test)}건
            </Text>
          </Card>
          <View style={[s.charts, wide && s.horizontal]}>
            <Bars
              title="모델별 검증 오차"
              description="별도 검증 자료의 평균 절대오차. 막대가 짧을수록 오차가 작아요."
              unit="만원"
              decimals={1}
              rows={data.charts.model_comparison.map((row) => ({
                label: nameModel(row.label),
                value: row.mae_manwon,
              }))}
            />
            <Bars
              title="누락된 차량 정보"
              description="승용차 범주에서 값이 없는 비율이에요."
              unit="%"
              decimals={1}
              rows={Object.entries(data.quality.missing_rates).map(([label, value]) => ({
                label:
                  (
                    {
                      make: '제조사',
                      model: '모델',
                      model_year: '연식',
                      odometer_km: '주행거리',
                      fuel: '연료',
                      displacement_cc: '배기량',
                      price_krw: '낙찰가',
                      event_date: '개찰일',
                    } as Record<string, string>
                  )[label] ?? label,
                value,
              }))}
            />
          </View>
          <View style={[s.charts, wide && s.horizontal]}>
            <Bars
              title="많이 관측된 모델"
              description="상위 8개 모델. 일부 차종에 자료가 집중될 수 있어요."
              rows={data.charts.top_models
                .slice(0, 8)
                .map((row) => ({ label: row.label, value: row.count }))}
            />
            <Bars
              title="월별 관측 건수"
              description="수집 기간의 낙찰 관측 분포예요."
              rows={data.charts.monthly_counts.map((row) => ({
                label: row.label,
                value: row.count,
              }))}
            />
          </View>
          <Bars
            title="낙찰가격 분포"
            description="정제된 공매 표본의 가격 분포이며 일반 중고차 시장 분포와 달라요."
            rows={data.charts.price_histogram.map((row) => ({
              label: row.label,
              value: row.count,
            }))}
          />
          <Notice
            title="실험 결과의 사용 범위"
            body="사고·정비·트림 정보가 없고 모델별 세대 구분도 제한돼요. 차령과 주행거리를 바꾼 비교는 시장 조건을 고정한 시나리오이며 실제 미래 시세를 보장하지 않아요."
            tone="warning"
          />
        </>
      )}
    </View>
  );
}

export default function OnbidAnalytics() {
  const { url, session } = useBackend();
  return (
    <AnalyticsContent
      key={`${url}:${session?.user.id ?? 'anonymous'}:${session?.expires_at ?? ''}`}
    />
  );
}

const s = StyleSheet.create({
  intro: { gap: 16 },
  status: { gap: 8, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  steps: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingRight: 8 },
  stepNumber: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: C.mint,
    textAlign: 'center',
    lineHeight: 22,
    color: C.primary,
    fontSize: 12,
    fontWeight: '700',
  },
  stepText: { color: C.ink, fontSize: 12 },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  metric: {
    flexGrow: 1,
    flexBasis: 180,
    minWidth: 0,
    padding: 16,
    borderRadius: 16,
    backgroundColor: C.mint,
    gap: 6,
  },
  metricValue: { color: C.ink, fontWeight: '800', fontSize: 25, lineHeight: 33 },
  detail: { color: C.muted, fontSize: 12, lineHeight: 19 },
  charts: { gap: 16 },
  horizontal: { flexDirection: 'row', alignItems: 'stretch' },
  chart: { flex: 1, minWidth: 0, gap: 12 },
  title: { color: C.ink, fontSize: 17, fontWeight: '700' },
  barRow: { gap: 7 },
  barHeading: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    alignItems: 'baseline',
  },
  barLabel: { color: C.ink, fontSize: 13, lineHeight: 19, flex: 1 },
  barValue: { color: C.muted, fontSize: 12, lineHeight: 19, textAlign: 'right' },
  barTrack: {
    height: 9,
    width: '100%',
    borderRadius: 5,
    backgroundColor: C.line,
    overflow: 'hidden',
  },
  bar: { height: 9, backgroundColor: C.primary, borderRadius: 5 },
});
