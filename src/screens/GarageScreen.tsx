import { useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import {
  Button,
  C,
  Card,
  Chip,
  Icon,
  Notice,
  Screen,
  SectionTitle,
  shared,
} from '../components/ui';
import { VehicleArt } from '../components/VehicleArt';
import { VehiclePhotoCredits } from '../components/VehiclePhotoCredits';
import { useApp } from '../state/AppProvider';
import { formatDistance } from '../domain/helpers';
import { getVehicleMaintenance } from '../domain/maintenance';
import ValueDashboard from './ValueDashboard';
import ServerVehicles from './ServerVehicles';
const powertrainLabel = { ICE: '내연기관', HYB: '하이브리드', EV: '전기차' };
export default function GarageScreen() {
  const { state, dispatch } = useApp();
  const { width } = useWindowDimensions();
  const [error, setError] = useState('');
  const vehicle = state.vehicles.find((v) => v.id === state.selectedVehicleId) ?? state.vehicles[0];
  const items = vehicle ? getVehicleMaintenance(vehicle, state.maintenance) : [];
  const attention = items.filter((i) => i.status === 'dueSoon' || i.status === 'overdue');
  const trips = state.trips.filter((t) => t.vehicleId === vehicle?.id && t.source !== 'sample');
  const totalKm = trips.reduce((n, t) => n + t.distanceKm, 0);
  const select = (id: string) => {
    const result = dispatch({ type: 'SELECT_VEHICLE', vehicleId: id });
    setError(result.ok ? '' : result.error);
  };
  return (
    <Screen
      eyebrow="DRIVEMATE / VALUE & TIMING"
      title="내 차의 다음 타이밍"
      subtitle="가치의 흐름을 보고, 나에게 맞는 매도 시점을 비교해요."
      action={
        <Pressable
          accessibilityLabel="알림 보기"
          accessibilityRole="button"
          onPress={() => router.push('/notifications')}
          style={s.bell}
        >
          <Icon name="bell" />
        </Pressable>
      }
    >
      {state.demoMode && (
        <View style={s.demo}>
          <View style={shared.row}>
            <Icon name="layers" size={14} color={C.primary} />
            <Text style={s.demoText}>예시 차량을 둘러보고 있어요</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="예시 데이터 안내"
            onPress={() => router.push('/(tabs)/settings')}
            style={{ paddingVertical: 8 }}
          >
            <Text style={s.demoLink}>안내</Text>
          </Pressable>
        </View>
      )}
      {!!error && <Notice title={error} tone="error" />}
      <ServerVehicles />
      <View style={shared.between}>
        <Text style={shared.heading}>{`분석할 차량 ${state.vehicles.length}`}</Text>
        {state.vehicles.length < 3 ? (
          <Button
            title="차량 추가"
            variant="ghost"
            icon="plus"
            onPress={() => router.push('/vehicle')}
          />
        ) : (
          <Chip label="최대 3대 등록됨" />
        )}
      </View>
      {!vehicle ? (
        <Card style={s.empty}>
          <View style={s.emptyIcon}>
            <Icon name="truck" size={32} color={C.primary} />
          </View>
          <Text style={s.emptyTitle}>첫 번째 메이트를 만나볼까요?</Text>
          <Text style={s.emptyBody}>
            차량과 주행거리를 등록하면{'\n'}가치 변화와 매도 조건을 비교할 수 있어요.
          </Text>
          <Button title="첫 차량 등록" icon="plus" onPress={() => router.push('/vehicle')} />
          <Text style={shared.muted}>내연기관 · 하이브리드 · 전기차, 최대 3대</Text>
        </Card>
      ) : (
        <>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ flexGrow: 0, marginTop: -8 }}
            contentContainerStyle={s.selectors}
          >
            {state.vehicles.map((v) => (
              <Pressable
                key={v.id}
                accessibilityRole="button"
                accessibilityLabel={v.name}
                accessibilityHint={`${v.model}, 분석할 차량 선택`}
                accessibilityState={{ selected: v.id === vehicle.id }}
                aria-pressed={v.id === vehicle.id}
                onPress={() => select(v.id)}
                style={({ pressed }) => [
                  s.vehicleCard,
                  { width: width >= 820 ? (Math.min(width, 1060) - 72) / 3 : Math.min(width - 72, 290) },
                  v.id === vehicle.id && s.vehicleCardSelected,
                  pressed && { opacity: 0.8 },
                ]}
              >
                <VehicleArt type={v.powertrain} model={v.model} catalogId={v.catalogId} caption={false} style={s.thumbnail} />
                <View style={s.vehicleCardBody}>
                  <View style={shared.between}>
                    <Text numberOfLines={1} style={s.vehicleCardName}>{v.name}</Text>
                    {v.id === vehicle.id && <Icon name="check-circle" color={C.primary} size={18} />}
                  </View>
                  <Text numberOfLines={1} style={s.vehicleCardModel}>{v.model}</Text>
                  <View style={s.vehicleCardMeta}>
                    <Icon name={v.powertrain === 'EV' ? 'zap' : 'truck'} color={C.muted} size={12} />
                    <Text style={s.vehicleCardType}>{powertrainLabel[v.powertrain]}</Text>
                    <Text style={s.vehicleCardSelection}>{v.id === vehicle.id ? '분석 중' : '선택하기'}</Text>
                  </View>
                </View>
              </Pressable>
            ))}
          </ScrollView>
          <VehiclePhotoCredits />
          <ValueDashboard
            key={`${vehicle.id}:${vehicle.odometerKm}:${vehicle.model}`}
            vehicle={vehicle}
          />
          <View style={shared.divider} />
          <SectionTitle title="차량 기록도 함께 관리해요" />
          <View style={[s.columns, width >= 820 && s.wideColumns]}>
            <View style={[s.hero, width < 820 && { padding: 16 }, width >= 820 && { flex: 1.12 }]}>
              <View style={shared.between}>
                <Chip
                  label={`${powertrainLabel[vehicle.powertrain]} · ${vehicle.powertrain}`}
                  selected
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="차량 정보 수정"
                  onPress={() => router.push({ pathname: '/vehicle', params: { id: vehicle.id } })}
                  style={s.edit}
                >
                  <Icon name="more-horizontal" color={C.muted} />
                </Pressable>
              </View>
              <Text style={[s.vehicleName, width < 820 && { marginTop: 4, fontSize: 25 }]}>
                {vehicle.name}
              </Text>
              <Text style={s.model}>{vehicle.model}</Text>
              {width < 820 && attention.length > 0 && (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => router.push('/maintenance')}
                  style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6 }}
                >
                  <Icon name="alert-circle" size={14} color={C.amber} />
                  <Text style={{ fontSize: 12, color: C.amber, flex: 1 }}>
                    점검 예정 {attention.length}개 · {attention[0].item.name}
                  </Text>
                  <Icon name="chevron-right" size={14} color={C.amber} />
                </Pressable>
              )}
              <VehicleArt
                type={vehicle.powertrain}
                model={vehicle.model}
                catalogId={vehicle.catalogId}
                style={{ height: width >= 820 ? 245 : 205, marginVertical: 16 }}
              />
              <View style={shared.between}>
                <View>
                  <Text style={s.odometerLabel}>누적 주행거리</Text>
                  <View style={[shared.row, { alignItems: 'baseline', gap: 6 }]}>
                    <Text testID="vehicle-odometer" style={s.odometer}>
                      {formatDistance(vehicle.odometerKm)}
                    </Text>
                    <Text style={s.unit}>km</Text>
                  </View>
                </View>
                <View style={s.selected}>
                  <Icon name="check" size={13} color={C.primary} />
                  <Text style={s.selectedText}>선택한 차량</Text>
                </View>
              </View>
              <View style={s.heroDivider} />
              <Button
                title="이 차량으로 이동 계획"
                onPress={() => router.push('/plan')}
                icon="navigation"
              />
            </View>
            <View style={[{ gap: 16 }, width >= 820 && { flex: 1 }]}>
              <View style={s.careHeading}>
                <View>
                  <Text style={s.smallLabel}>CAR CARE</Text>
                  <Text style={s.careTitle}>
                    {attention.length ? '곧, 확인이 필요해요' : '기록부터 차근차근'}
                  </Text>
                </View>
                <View style={s.careIcon}>
                  <Icon name="tool" color={C.primary} size={22} />
                </View>
              </View>
              <Card style={{ gap: 4 }}>
                <SectionTitle
                  title="소모품 체크"
                  action="전체 보기"
                  onAction={() => router.push('/maintenance')}
                />
                {items.slice(0, 3).map((item, index) => (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityHint="점검 기록하기"
                    onPress={() =>
                      router.push({ pathname: '/maintenance', params: { item: item.item.id } })
                    }
                    style={[s.careRow, index > 0 && { borderTopWidth: 1, borderTopColor: C.line }]}
                    key={item.item.id}
                  >
                    <View
                      style={[
                        s.statusDot,
                        {
                          backgroundColor:
                            item.status === 'overdue'
                              ? C.red
                              : item.status === 'dueSoon'
                                ? '#D49B41'
                                : C.primary,
                        },
                      ]}
                    />
                    <View style={{ flex: 1, gap: 5 }}>
                      <Text style={s.itemName}>{item.item.name}</Text>
                      <Text
                        style={[
                          shared.muted,
                          item.status === 'dueSoon' && { color: C.amber },
                          item.status === 'overdue' && { color: C.red },
                        ]}
                      >
                        {item.label}
                      </Text>
                    </View>
                    <Icon name="chevron-right" size={17} color={C.muted} />
                  </Pressable>
                ))}
                <Text style={s.disclaimer}>
                  예시 주기 기준 · 정확한 점검은 제조사 매뉴얼을 확인해요.
                </Text>
              </Card>
              <View style={s.tip}>
                <Icon name="sun" color={C.primary} size={20} />
                <View style={{ flex: 1 }}>
                  <Text style={s.tipTitle}>작은 기록이, 더 오래 함께하게 해요.</Text>
                  <Text style={shared.muted}>마지막 점검일과 주행거리를 남겨주세요.</Text>
                </View>
              </View>
            </View>
          </View>
          <SectionTitle
            title="함께 달린 기록"
            action="기록 보기"
            onAction={() => router.push('/(tabs)/trips')}
          />
          <View style={s.stats}>
            <Card style={s.stat}>
              <Icon name="map" color={C.primary} />
              <Text style={s.statValue}>
                {formatDistance(totalKm)}
                <Text style={s.statUnit}> km</Text>
              </Text>
              <Text style={shared.muted}>저장한 주행거리</Text>
            </Card>
            <Card style={s.stat}>
              <Icon name="flag" color={C.primary} />
              <Text style={s.statValue}>
                {trips.length}
                <Text style={s.statUnit}> 회</Text>
              </Text>
              <Text style={shared.muted}>완료한 주행</Text>
            </Card>
            <Card style={s.stat}>
              <Icon name="check-circle" color={C.primary} />
              <Text style={s.statValue}>
                {state.maintenance.filter((r) => r.vehicleId === vehicle.id).length}
                <Text style={s.statUnit}> 건</Text>
              </Text>
              <Text style={shared.muted}>소모품 점검 기록</Text>
            </Card>
          </View>
        </>
      )}
      <View style={s.bottomNote}>
        <Icon name="shield" size={13} color={C.muted} />
        <Text style={shared.muted}>내 기기에 보관되는 나만의 차량 기록</Text>
      </View>
    </Screen>
  );
}
const s = StyleSheet.create({
  bell: {
    width: 46,
    height: 46,
    borderRadius: 16,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: C.line,
  },
  demo: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: C.mint,
  },
  demoText: { fontSize: 12, color: C.primary },
  demoLink: { color: C.primary, fontSize: 12, fontWeight: '700' },
  selectors: { flexDirection: 'row', gap: 12, paddingVertical: 2 },
  vehicleCard: { borderWidth: 1, borderColor: C.line, borderRadius: 18, overflow: 'hidden', backgroundColor: C.surface },
  vehicleCardSelected: { borderColor: C.primary, backgroundColor: '#EDF5FF' },
  thumbnail: { height: 155, borderRadius: 0, marginHorizontal: 14, marginTop: 12 },
  vehicleCardBody: { padding: 14, gap: 7 },
  vehicleCardName: { flex: 1, fontSize: 16, fontWeight: '700', color: C.ink },
  vehicleCardModel: { fontSize: 12, color: C.muted },
  vehicleCardMeta: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4 },
  vehicleCardType: { fontSize: 11, color: C.muted },
  vehicleCardSelection: { marginLeft: 'auto', fontSize: 11, fontWeight: '600', color: C.primary },
  columns: { gap: 24 },
  wideColumns: { flexDirection: 'row', alignItems: 'stretch' },
  hero: {
    backgroundColor: '#EAF3FF',
    padding: 22,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#DCE8FA',
  },
  edit: { minHeight: 44, minWidth: 44, alignItems: 'flex-end', justifyContent: 'center' },
  vehicleName: {
    color: C.ink,
    fontSize: 28,
    fontWeight: '800',
    marginTop: 16,
    letterSpacing: -0.8,
  },
  model: { fontSize: 13, color: C.muted, marginTop: 6 },
  odometerLabel: { color: C.muted, fontSize: 12, marginBottom: 6 },
  odometer: { fontSize: 34, fontWeight: '800', color: C.ink, letterSpacing: -1 },
  unit: { color: C.muted, fontSize: 14 },
  selected: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#D9E9E0',
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 7,
  },
  selectedText: { fontSize: 10, color: C.primary, fontWeight: '600' },
  heroDivider: { height: 1, backgroundColor: '#D3E1D8', marginVertical: 20 },
  careHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  smallLabel: {
    color: C.primary,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.8,
    marginBottom: 6,
  },
  careTitle: { fontSize: 21, fontWeight: '700', color: C.ink, letterSpacing: -0.5 },
  careIcon: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.mint,
    borderRadius: 14,
  },
  careRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    paddingVertical: 17,
    minHeight: 70,
  },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  itemName: { fontSize: 14, color: C.ink, fontWeight: '600' },
  disclaimer: { fontSize: 11, color: C.muted, lineHeight: 18, paddingTop: 8 },
  tip: { flexDirection: 'row', gap: 12, backgroundColor: '#ECF2EF', borderRadius: 16, padding: 17 },
  tipTitle: { fontSize: 13, fontWeight: '600', color: C.ink, lineHeight: 21 },
  stats: { flexDirection: 'row', gap: 10 },
  stat: { flex: 1, padding: 14, gap: 9, borderRadius: 17 },
  statValue: { color: C.ink, fontSize: 23, fontWeight: '800' },
  statUnit: { color: C.muted, fontSize: 11, fontWeight: '400' },
  bottomNote: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingTop: 8,
  },
  empty: { gap: 20, paddingVertical: 45 },
  emptyIcon: {
    width: 70,
    height: 70,
    borderRadius: 24,
    backgroundColor: C.mint,
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'center',
  },
  emptyTitle: { fontSize: 21, fontWeight: '700', color: C.ink, textAlign: 'center' },
  emptyBody: { color: C.muted, fontSize: 14, textAlign: 'center', lineHeight: 23 },
});
