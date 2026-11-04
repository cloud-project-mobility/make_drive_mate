import { View, Text, StyleSheet } from 'react-native';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';
import { C } from './ui';
import type { ValuationMonth, ValuationScenario } from '../domain/valuation';

export function ValuationChart({
  scenarios,
  selected,
  quoteAnchored = false,
}: {
  scenarios: ValuationScenario[];
  selected: ValuationMonth;
  quoteAnchored?: boolean;
}) {
  const width = 480;
  const height = 252;
  const top = 25;
  const bottom = 205;
  const left = 56;
  const right = 452;
  const ceiling = Math.ceil((Math.max(...scenarios.map((s) => s.highManwon)) * 1.08) / 500) * 500;
  const x = (month: number) => left + (month / 24) * (right - left);
  const y = (value: number) => bottom - (value / ceiling) * (bottom - top);
  const line = scenarios
    .map((s, i) => `${i ? 'L' : 'M'}${x(s.month)},${y(s.valueManwon)}`)
    .join(' ');
  const band = [
    ...scenarios.map((s, i) => `${i ? 'L' : 'M'}${x(s.month)},${y(s.highManwon)}`),
    ...[...scenarios].reverse().map((s) => `L${x(s.month)},${y(s.lowManwon)}`),
    'Z',
  ].join(' ');
  const active = scenarios.find((s) => s.month === selected)!;
  const description = scenarios
    .map((s) => `${s.month}개월 ${Math.round(s.valueManwon)}만원`)
    .join(', ');
  return (
    <View>
      <Svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        accessibilityRole="image"
        accessibilityLabel={`${quoteAnchored ? '입력 견적 기준' : '합성'} 가치 변화 그래프. ${description}. 색칠 영역은 가정 변화 범위이며 통계적 신뢰구간이 아닙니다.`}
      >
        {[0, 0.5, 1].map((fraction) => (
          <Line
            key={`line-${fraction}`}
            x1={left}
            x2={right}
            y1={y(ceiling * fraction)}
            y2={y(ceiling * fraction)}
            stroke="#E0E8E5"
            strokeDasharray="4 5"
          />
        ))}
        {[0, 0.5, 1].map((fraction) => (
          <SvgText
            key={`axis-${fraction}`}
            x={left - 10}
            y={y(ceiling * fraction) + 5}
            textAnchor="end"
            fontSize={13}
            fill={C.muted}
          >
            {Math.round(ceiling * fraction).toLocaleString('ko-KR')}
          </SvgText>
        ))}
        <Path d={band} fill="#D2ECE3" />
        <Line
          x1={x(active.month)}
          x2={x(active.month)}
          y1={top}
          y2={bottom}
          stroke="#81A99E"
          strokeDasharray="4 4"
        />
        <Path d={line} fill="none" stroke={C.primary} strokeWidth={3} strokeLinejoin="round" />
        {scenarios.map((scenario) => (
          <Circle
            key={`point-${scenario.month}`}
            cx={x(scenario.month)}
            cy={y(scenario.valueManwon)}
            r={scenario.month === selected ? 6 : 4}
            fill={scenario.month === selected ? C.primary : '#fff'}
            stroke={C.primary}
            strokeWidth={2}
          />
        ))}
        {scenarios.map((scenario) => (
          <SvgText
            key={`label-${scenario.month}`}
            x={x(scenario.month)}
            y={bottom + 28}
            textAnchor="middle"
            fontSize={14}
            fontWeight={scenario.month === selected ? '700' : '400'}
            fill={scenario.month === selected ? C.primary : C.muted}
          >
            {scenario.month === 0 ? '지금' : `${scenario.month}개월`}
          </SvgText>
        ))}
        <SvgText x={left} y={14} fontSize={12} fill={C.muted}>
          단위: 만원
        </SvgText>
      </Svg>
      <View style={s.legend}>
        <View style={s.key}>
          <View style={s.line} />
          <Text style={s.text}>{quoteAnchored ? '견적 기준 가정값' : '합성 기준값'}</Text>
        </View>
        <View style={s.key}>
          <View style={s.area} />
          <Text style={s.text}>가정 변화 범위</Text>
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  legend: { flexDirection: 'row', justifyContent: 'center', gap: 18, flexWrap: 'wrap' },
  key: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  line: { width: 18, height: 3, borderRadius: 2, backgroundColor: C.primary },
  area: { width: 18, height: 10, borderRadius: 2, backgroundColor: '#D2ECE3' },
  text: { fontSize: 11, color: C.muted },
});
