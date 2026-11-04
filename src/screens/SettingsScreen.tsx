import React, { useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import {
  Button,
  C,
  Chip,
  Field,
  Icon,
  Notice,
  Screen,
  SectionTitle,
  shared,
} from '../components/ui';
import { useApp } from '../state/AppProvider';
import { parseNonNegativeNumber } from '../domain/helpers';
import { useTripRecorder } from '../services/useTripRecorder';
import { cancelAllDepartures } from '../services/notifications';
import { replaceAfterPreparation } from '../services/stateReplacement';
import { useMounted } from '../services/useMounted';
import BackupSettings from './BackupSettings';
import BackendSettings from './BackendSettings';
import { useBackend } from '../state/BackendProvider';
import { SettingsDisclosure } from '../components/SettingsDisclosure';

export default function SettingsScreen() {
  const { state, dispatch } = useApp();
  const { session } = useBackend();
  const params = useLocalSearchParams<{ onboarding?: string; mode?: string }>();
  const onboarding = params.onboarding === '1';
  const initialMode = params.mode === 'register' ? 'register' : 'login';
  const [showDeviceSettings, setShowDeviceSettings] = useState(false);
  const recorder = useTripRecorder();
  const isMounted = useMounted();
  const [walk, setWalk] = useState(String(state.settings.walkMinutes));
  const [buffer, setBuffer] = useState(String(state.settings.bufferMinutes));
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const dirty =
    walk !== String(state.settings.walkMinutes) || buffer !== String(state.settings.bufferMinutes);
  function save() {
    setMessage(null);
    setError(null);
    const walkValue = parseNonNegativeNumber(walk, '도보 시간', 180);
    const bufferValue = parseNonNegativeNumber(buffer, '여유 시간', 180);
    if (!walkValue.ok) {
      setError(walkValue.error);
      return;
    }
    if (!bufferValue.ok) {
      setError(bufferValue.error);
      return;
    }
    if (!Number.isInteger(walkValue.value) || !Number.isInteger(bufferValue.value)) {
      setError('시간은 0~180 사이의 분 단위 정수로 입력해 주세요.');
      return;
    }
    const result = dispatch({
      type: 'UPDATE_SETTINGS',
      settings: { walkMinutes: walkValue.value, bufferMinutes: bufferValue.value },
    });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setWalk(String(walkValue.value));
    setBuffer(String(bufferValue.value));
    setMessage('기본 시간을 저장했어요. 새로 만드는 이동 계획에 적용해요.');
  }
  async function reset() {
    if (resetting) return;
    if (recorder.status === 'requesting') {
      setError('위치 권한 요청이 끝난 뒤 초기화해 주세요.');
      return;
    }
    if (recorder.activeTrip) {
      setError('진행 중인 주행을 먼저 저장하거나 취소해 주세요.');
      return;
    }
    setResetting(true);
    setError(null);
    try {
      const result = await replaceAfterPreparation(
        cancelAllDepartures,
        () => isMounted() && !recorder.isBusy(),
        () => dispatch({ type: 'RESET_DATA' }, { expectedState: state }),
      );
      if (!isMounted()) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.replace('/');
    } catch {
      setError('예약한 알림을 해제하지 못해 초기화를 멈췄어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setResetting(false);
    }
  }
  function onAuthenticated(mode: 'register' | 'login') {
    setShowDeviceSettings(false);
    setConfirmReset(false);
    if (!state.onboarded) {
      const result = dispatch({ type: 'COMPLETE_ONBOARDING', demo: false });
      if (!result.ok) {
        setError(result.error);
        return;
      }
    }
    if (onboarding || (mode === 'register' && state.vehicles.length === 0))
      router.replace('/vehicle?onboarding=1');
  }
  function onRestored(settings: { walkMinutes: number; bufferMinutes: number }) {
    setWalk(String(settings.walkMinutes));
    setBuffer(String(settings.bufferMinutes));
    setMessage(null);
    setError(null);
  }
  return (
    <Screen back title={onboarding ? '시작하기' : '내 계정'}>
      <View style={s.content}>
        {onboarding && (
          <View style={s.steps}>
            <Text style={s.activeStep}>1 계정</Text>
            <Icon name="chevron-right" size={16} color={C.muted} />
            <Text style={shared.muted}>2 차량 등록</Text>
          </View>
        )}
        {message && <Notice title="저장 완료" body={message} />}
        {error && <Notice title={error} tone="error" />}
        <BackendSettings
          key={String(onboarding) + ':' + initialMode}
          initialMode={initialMode}
          onAuthenticated={onAuthenticated}
          onSignedOut={() => {
            setShowDeviceSettings(false);
            setConfirmReset(false);
          }}
          onRestored={onRestored}
        />
        {!session && state.onboarded && !onboarding && (
          <Button
            title={showDeviceSettings ? '기기 설정 닫기' : '기기 설정 보기'}
            variant="ghost"
            onPress={() => setShowDeviceSettings(!showDeviceSettings)}
          />
        )}
        {!onboarding && (session || showDeviceSettings) && (
          <View key={session?.user.id ?? 'local'} style={shared.stack}>
            <SettingsDisclosure
              title="운전·알림 설정"
              description="출발 시간, 알림, 위치 사용 안내"
            >
              <View style={shared.stack}>
                <SectionTitle title="출발 계획 기본값" />
                <Text style={shared.muted}>
                  새 이동 계획에 적용해요. 기존 계획은 바뀌지 않아요.
                </Text>
                <Field
                  label="여유 시간 (분)"
                  value={buffer}
                  onChangeText={(value) => {
                    setBuffer(value);
                    setMessage(null);
                  }}
                  keyboardType="number-pad"
                  maxLength={3}
                  hint="0~180분"
                  testID="settings-buffer"
                />
                <View style={s.chips}>
                  {[0, 5, 10, 15, 30].map((value) => (
                    <Chip
                      key={value}
                      label={'여유 ' + value + '분'}
                      selected={buffer === String(value)}
                      onPress={() => {
                        setBuffer(String(value));
                        setMessage(null);
                      }}
                    />
                  ))}
                </View>
                <Field
                  label="도보 시간 (분)"
                  value={walk}
                  onChangeText={(value) => {
                    setWalk(value);
                    setMessage(null);
                  }}
                  keyboardType="number-pad"
                  maxLength={3}
                  hint="주차 후 목적지까지 걸어가는 시간 · 0~180분"
                  testID="settings-walk"
                />
                <View style={s.chips}>
                  {[0, 5, 10, 15, 30].map((value) => (
                    <Chip
                      key={value}
                      label={'도보 ' + value + '분'}
                      selected={walk === String(value)}
                      onPress={() => {
                        setWalk(String(value));
                        setMessage(null);
                      }}
                    />
                  ))}
                </View>
                <Button
                  title="기본 시간 저장"
                  icon="check"
                  onPress={save}
                  disabled={!dirty}
                  testID="save-settings"
                />
                <SectionTitle title="출발 알림" />
                <Text style={shared.muted}>
                  {Platform.OS === 'web'
                    ? '웹에서는 앱 안에서 계획을 확인해요. 기기 알림은 모바일 앱에서 설정해 주세요.'
                    : '계획에서 알림을 켤 때 기기 권한을 요청해요.'}
                </Text>
                <Button
                  title="내 출발 알림 관리"
                  variant="secondary"
                  onPress={() => router.push('/notifications')}
                />
                <SectionTitle title="주행 기록과 위치" />
                <Text style={shared.muted}>
                  직접 주행을 시작할 때 위치 권한을 요청해요. 종료 후 저장해야 누적 주행거리에
                  반영해요.
                </Text>
                <Notice
                  title="백그라운드 측정은 지원하지 않아요"
                  body="다른 앱으로 이동하거나 화면을 잠그면 측정이 일시 정지돼요. 돌아온 뒤 직접 재개해 주세요."
                />
                <Text style={shared.muted}>
                  속도에 따른 자동 감지나 자동 기록은 사용하지 않아요.
                </Text>
                {recorder.activeTrip && (
                  <Button
                    title="진행 중인 기록 확인"
                    variant="secondary"
                    onPress={() => router.push('/route')}
                  />
                )}
              </View>
            </SettingsDisclosure>
            <SettingsDisclosure title="기기 데이터 관리" description="파일 백업, 복원, 초기화">
              <Text style={shared.muted}>
                차량 {state.vehicles.length}대 · 이동 계획 {state.plans.length}개 · 주행 기록{' '}
                {state.trips.length}개
              </Text>
              <Text style={shared.muted}>
                이 기기의 기록이에요. 계정별 서버 백업은 직접 저장한 경우에만 갱신돼요.
              </Text>
              <BackupSettings onRestored={onRestored} />
              {confirmReset ? (
                <View style={shared.stack}>
                  <Notice
                    title="모든 로컬 데이터를 삭제할까요?"
                    body="차량, 이동 계획, 주행·정비 기록, 설정을 모두 지워요. 삭제 후에는 되돌릴 수 없어요."
                    tone="warning"
                  />
                  <Button
                    title="모든 데이터 삭제"
                    variant="danger"
                    onPress={reset}
                    disabled={!!recorder.activeTrip || recorder.status === 'requesting'}
                    loading={resetting}
                    testID="confirm-reset"
                  />
                  <Button
                    title="취소"
                    variant="ghost"
                    onPress={() => setConfirmReset(false)}
                    disabled={resetting}
                  />
                  {recorder.activeTrip && (
                    <Text style={shared.muted}>
                      진행 중인 주행을 먼저 저장하거나 취소해 주세요.
                    </Text>
                  )}
                </View>
              ) : (
                <Button
                  title="기기 데이터 초기화"
                  variant="ghost"
                  icon="trash-2"
                  onPress={() => setConfirmReset(true)}
                />
              )}
            </SettingsDisclosure>
            {session && (
              <SettingsDisclosure title="참고 자료" description="분석 상세와 프로젝트 문서">
                <Button
                  title="가격 분석 상세"
                  variant="secondary"
                  onPress={() => router.push('/analysis')}
                />
                <Button
                  title="프로젝트 자료"
                  variant="secondary"
                  onPress={() => router.push('/documents')}
                />
              </SettingsDisclosure>
            )}
          </View>
        )}
      </View>
    </Screen>
  );
}
const s = StyleSheet.create({
  content: { width: '100%', maxWidth: 680, alignSelf: 'center', gap: 20 },
  steps: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  activeStep: { color: C.primary, fontWeight: '700', fontSize: 14 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
});
