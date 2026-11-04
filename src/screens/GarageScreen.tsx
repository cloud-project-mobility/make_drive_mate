import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Button, C, Card, Icon, type IconName, Screen, shared } from '../components/ui';
import { VehiclePicker } from '../components/VehiclePicker';
import { VehiclePhotoCredits } from '../components/VehiclePhotoCredits';
import { useApp } from '../state/AppProvider';
import { useBackend } from '../state/BackendProvider';
import ServerVehicles from './ServerVehicles';

export default function GarageScreen() {
  const { state } = useApp();
  const { session } = useBackend();
  const [showCloud, setShowCloud] = useState(false);
  const vehicle =
    state.vehicles.find((item) => item.id === state.selectedVehicleId) ?? state.vehicles[0];
  const rows: { title: string; subtitle: string; icon: IconName; onPress: () => void }[] = vehicle
    ? [
        {
          title: '차량 정보',
          subtitle: '차종 · 구동 방식 · 주행거리',
          icon: 'truck',
          onPress: () => router.push({ pathname: '/vehicle', params: { id: vehicle.id } }),
        },
        {
          title: '주행 기록',
          subtitle: '저장한 주행 내역',
          icon: 'map',
          onPress: () => router.push({ pathname: '/trips', params: { view: 'history' } }),
        },
        {
          title: '정비·소모품 기록',
          subtitle: '점검과 교체 기록',
          icon: 'tool',
          onPress: () => router.push('/maintenance'),
        },
      ]
    : [];
  return (
    <Screen
      title="내 차"
      action={
        <Button
          title="차량 등록"
          icon="plus"
          variant="ghost"
          disabled={state.vehicles.length >= 3}
          onPress={() => router.push('/vehicle')}
        />
      }
    >
      <Card style={s.content}>
        {vehicle ? (
          <>
            <VehiclePicker />
            <View>
              {rows.map((row) => (
                <Pressable
                  key={row.title}
                  accessibilityRole="button"
                  accessibilityLabel={row.title === '차량 정보' ? '차량 정보 수정' : row.title}
                  onPress={row.onPress}
                  style={s.row}
                >
                  <Icon name={row.icon} size={22} color={C.muted} />
                  <View style={s.rowCopy}>
                    <Text style={s.title}>{row.title}</Text>
                    <Text style={shared.muted}>{row.subtitle}</Text>
                  </View>
                  <Icon name="chevron-right" size={18} color={C.muted} />
                </Pressable>
              ))}
            </View>
            <Button
              title="이 차량으로 이동 계획"
              variant="secondary"
              icon="navigation"
              onPress={() => router.push('/plan')}
            />
          </>
        ) : (
          <View style={s.content}>
            <Text style={s.title}>등록한 차량이 없어요</Text>
            <Text style={shared.text}>차종과 주행거리부터 입력해 주세요.</Text>
            <Button title="첫 차량 등록" icon="plus" onPress={() => router.push('/vehicle')} />
          </View>
        )}
      </Card>
      {session && (
        <View style={{ gap: 12 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showCloud }}
            aria-expanded={showCloud}
            onPress={() => setShowCloud(!showCloud)}
            style={s.manage}
          >
            <Icon name="cloud" size={18} color={C.muted} />
            <Text style={s.manageText}>계정에 저장한 차량 불러오기</Text>
            <Icon name={showCloud ? 'chevron-up' : 'chevron-down'} size={17} color={C.muted} />
          </Pressable>
          {showCloud && <ServerVehicles />}
        </View>
      )}
      <Text style={shared.muted}>
        {state.demoMode
          ? '현재 차량과 기록은 예시 데이터예요.'
          : '주행·점검 기록은 이 기기에 보관해요. 계정 백업은 설정에서 관리할 수 있어요.'}
      </Text>
      <VehiclePhotoCredits />
    </Screen>
  );
}
const s = StyleSheet.create({
  content: { gap: 24 },
  row: {
    minHeight: 84,
    borderTopWidth: 1,
    borderTopColor: C.line,
    paddingVertical: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  rowCopy: { flex: 1, gap: 5 },
  title: { color: C.ink, fontSize: 18, lineHeight: 26, fontWeight: '600' },
  manage: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 },
  manageText: { color: C.muted, fontSize: 14, flex: 1 },
});
