import React, { useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import {
  Button,
  C,
  Card,
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

export default function SettingsScreen() {
  const { state, dispatch } = useApp();
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
  return (
    <Screen title="설정" eyebrow="MAKE IT YOURS" subtitle="나에게 맞는 여유를 설정해요.">
      <Card style={s.identity}>
        <View style={s.identityIcon}>
          <Icon name="smartphone" size={27} color={C.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={shared.heading}>이 기기에서 사용 중</Text>
          <Text style={shared.muted}>가입 없이 시작하는 나의 드라이브</Text>
        </View>
        <Chip label={state.demoMode ? '체험 중' : '로컬 저장'} selected />
      </Card>
      {message && <Notice title="저장 완료" body={message} />}
      {error && <Notice title={error} tone="error" />}
      <View style={s.columns}>
        <View style={s.column}>
          <Card style={shared.stack}>
            <SectionTitle title="출발 계획 기본값" />
            <Text style={shared.muted}>
              새 이동 계획에 미리 채워 둘 시간이에요. 각 계획에서 따로 조정할 수 있어요.
            </Text>
            <View style={s.settingHeading}>
              <Icon name="coffee" color={C.primary} />
              <Text style={s.settingTitle}>도착 전 여유 시간</Text>
            </View>
            <Field
              label="여유 시간 (분)"
              value={buffer}
              onChangeText={(value) => {
                setBuffer(value);
                setMessage(null);
              }}
              keyboardType="number-pad"
              maxLength={3}
              hint="일정 전에 숨 돌릴 시간을 확보해요. 0~180분"
              testID="settings-buffer"
            />
            <View style={s.chips}>
              {[0, 5, 10, 15, 30].map((value) => (
                <Chip
                  key={value}
                  label={`여유 ${value}분`}
                  selected={buffer === String(value)}
                  onPress={() => {
                    setBuffer(String(value));
                    setMessage(null);
                  }}
                />
              ))}
            </View>
            <View style={s.divider} />
            <View style={s.settingHeading}>
              <Icon name="map-pin" color={C.primary} />
              <Text style={s.settingTitle}>주차 후 도보</Text>
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
              hint="주차한 곳에서 목적지까지 걸어가는 시간이에요. 0~180분"
              testID="settings-walk"
            />
            <View style={s.chips}>
              {[0, 5, 10, 15, 30].map((value) => (
                <Chip
                  key={value}
                  label={`도보 ${value}분`}
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
            <Text style={s.caption}>이미 저장한 이동 계획의 시간은 바뀌지 않아요.</Text>
          </Card>
          <Card style={shared.stack}>
            <View style={shared.row}>
              <Icon name="bell" color={C.primary} />
              <Text style={shared.heading}>출발 알림</Text>
            </View>
            <Text style={shared.muted}>
              {Platform.OS === 'web'
                ? '웹에서는 앱 안에서 출발 계획을 확인할 수 있어요. 기기 출발 알림은 모바일 앱에서 설정해 주세요.'
                : '이동 계획마다 출발 알림을 선택할 수 있어요. 알림을 켤 때 기기 권한을 요청해요.'}
            </Text>
            <Button
              title="내 출발 알림 관리"
              icon="arrow-right"
              variant="secondary"
              onPress={() => router.push('/notifications')}
            />
          </Card>
        </View>
        <View style={s.column}>
          <Card style={shared.stack}>
            <SectionTitle title="주행 기록과 위치" />
            <View style={shared.between}>
              <Text style={shared.text}>화면이 켜진 앱에서 측정</Text>
              <Chip label="직접 시작" selected />
            </View>
            <Text style={shared.muted}>
              주행 시작 버튼을 누른 뒤 위치 권한을 요청해요. 직접 종료하고 저장해야 누적 주행거리에
              반영해요.
            </Text>
            <Notice
              title="백그라운드 측정은 지원하지 않아요"
              body="다른 앱으로 이동하거나 화면을 잠그면 거리 측정이 일시 정지돼요. 돌아온 뒤 직접 재개해 주세요."
            />
            <Text style={shared.muted}>
              속도에 따른 자동 주행 감지나 자동 기록은 사용하지 않아요.
            </Text>
            {recorder.activeTrip && (
              <Button
                title="진행 중인 기록 확인"
                icon="activity"
                variant="secondary"
                onPress={() => router.push('/route')}
              />
            )}
          </Card>
          <BackendSettings
            onRestored={(settings) => {
              setWalk(String(settings.walkMinutes));
              setBuffer(String(settings.bufferMinutes));
              setMessage(null);
              setError(null);
            }}
          />
          <BackupSettings
            onRestored={(settings) => {
              setWalk(String(settings.walkMinutes));
              setBuffer(String(settings.bufferMinutes));
              setMessage(null);
              setError(null);
            }}
          />
          <Card style={shared.stack}>
            <SectionTitle title="기기 데이터 관리" />
            <Text style={shared.muted}>
              차량 {state.vehicles.length}대 · 이동 계획 {state.plans.length}개 · 주행 기록{' '}
              {state.trips.length}개
            </Text>
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
                  <Text style={s.caption}>진행 중인 주행을 먼저 저장하거나 취소해 주세요.</Text>
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
          </Card>
          <View style={s.brand}>
            <Text style={s.brandName}>DriveMate</Text>
            <Text style={s.caption}>조금 더 편안한, 나의 드라이브.</Text>
            <Text style={s.caption}>v1.0 · React Native</Text>
          </View>
        </View>
      </View>
    </Screen>
  );
}
const s = StyleSheet.create({
  identity: { flexDirection: 'row', gap: 14, alignItems: 'center', flexWrap: 'wrap' },
  identityIcon: {
    width: 56,
    height: 56,
    borderRadius: 20,
    backgroundColor: C.mint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  columns: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: 20 },
  column: { flex: 1, minWidth: 280, gap: 20 },
  settingHeading: { flexDirection: 'row', gap: 9, alignItems: 'center', marginTop: 5 },
  settingTitle: { color: C.ink, fontSize: 15, fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  divider: { height: 1, backgroundColor: C.line, marginVertical: 3 },
  caption: { color: C.muted, fontSize: 11, lineHeight: 18 },
  brand: { alignItems: 'center', paddingVertical: 18, gap: 8 },
  brandName: { fontSize: 21, fontWeight: '800', letterSpacing: -0.5, color: C.ink },
});
