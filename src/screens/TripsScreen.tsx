import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
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
import { useApp } from '../state/AppProvider';
import { departureAt } from '../domain/helpers';
import { useTripRecorder } from '../services/useTripRecorder';
import { cancelDeparture } from '../services/notifications';
import { dateLabel, durationLabel, timeLabel } from './tripParts';
import { useNow } from './useNow';

export default function TripsScreen() {
  const { state, dispatch } = useApp();
  const now = useNow();
  const recorder = useTripRecorder();
  const { view } = useLocalSearchParams<{ view?: string }>();
  const [tab, setTab] = useState<'plans' | 'history'>(view === 'history' ? 'history' : 'plans');
  useFocusEffect(
    useCallback(() => {
      if (view === 'history') setTab('history');
    }, [view]),
  );
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const plans = [...state.plans].sort((a, b) =>
    (a.eventAt || a.createdAt).localeCompare(b.eventAt || b.createdAt),
  );
  const trips = [...state.trips].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const vehicle = state.vehicles.find((item) => item.id === state.selectedVehicleId);
  const distance = trips
    .filter((trip) => trip.source !== 'sample')
    .reduce((total, trip) => total + trip.distanceKm, 0);
  async function removePlan(id: string) {
    try {
      await cancelDeparture(id);
      const result = dispatch({ type: 'DELETE_PLAN', planId: id });
      if (result.ok) setDeleting(null);
      else setError(result.error);
    } catch {
      setError('출발 알림을 해제하지 못했어요. 알림 상태를 확인한 뒤 계획을 다시 삭제해 주세요.');
    }
  }
  return (
    <Screen
      title="이동 계획"
      eyebrow="A LITTLE MORE ROOM"
      subtitle="출발부터 도착까지, 내 속도에 맞게."
      action={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="출발 알림 보기"
          onPress={() => router.push('/notifications')}
          style={s.bell}
        >
          <Icon name="bell" />
        </Pressable>
      }
    >
      {recorder.activeTrip && (
        <Card style={s.liveCard}>
          <View style={shared.row}>
            <View style={s.liveDot} />
            <View style={{ flex: 1 }}>
              <Text style={shared.heading}>진행 중인 주행이 있어요</Text>
              <Text style={shared.muted}>
                {recorder.status === 'recording' ? '위치 측정 중' : '일시 정지됨'} ·{' '}
                {recorder.distanceKm.toFixed(2)} km
              </Text>
            </View>
          </View>
          <Button
            title="주행 기록 이어 보기"
            icon="activity"
            onPress={() => router.push('/route')}
          />
        </Card>
      )}
      <Card style={s.hero}>
        <View style={s.heroTop}>
          <View style={{ flex: 1 }}>
            <Text style={s.heroEyebrow}>다음 이동도 가볍게</Text>
            <Text style={s.heroTitle}>도착할 시간에서{'\n'}출발을 계획해요.</Text>
            <Text style={s.heroBody}>
              운전, 주차 후 걷는 시간, 작은 여유까지.{'\n'}한 번에 계산하고 기억해 두세요.
            </Text>
          </View>
          <View style={s.heroIcon}>
            <Icon name="navigation" size={36} color={C.primary} />
          </View>
        </View>
        <View style={s.heroBottom}>
          <Chip
            icon="truck"
            label={vehicle ? vehicle.name : '등록된 차량 없음'}
            selected={!!vehicle}
          />
          <Text style={s.heroNote}>계획에 사용할 차량</Text>
        </View>
        <View style={s.actions}>
          <View style={s.action}>
            <Button
              title="새 이동 계획"
              icon="plus"
              onPress={() => router.push(state.vehicles.length ? '/plan' : '/vehicle')}
              testID="new-plan"
            />
          </View>
          <View style={s.action}>
            <Button
              title="일정으로 계획"
              icon="calendar"
              variant="secondary"
              onPress={() =>
                router.push(state.vehicles.length ? '/plan?mode=calendar' : '/vehicle')
              }
            />
          </View>
        </View>
      </Card>
      <View style={s.stats}>
        <View style={s.stat}>
          <Text style={s.statLabel}>저장한 이동 계획</Text>
          <Text style={s.statValue}>
            {plans.length}
            <Text style={s.statUnit}> 개</Text>
          </Text>
        </View>
        <View style={s.statDivider} />
        <View style={s.stat}>
          <Text style={s.statLabel}>기록한 주행거리</Text>
          <Text style={s.statValue}>
            {distance.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}
            <Text style={s.statUnit}> km</Text>
          </Text>
        </View>
      </View>
      <View style={s.tabs}>
        <Chip
          label={`이동 계획 ${plans.length}`}
          selected={tab === 'plans'}
          onPress={() => setTab('plans')}
        />
        <Chip
          label={`주행 기록 ${trips.length}`}
          selected={tab === 'history'}
          onPress={() => setTab('history')}
        />
      </View>
      {error && <Notice title={error} tone="error" />}
      {tab === 'plans' ? (
        <View style={shared.stack}>
          <SectionTitle title="저장한 계획" />
          {plans.length === 0 ? (
            <Card style={s.empty}>
              <Icon name="calendar" size={34} color={C.primary} />
              <Text style={shared.heading}>다음 목적지는 어디인가요?</Text>
              <Text style={[shared.muted, { textAlign: 'center' }]}>
                도착 시간과 예상 운전 시간을 입력하면{'\n'}날짜가 바뀌어도 출발 시간을 계산해요.
              </Text>
              <Button
                title="첫 이동 계획 만들기"
                variant="secondary"
                onPress={() => router.push(state.vehicles.length ? '/plan' : '/vehicle')}
              />
            </Card>
          ) : (
            plans.map((plan) => {
              const departure = departureAt(plan);
              const passed = !!plan.eventAt && new Date(plan.eventAt).getTime() < now;
              return (
                <Card key={plan.id} style={s.plan}>
                  <View style={shared.between}>
                    <Chip
                      icon="calendar"
                      label={plan.eventAt ? dateLabel(plan.eventAt) : '자유 일정'}
                    />
                    <View style={shared.row}>
                      {plan.source === 'sample' && <Chip label="예시" />}
                      {passed && <Chip label="지난 일정" />}
                    </View>
                  </View>
                  <View style={s.planContent}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.planTitle}>{plan.eventTitle || plan.destination}</Text>
                      <Text style={shared.muted}>
                        {plan.origin} → {plan.destination}
                      </Text>
                      <Text style={s.vehicleName}>
                        {state.vehicles.find((item) => item.id === plan.vehicleId)?.name ||
                          '차량 없음'}{' '}
                        · 운전 예상 {plan.driveMinutes}분
                      </Text>
                    </View>
                    <View style={s.departure}>
                      <Text style={s.statLabel}>권장 출발</Text>
                      <Text style={s.departureTime}>
                        {departure ? timeLabel(departure) : '시간 미정'}
                      </Text>
                      {departure && <Text style={s.departureDate}>{dateLabel(departure)}</Text>}
                    </View>
                  </View>
                  <Button
                    title="이동 계획 보기"
                    icon="arrow-up-right"
                    variant="secondary"
                    onPress={() => router.push({ pathname: '/route', params: { id: plan.id } })}
                  />
                  {deleting === plan.id ? (
                    <View style={s.confirm}>
                      <Text style={shared.muted}>
                        이 이동 계획을 삭제할까요? 주행 기록은 유지돼요.
                      </Text>
                      <View style={s.actions}>
                        <View style={s.action}>
                          <Button title="취소" variant="ghost" onPress={() => setDeleting(null)} />
                        </View>
                        <View style={s.action}>
                          <Button
                            title="계획 삭제"
                            variant="danger"
                            onPress={() => removePlan(plan.id)}
                          />
                        </View>
                      </View>
                    </View>
                  ) : (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${plan.eventTitle || plan.destination} 계획 삭제`}
                      onPress={() => setDeleting(plan.id)}
                      style={s.delete}
                    >
                      <Icon name="trash-2" size={13} color={C.muted} />
                      <Text style={s.deleteText}>계획 삭제</Text>
                    </Pressable>
                  )}
                </Card>
              );
            })
          )}
        </View>
      ) : (
        <View style={shared.stack}>
          <SectionTitle title="나의 주행 기록" />
          {trips.length === 0 ? (
            <Card style={s.empty}>
              <Icon name="activity" size={34} color={C.primary} />
              <Text style={shared.heading}>첫 주행을 기다리고 있어요</Text>
              <Text style={[shared.muted, { textAlign: 'center' }]}>
                이동 계획에서 기록을 시작하고 종료하면{'\n'}측정한 거리와 시간이 이곳에 쌓여요.
              </Text>
            </Card>
          ) : (
            trips.map((trip) => (
              <Card key={trip.id}>
                <View style={shared.between}>
                  <Text style={shared.muted}>
                    {dateLabel(trip.startedAt)} · {timeLabel(trip.startedAt)}
                  </Text>
                  <Chip
                    label={
                      trip.source === 'sample'
                        ? '예시 기록'
                        : trip.source === 'gps'
                          ? 'GPS 측정'
                          : '직접 기록'
                    }
                  />
                </View>
                <View style={s.historyMain}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.planTitle}>{trip.destination || '자유 주행'}</Text>
                    <Text style={shared.muted}>
                      {state.vehicles.find((item) => item.id === trip.vehicleId)?.name ||
                        '삭제한 차량'}{' '}
                      · {durationLabel(trip.durationSeconds)}
                    </Text>
                  </View>
                  <Text style={s.distance}>
                    {trip.distanceKm.toFixed(2)}
                    <Text style={s.statUnit}> km</Text>
                  </Text>
                </View>
                {trip.source === 'sample' && (
                  <Text style={s.vehicleName}>체험용 기록 · 누적 주행거리에 반영하지 않아요.</Text>
                )}
              </Card>
            ))
          )}
        </View>
      )}
    </Screen>
  );
}
const s = StyleSheet.create({
  bell: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hero: { backgroundColor: '#EDF6F2', borderColor: '#D4E8DF', gap: 22, padding: 26 },
  heroTop: { flexDirection: 'row', gap: 15, alignItems: 'center' },
  heroEyebrow: { color: C.primary, fontSize: 12, fontWeight: '700', marginBottom: 12 },
  heroTitle: { color: C.ink, fontSize: 28, lineHeight: 38, fontWeight: '800', letterSpacing: -1 },
  heroBody: { color: C.muted, fontSize: 13, lineHeight: 22, marginTop: 12 },
  heroIcon: {
    width: 68,
    height: 68,
    borderRadius: 24,
    backgroundColor: '#DAEEE4',
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '-8deg' }],
  },
  heroBottom: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 },
  heroNote: { fontSize: 11, color: C.muted },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  action: { flex: 1, minWidth: 180 },
  stats: {
    flexDirection: 'row',
    backgroundColor: C.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: C.line,
    padding: 21,
    gap: 22,
  },
  stat: { flex: 1, gap: 10 },
  statLabel: { fontSize: 12, color: C.muted },
  statValue: { fontSize: 28, color: C.ink, fontWeight: '800' },
  statUnit: { fontSize: 12, fontWeight: '400', color: C.muted },
  statDivider: { width: 1, backgroundColor: C.line },
  tabs: { flexDirection: 'row', gap: 10 },
  empty: { alignItems: 'center', paddingVertical: 34, gap: 15 },
  plan: { gap: 18 },
  planContent: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  planTitle: { fontSize: 18, fontWeight: '700', color: C.ink, lineHeight: 26, marginBottom: 5 },
  vehicleName: { fontSize: 12, color: C.muted, marginTop: 9, lineHeight: 19 },
  departure: { alignItems: 'flex-end', gap: 5 },
  departureTime: { fontSize: 26, fontWeight: '800', color: C.primary },
  departureDate: { fontSize: 10, color: C.muted },
  delete: {
    minHeight: 44,
    alignSelf: 'flex-end',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 4,
  },
  deleteText: { color: C.muted, fontSize: 12 },
  confirm: { gap: 10 },
  historyMain: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 18 },
  distance: { fontSize: 25, fontWeight: '800', color: C.primary },
  liveCard: { gap: 14, borderColor: C.primary },
  liveDot: { height: 9, width: 9, borderRadius: 5, backgroundColor: C.primary },
});
