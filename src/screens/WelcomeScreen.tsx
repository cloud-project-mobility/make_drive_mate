import { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { Button, C, Card, Icon, Notice, Screen, shared } from '../components/ui';
import { useApp } from '../state/AppProvider';
import { useBackend } from '../state/BackendProvider';

export default function WelcomeScreen() {
  const { dispatch } = useApp();
  const { session } = useBackend();
  const [error, setError] = useState('');
  function startLocal(demo: boolean) {
    const result = dispatch({ type: 'COMPLETE_ONBOARDING', demo });
    if (!result.ok) return setError(result.error ?? '다시 시도해 주세요.');
    router.replace('/(tabs)');
  }
  function startAccount() {
    if (!session) {
      router.push('/settings?onboarding=1&mode=register');
      return;
    }
    const result = dispatch({ type: 'COMPLETE_ONBOARDING', demo: false });
    if (!result.ok) return setError(result.error ?? '다시 시도해 주세요.');
    router.replace('/vehicle?onboarding=1');
  }
  return (
    <Screen>
      <View style={s.content}>
        <View style={shared.row}>
          <Icon name="navigation" color={C.primary} size={26} />
          <Text style={s.brand}>DriveMate</Text>
        </View>
        <View style={{ gap: 10 }}>
          <Text accessibilityRole="header" style={s.title}>
            내 차 등록부터 시작해요
          </Text>
          <Text style={shared.muted}>
            계정을 만들고 차량 정보를 등록하면 내 차 관리와 분석을 시작할 수 있어요.
          </Text>
        </View>
        <Card style={{ gap: 20 }}>
          <View style={s.steps}>
            <Text style={s.currentStep}>1 계정 만들기</Text>
            <Icon name="chevron-right" size={16} color={C.muted} />
            <Text style={shared.muted}>2 차량 등록</Text>
          </View>
          <Button
            title={session ? '차량 등록 계속하기' : '계정 만들기'}
            icon="arrow-right"
            testID="start-account"
            onPress={startAccount}
          />
          {!session && (
            <Button
              title="이미 계정이 있어요"
              variant="secondary"
              onPress={() => router.push('/settings?onboarding=1&mode=login')}
            />
          )}
        </Card>
        {!!error && <Notice title={error} tone="error" />}
        <View style={{ gap: 4 }}>
          <Button
            title="예시 차량으로 둘러보기"
            variant="ghost"
            onPress={() => startLocal(true)}
            testID="start-demo"
          />
          <Button
            title="내 차량으로 시작하기"
            variant="ghost"
            onPress={() => startLocal(false)}
            testID="start-local"
          />
          <Text style={s.localNote}>
            계정 없이 둘러보면 기록은 이 기기에만 저장돼요. 예시 차량은 실제 내 차량 정보가
            아니에요.
          </Text>
        </View>
      </View>
    </Screen>
  );
}

const s = StyleSheet.create({
  content: { width: '100%', maxWidth: 520, alignSelf: 'center', gap: 28, paddingVertical: 24 },
  brand: { color: C.ink, fontWeight: '800', fontSize: 24 },
  title: { color: C.ink, fontSize: 28, lineHeight: 38, fontWeight: '700' },
  steps: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 },
  currentStep: { color: C.primary, fontSize: 14, fontWeight: '700' },
  localNote: { color: C.muted, fontSize: 12, lineHeight: 20, textAlign: 'center' },
});
