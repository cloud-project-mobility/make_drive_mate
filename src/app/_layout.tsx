import React, { Component, ReactNode, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppProvider, useApp } from '../state/AppProvider';
import { BackendProvider } from '../state/BackendProvider';
import { VehicleCatalogProvider } from '../state/VehicleCatalogProvider';
import { TripRecorderProvider, useTripRecorder } from '../services/useTripRecorder';
import { exportRawBackup } from '../services/backup';
import { Button, C, Notice } from '../components/ui';
class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <View style={s.error}>
        <Notice
          title="화면을 불러오지 못했어요."
          body="저장된 기록은 유지됩니다. 화면을 다시 열어 주세요."
          tone="error"
        />
        <Button title="다시 시도" onPress={() => this.setState({ failed: false })} />
      </View>
    ) : (
      this.props.children
    );
  }
}
function RecordingBanner() {
  const insets = useSafeAreaInsets();
  const recorder = useTripRecorder();
  const { state } = useApp();
  if (!recorder.activeTrip) return null;
  const vehicle = state.vehicles.find((v) => v.id === recorder.activeTrip?.vehicleId);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="진행 중인 주행 확인"
      onPress={() => router.push('/route')}
      style={{
        minHeight: 48,
        padding: 12,
        paddingTop: Math.max(12, insets.top),
        backgroundColor: C.mint,
        alignItems: 'center',
      }}
    >
      <Text style={{ fontSize: 13, color: C.primary, fontWeight: '600' }}>
        {vehicle?.name} · {recorder.status === 'recording' ? '기록 중' : '기록 일시 정지'} ·{' '}
        {recorder.distanceKm.toFixed(2)} km →
      </Text>
    </Pressable>
  );
}
function AppShell() {
  const { state, ready, error, recoveryData, retryStorage, discardCorruptData } = useApp();
  const [confirm, setConfirm] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState('');
  useEffect(() => {
    if (Platform.OS === 'web') {
      document.documentElement.lang = 'ko';
      document.title = 'DriveMate · 나의 드라이브 메이트';
    }
  }, []);
  if (!ready)
    return (
      <View style={s.loading}>
        <ActivityIndicator size="large" color={C.primary} />
        <Text style={s.loadingText}>내 차량 기록을 준비하고 있어요</Text>
      </View>
    );
  if (error?.kind === 'load' || error?.kind === 'corrupt')
    return (
      <View style={s.error}>
        <Notice title="저장된 기록을 확인해 주세요." body={error.message} tone="error" />
        <Button
          title="다시 불러오기"
          onPress={() => {
            void retryStorage();
          }}
        />
        {error.kind === 'corrupt' && (
          <>
            {recoveryData !== null && (
              <Button
                title="원본 데이터 내보내기"
                variant="secondary"
                onPress={() => {
                  void exportRawBackup(recoveryData).then((r) =>
                    setRecoveryMessage(
                      r.ok ? '내보내기를 요청했어요. 저장 위치를 확인해 주세요.' : r.error,
                    ),
                  );
                }}
              />
            )}
            {!!recoveryMessage && <Text style={s.loadingText}>{recoveryMessage}</Text>}
            {confirm ? (
              <>
                <Text style={s.loadingText}>
                  원본 데이터는 기기에 백업하고, 새 기록으로 시작합니다.
                </Text>
                <Button
                  title="백업 후 새로 시작"
                  loading={recovering}
                  onPress={() => {
                    setRecovering(true);
                    void discardCorruptData().finally(() => setRecovering(false));
                  }}
                />
                <Button title="취소" variant="ghost" onPress={() => setConfirm(false)} />
              </>
            ) : (
              <Button
                title="손상 데이터 복구 안내"
                variant="secondary"
                onPress={() => setConfirm(true)}
              />
            )}
          </>
        )}
      </View>
    );
  return (
    <TripRecorderProvider>
      <RecordingBanner />
      <StatusBar style="dark" />
      {error?.kind === 'save' && (
        <View style={s.saveError}>
          <Notice title="저장하지 못한 변경사항이 있어요" body={error.message} tone="error" />
          <Button
            title="저장 다시 시도"
            variant="secondary"
            onPress={() => {
              void retryStorage();
            }}
          />
        </View>
      )}
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: C.bg },
          animation: 'slide_from_right',
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Protected guard={!state.onboarded}>
          <Stack.Screen name="welcome" />
        </Stack.Protected>
        <Stack.Protected guard={state.onboarded}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="vehicle" />
          <Stack.Screen name="maintenance" />
          <Stack.Screen name="plan" />
          <Stack.Screen name="route" />
          <Stack.Screen name="notifications" />
        </Stack.Protected>
      </Stack>
    </TripRecorderProvider>
  );
}
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AppErrorBoundary>
        <AppProvider>
          <BackendProvider>
            <VehicleCatalogProvider>
              <AppShell />
            </VehicleCatalogProvider>
          </BackendProvider>
        </AppProvider>
      </AppErrorBoundary>
    </SafeAreaProvider>
  );
}
const s = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
    backgroundColor: C.bg,
  },
  loadingText: { color: C.muted, fontSize: 14, lineHeight: 23 },
  error: {
    flex: 1,
    backgroundColor: C.bg,
    justifyContent: 'center',
    padding: 30,
    gap: 16,
    maxWidth: 650,
    width: '100%',
    alignSelf: 'center',
  },
  saveError: { padding: 12, gap: 8, backgroundColor: C.bg },
});
