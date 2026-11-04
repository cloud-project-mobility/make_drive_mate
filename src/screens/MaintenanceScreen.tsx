import { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
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
import {
  createId,
  formatDistance,
  parseLocalDateTime,
  parseNonNegativeNumber,
} from '../domain/helpers';
import { getVehicleMaintenance } from '../domain/maintenance';
const dateInput = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export default function MaintenanceScreen() {
  const { item } = useLocalSearchParams<{ item?: string }>();
  const { state, dispatch } = useApp();
  const vehicle = state.vehicles.find((v) => v.id === state.selectedVehicleId);
  const [editing, setEditing] = useState<string | null>(item ?? null);
  const [km, setKm] = useState(vehicle?.odometerKm.toString() ?? '');
  const [date, setDate] = useState(dateInput());
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const statuses = vehicle ? getVehicleMaintenance(vehicle, state.maintenance) : [];
  function save(itemId: string) {
    if (!vehicle) return;
    const n = parseNonNegativeNumber(km, '점검 당시 주행거리');
    if (!n.ok) return setError(n.error);
    const d = parseLocalDateTime(date, '00:00');
    if (!d) return setError('점검일을 YYYY-MM-DD 형식의 실제 날짜로 입력해 주세요.');
    const result = dispatch({
      type: 'ADD_MAINTENANCE',
      record: {
        id: createId('service'),
        vehicleId: vehicle.id,
        itemId,
        odometerKm: n.value,
        performedAt: d.toISOString(),
        note: note.trim() || undefined,
      },
    });
    if (!result.ok) return setError(result.error);
    setEditing(null);
    setError('');
    setNote('');
    setSuccess('점검 기록을 저장했어요. 다음 확인 시기에 반영됩니다.');
  }
  if (!vehicle)
    return (
      <Screen back title="소모품 관리">
        <Notice title="먼저 차량을 등록해 주세요." />
        <Button title="차량 등록" onPress={() => router.push('/vehicle')} />
      </Screen>
    );
  return (
    <Screen
      back
      eyebrow="A LITTLE CARE, A BETTER DRIVE"
      title="소모품 관리"
      subtitle={`${vehicle.name} · ${formatDistance(vehicle.odometerKm)} km`}
    >
      <Notice
        title="주기보다, 내 차의 상태가 먼저예요."
        body="아래 주기는 원본 디자인의 예시입니다. 차종·연식·환경에 따라 달라지므로 제조사 매뉴얼과 실제 정비 이력을 기준으로 확인해 주세요."
      />
      {!!success && <Notice title={success} />}
      <View style={shared.between}>
        <Text style={s.section}>점검 항목</Text>
        <Chip label={`${statuses.length}개 항목`} />
      </View>
      {statuses.map((status) => (
        <Card key={status.item.id} style={{ gap: 15 }}>
          <View style={shared.between}>
            <View style={shared.row}>
              <View
                style={[
                  s.itemIcon,
                  {
                    backgroundColor:
                      status.status === 'overdue'
                        ? '#FDEEEE'
                        : status.status === 'dueSoon'
                          ? C.amberBg
                          : C.mint,
                  },
                ]}
              >
                <Icon
                  name={
                    status.item.id === 'engine-oil'
                      ? 'droplet'
                      : status.item.id === 'tires'
                        ? 'disc'
                        : 'tool'
                  }
                  color={
                    status.status === 'overdue'
                      ? C.red
                      : status.status === 'dueSoon'
                        ? C.amber
                        : C.primary
                  }
                />
              </View>
              <View style={{ flexShrink: 1, gap: 5 }}>
                <Text style={s.title}>{status.item.name}</Text>
                <Text
                  style={[
                    s.status,
                    {
                      color:
                        status.status === 'overdue'
                          ? C.red
                          : status.status === 'dueSoon'
                            ? C.amber
                            : C.muted,
                    },
                  ]}
                >
                  {status.label}
                </Text>
              </View>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${status.item.name} 점검 기록하기`}
              onPress={() => {
                setEditing(editing === status.item.id ? null : status.item.id);
                setError('');
                setSuccess('');
                setKm(vehicle.odometerKm.toString());
              }}
              style={s.recordButton}
            >
              <Icon name={editing === status.item.id ? 'minus' : 'plus'} color={C.primary} />
            </Pressable>
          </View>
          <Text style={shared.muted}>
            {status.item.intervalKm ? `${formatDistance(status.item.intervalKm)} km` : ''}
            {status.item.intervalKm && status.item.intervalMonths ? ' 또는 ' : ''}
            {status.item.intervalMonths ? `${status.item.intervalMonths}개월` : ''}
            {status.item.intervalKm || status.item.intervalMonths
              ? '마다 · 예시 기준'
              : '제조사 매뉴얼 기준'}
          </Text>
          {status.lastRecord && (
            <Text style={shared.muted}>
              최근 기록 {new Date(status.lastRecord.performedAt).toLocaleDateString('ko-KR')} ·{' '}
              {formatDistance(status.lastRecord.odometerKm)} km
            </Text>
          )}
          {editing === status.item.id && (
            <View style={s.form}>
              <Text style={shared.text}>{status.item.description}</Text>
              <Field
                label="점검일 (YYYY-MM-DD)"
                value={date}
                onChangeText={setDate}
                placeholder="2026-10-21"
                maxLength={10}
              />
              <Field
                label="점검 당시 주행거리 (km)"
                value={km}
                onChangeText={setKm}
                keyboardType="decimal-pad"
                hint={`현재 누적 주행거리 ${formatDistance(vehicle.odometerKm)} km 이하로 입력해 주세요.`}
              />
              <Field
                label="메모 (선택)"
                value={note}
                onChangeText={setNote}
                placeholder="예: 오일과 필터 함께 교체"
                maxLength={300}
                multiline
              />
              {!!error && <Notice title={error} tone="error" />}
              <Button
                title={`${status.item.name} 기록 저장`}
                icon="check"
                onPress={() => save(status.item.id)}
              />
              <Button
                title="기록 취소"
                variant="ghost"
                onPress={() => {
                  setEditing(null);
                  setError('');
                }}
              />
            </View>
          )}
        </Card>
      ))}
      <SectionTitle title="최근 점검 기록" />
      {state.maintenance.filter((r) => r.vehicleId === vehicle.id).length ? (
        state.maintenance
          .filter((r) => r.vehicleId === vehicle.id)
          .sort((a, b) => b.performedAt.localeCompare(a.performedAt))
          .slice(0, 10)
          .map((r) => (
            <Card key={r.id} style={{ gap: 7 }}>
              <View style={shared.between}>
                <Text style={s.title}>
                  {statuses.find((s) => s.item.id === r.itemId)?.item.name ?? r.itemId}
                </Text>
                <Text style={shared.muted}>
                  {new Date(r.performedAt).toLocaleDateString('ko-KR')}
                </Text>
              </View>
              <Text style={shared.muted}>
                {formatDistance(r.odometerKm)} km{r.note ? ` · ${r.note}` : ''}
              </Text>
            </Card>
          ))
      ) : (
        <Text style={shared.muted}>첫 점검 기록을 남기면 이곳에 모아드려요.</Text>
      )}
    </Screen>
  );
}
const s = StyleSheet.create({
  section: { fontSize: 18, fontWeight: '700', color: C.ink },
  itemIcon: {
    width: 42,
    height: 42,
    borderRadius: 13,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: { fontSize: 15, fontWeight: '600', color: C.ink },
  status: { fontSize: 12, lineHeight: 19 },
  recordButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: C.mint,
  },
  form: { borderTopWidth: 1, borderTopColor: C.line, paddingTop: 18, gap: 15 },
});
