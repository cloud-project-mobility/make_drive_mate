import { useState } from 'react';
import { View, Text, StyleSheet, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import { Button, C, Icon, Notice, Screen, shared } from '../components/ui';
import { VehicleArt } from '../components/VehicleArt';
import { useApp } from '../state/AppProvider';
export default function WelcomeScreen() {
  const { dispatch } = useApp();
  const { width } = useWindowDimensions();
  const [error, setError] = useState('');
  function start(demo: boolean) {
    const result = dispatch({ type: 'COMPLETE_ONBOARDING', demo });
    if (!result.ok) return setError(result.error ?? '다시 시도해 주세요.');
    router.replace('/(tabs)');
  }
  return (
    <Screen>
      <View style={s.brand}>
        <View style={s.mark}>
          <Icon name="navigation" color="#fff" size={23} />
        </View>
        <Text style={s.brandText}>
          DriveMate<Text style={{ color: C.primary }}>.</Text>
        </Text>
      </View>
      <View
        style={[s.main, width > 760 && { flexDirection: 'row', alignItems: 'center', gap: 52 }]}
      >
        <View style={{ flex: 1, gap: 24 }}>
          <Text style={s.eyebrow}>KNOW YOUR VALUE. CHOOSE YOUR TIMING.</Text>
          <Text accessibilityRole="header" style={s.hero}>
            내 차의 가치,{'\n'}다음 타이밍을 읽다.
          </Text>
          <Text style={s.description}>
            지금 팔까, 조금 더 탈까?{'\n'}연식·주행거리와 나의 조건을 바꿔 비교해요.
          </Text>
          <View style={s.features}>
            {[
              ['trending-down', '시간에 따른 가치의 흐름', '0·6·12·24개월의 가정 가치를 비교해요.'],
              [
                'sliders',
                '내 기준으로 정하는 매도 조건',
                '보유 기간·비용 한도·목표 가격을 함께 봐요.',
              ],
              ['compass', '이유를 설명하는 시점 제안', '조건이 맞지 않으면 판단을 유보해요.'],
            ].map(([icon, title, body]) => (
              <View key={title} style={shared.row}>
                <View style={s.featureIcon}>
                  <Icon name={icon as 'tool'} color={C.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.featureTitle}>{title}</Text>
                  <Text style={shared.muted}>{body}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>
        <View style={[s.artPanel, width > 760 && { flex: 1 }]}>
          <View style={s.artCircle} />
          <View style={s.artCaption}>
            <View style={s.dot} />
            <Text style={{ color: C.primary, fontWeight: '600', fontSize: 12 }}>
              YOUR NEXT CHAPTER, WITH DRIVEMATE
            </Text>
          </View>
          <VehicleArt type="HYB" style={{ height: 230 }} />
          <Text style={s.artTitle}>A clearer view. A better timing.</Text>
          <Text style={s.artSub}>더 오래 탈지, 다음 차로 갈지</Text>
        </View>
      </View>
      <View style={s.actions}>
        {!!error && <Notice title={error} tone="error" />}
        <Button
          title="내 차량으로 시작하기"
          icon="arrow-right"
          onPress={() => start(false)}
          testID="start-local"
        />
        <Button
          title="예시 차량으로 둘러보기"
          variant="secondary"
          onPress={() => start(true)}
          testID="start-demo"
        />
        <Text style={s.privacy}>
          예시 화면은 합성 데이터·가정 계산입니다.{'\n'}로그인 후 실제 공매 데이터 분석을 이용할
          수 있어요.
        </Text>
        <Text style={s.privacy}>회원가입 없이 시작해요. 차량 기록은 이 기기에 저장됩니다.</Text>
      </View>
    </Screen>
  );
}
const s = StyleSheet.create({
  brand: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingTop: 16, marginBottom: 16 },
  mark: {
    width: 37,
    height: 37,
    borderRadius: 12,
    backgroundColor: C.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  brandText: { color: C.ink, fontWeight: '800', fontSize: 25, letterSpacing: -1 },
  main: { gap: 28 },
  eyebrow: { fontSize: 10, fontWeight: '700', letterSpacing: 2, color: C.primary },
  hero: { color: C.ink, fontSize: 38, lineHeight: 49, fontWeight: '800', letterSpacing: -1.9 },
  description: { color: C.muted, fontSize: 16, lineHeight: 27 },
  features: { gap: 20 },
  featureIcon: {
    width: 42,
    height: 42,
    backgroundColor: C.mint,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  featureTitle: { fontSize: 14, fontWeight: '700', color: C.ink, marginBottom: 3 },
  artPanel: {
    padding: 24,
    borderRadius: 28,
    backgroundColor: '#E5EFEB',
    overflow: 'hidden',
    position: 'relative',
  },
  artCircle: {
    position: 'absolute',
    width: 260,
    height: 260,
    borderRadius: 140,
    backgroundColor: '#D8E7DF',
    top: 45,
    alignSelf: 'center',
  },
  artCaption: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 6, height: 6, backgroundColor: C.primary, borderRadius: 3 },
  artTitle: {
    fontSize: 21,
    fontWeight: '700',
    letterSpacing: -0.5,
    textAlign: 'center',
    color: C.ink,
  },
  artSub: { fontSize: 12, color: C.muted, textAlign: 'center', marginTop: 8 },
  actions: { gap: 12, marginTop: 8, maxWidth: 520, width: '100%', alignSelf: 'center' },
  privacy: { color: C.muted, textAlign: 'center', fontSize: 12, lineHeight: 20 },
});
