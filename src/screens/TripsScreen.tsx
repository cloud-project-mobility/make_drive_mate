import React, { useCallback, useState } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
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
import { useBackend } from '../state/BackendProvider';
import { departureAt } from '../domain/helpers';
import type { TripPlan } from '../domain/types';
import { useTripRecorder } from '../services/useTripRecorder';
import {
  cancelDeparture,
  listScheduledDepartures,
  scheduleDeparture,
} from '../services/notifications';
import { dateLabel, durationLabel, localDateValue, timeLabel } from './tripParts';
import { useNow } from './useNow';

export default function TripsScreen() {
  const { state, dispatch } = useApp();
  const { session } = useBackend();
  const now = useNow();
  const compact = useWindowDimensions().width < 600;
  const recorder = useTripRecorder();
  const { view } = useLocalSearchParams<{ view?: string }>();
  const [tab, setTab] = useState<'plans' | 'history'>(view === 'history' ? 'history' : 'plans');
  const [menu, setMenu] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [scheduledIds, setScheduledIds] = useState<string[]>([]);
  const [notificationsReady, setNotificationsReady] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (view === 'history') setTab('history');
      let active = true;
      if (Platform.OS !== 'web') {
        setNotificationsReady(false);
        listScheduledDepartures()
          .then((items) => {
            if (active) {
              setScheduledIds(items.map((item) => item.planId));
              setNotificationsReady(true);
            }
          })
          .catch(() => {
            if (active)
              setError('기기의 알림 상태를 불러오지 못했어요. 출발 알림에서 다시 확인해 주세요.');
          });
      }
      return () => {
        active = false;
      };
    }, [view]),
  );
  const plans = [...state.plans].sort((a, b) =>
    (a.eventAt || a.createdAt).localeCompare(b.eventAt || b.createdAt),
  );
  const upcoming = plans.filter((plan) => !plan.eventAt || Date.parse(plan.eventAt) >= now);
  const pastPlans = plans
    .filter((plan) => plan.eventAt && Date.parse(plan.eventAt) < now)
    .reverse();
  const trips = [...state.trips].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const vehicle = state.vehicles.find((item) => item.id === state.selectedVehicleId);
  const newPlan = () => router.push(state.vehicles.length ? '/plan' : '/vehicle');

  async function removePlan(id: string) {
    if (busy !== null) return;
    setBusy(id);
    setError(null);
    try {
      await cancelDeparture(id);
      const result = dispatch({ type: 'DELETE_PLAN', planId: id });
      if (result.ok) {
        setDeleting(null);
        setMenu(null);
        setScheduledIds((ids) => ids.filter((item) => item !== id));
      } else setError(result.error);
    } catch {
      setError('출발 알림을 해제하지 못했어요. 알림 상태를 확인한 뒤 계획을 다시 삭제해 주세요.');
    } finally {
      setBusy(null);
    }
  }

  async function toggleNotification(plan: TripPlan) {
    if (busy !== null || !notificationsReady) return;
    setBusy(plan.id);
    setError(null);
    setMessage(null);
    try {
      if (scheduledIds.includes(plan.id)) {
        await cancelDeparture(plan.id);
        setScheduledIds((ids) => ids.filter((id) => id !== plan.id));
        setMessage('이 계획의 출발 알림을 해제했어요.');
      } else {
        const result = await scheduleDeparture(plan);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setScheduledIds((ids) => [...ids, plan.id]);
        setMessage('권장 출발 시간에 기기 알림을 보내도록 예약했어요.');
      }
    } catch {
      setError('알림을 변경하지 못했어요. 기기 알림 권한을 확인하고 다시 시도해 주세요.');
    } finally {
      setBusy(null);
    }
  }

  function renderPlans(items: TripPlan[]) {
    return items.map((plan, index) => {
      const departure = departureAt(plan);
      const day = plan.eventAt ? localDateValue(new Date(plan.eventAt)) : 'undated';
      const previous = items[index - 1];
      const previousDay = previous?.eventAt
        ? localDateValue(new Date(previous.eventAt))
        : 'undated';
      const title = plan.eventTitle || plan.destination;
      const scheduled = scheduledIds.includes(plan.id);
      const expired = !!plan.route && Date.parse(plan.route.expiresAt) <= now;
      const previousDepartureDay =
        departure &&
        plan.eventAt &&
        localDateValue(departure) !== localDateValue(new Date(plan.eventAt));
      return (
        <View key={plan.id} style={s.groupItem} testID={`trip-plan-${plan.id}`}>
          {(index === 0 || day !== previousDay) && (
            <Text accessibilityRole="header" style={s.dateHeading}>
              {plan.eventAt ? dateLabel(plan.eventAt, true) : '날짜 미정'}
            </Text>
          )}
          <Card style={s.plan}>
            <View style={s.cardTop}>
              <View style={s.badges}>
                {plan.source === 'sample' && <Chip label="예시 일정" />}
                <Text style={s.vehicleName}>
                  {state.vehicles.find((item) => item.id === plan.vehicleId)?.name || '차량 없음'}
                </Text>
              </View>
              <View style={s.row}>
                {Platform.OS === 'web' ? (
                  <Text style={s.small}>출발 알림 · 앱에서 설정</Text>
                ) : (
                  <View style={s.notification}>
                    <Text style={s.small}>{notificationsReady ? '출발 알림' : '알림 확인 중'}</Text>
                    <Switch
                      accessibilityLabel={`${title} 출발 알림`}
                      value={scheduled}
                      disabled={
                        !notificationsReady ||
                        busy !== null ||
                        (!scheduled && (!departure || departure.getTime() <= now))
                      }
                      onValueChange={() => void toggleNotification(plan)}
                      trackColor={{ false: C.line, true: C.primary }}
                      style={s.switch}
                    />
                  </View>
                )}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${title} 더 보기`}
                  accessibilityState={{ expanded: menu === plan.id }}
                  aria-expanded={menu === plan.id}
                  onPress={() => {
                    setMenu(menu === plan.id ? null : plan.id);
                    setDeleting(null);
                  }}
                  disabled={busy !== null}
                  style={s.iconButton}
                >
                  <Icon name="more-horizontal" size={20} color={C.muted} />
                </Pressable>
              </View>
            </View>
            <View style={[s.planContent, compact && s.planContentCompact]}>
              <View style={s.planSummary}>
                <Text style={s.planTitle}>{title}</Text>
                <Text style={s.routeText}>
                  {plan.origin} → {plan.destination}
                </Text>
                <Text style={s.small}>
                  {plan.distanceKm !== undefined
                    ? `${plan.distanceKm.toLocaleString('ko-KR', { maximumFractionDigits: 1 })} km · `
                    : ''}
                  운전 약 {plan.driveMinutes}분 · 도보 {plan.walkMinutes}분 · 여유{' '}
                  {plan.bufferMinutes}분
                </Text>
              </View>
              <View style={[s.times, compact && s.timesCompact]}>
                <Text style={s.arrival}>
                  {plan.eventAt ? `${timeLabel(plan.eventAt)} 도착` : '도착 시간 미정'}
                </Text>
                <Text style={s.departureTime}>
                  {departure ? `${timeLabel(departure)} 권장 출발` : '출발 시간 미정'}
                </Text>
                {previousDepartureDay && departure && (
                  <Text style={s.departureDate}>{dateLabel(departure)} 출발</Text>
                )}
              </View>
            </View>
            <View style={[s.cardFooter, compact && s.cardFooterCompact]}>
              <Text style={[s.evidence, compact && s.evidenceCompact]}>
                {plan.route
                  ? `${plan.route.source === 'mock' ? '예시 경로' : '서버 경로'} · ${dateLabel(plan.route.computedAt)} ${timeLabel(plan.route.computedAt)} 조회${expired ? ' · 유효 시간 지남' : ''}`
                  : '입력한 예상 시간 기준 · 실시간 교통 미반영'}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${title} 이동 계획 보기`}
                onPress={() => router.push({ pathname: '/route', params: { id: plan.id } })}
                style={[s.textButton, compact && s.footerLink]}
              >
                <Text style={s.link}>계획 보기</Text>
                <Icon name="chevron-right" color={C.primary} size={16} />
              </Pressable>
            </View>
            {menu === plan.id && deleting !== plan.id && (
              <View style={s.menu}>
                <Button
                  title={`${title} 계획 삭제`}
                  icon="trash-2"
                  variant="ghost"
                  onPress={() => setDeleting(plan.id)}
                  disabled={busy !== null}
                />
              </View>
            )}
            {deleting === plan.id && (
              <View style={s.confirm}>
                <Text style={shared.muted}>이 이동 계획을 삭제할까요? 주행 기록은 유지돼요.</Text>
                <View style={s.actions}>
                  <View style={s.action}>
                    <Button
                      title="취소"
                      variant="ghost"
                      onPress={() => {
                        setDeleting(null);
                        setMenu(null);
                      }}
                      disabled={busy !== null}
                    />
                  </View>
                  <View style={s.action}>
                    <Button
                      title="계획 삭제"
                      variant="danger"
                      onPress={() => void removePlan(plan.id)}
                      loading={busy === plan.id}
                      disabled={busy !== null && busy !== plan.id}
                    />
                  </View>
                </View>
              </View>
            )}
          </Card>
        </View>
      );
    });
  }

  return (
    <Screen
      title="이동 계획"
      action={<Button title="새 계획" icon="plus" onPress={newPlan} testID="new-plan" />}
    >
      {recorder.activeTrip && (
        <Card style={s.liveCard}>
          <View style={shared.row}>
            <View style={s.liveDot} />
            <View style={s.planSummary}>
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
      <View style={s.toolbar}>
        <View style={s.tabs} accessibilityRole="tablist">
          {(['plans', 'history'] as const).map((value) => (
            <Pressable
              key={value}
              accessibilityRole="tab"
              accessibilityLabel={value === 'plans' ? '예정' : '완료'}
              accessibilityState={{ selected: tab === value }}
              aria-selected={tab === value}
              onPress={() => {
                setTab(value);
                setMenu(null);
                setDeleting(null);
              }}
              style={[s.tab, tab === value && s.tabSelected]}
            >
              <Text style={[s.tabText, tab === value && s.tabTextSelected]}>
                {value === 'plans' ? `예정 ${upcoming.length}` : '완료'}
              </Text>
            </Pressable>
          ))}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="일정으로 계획"
          onPress={() => router.push(state.vehicles.length ? '/plan?mode=calendar' : '/vehicle')}
          style={s.textButton}
        >
          <Icon name="calendar" size={16} color={C.primary} />
          <Text style={s.link}>일정으로 계획</Text>
        </Pressable>
      </View>
      {error && <Notice title="확인해 주세요" body={error} tone="error" />}
      {message && <Notice title="알림 설정" body={message} />}
      {tab === 'plans' ? (
        <View style={s.list}>
          {upcoming.length ? (
            renderPlans(upcoming)
          ) : (
            <Card style={s.empty}>
              <Text style={shared.heading}>예정된 이동이 없어요</Text>
              <Text style={[shared.muted, s.center]}>
                도착 시간을 정하면 권장 출발 시간을 계산해요.
              </Text>
              <Button title="첫 이동 계획 만들기" variant="secondary" onPress={newPlan} />
            </Card>
          )}
        </View>
      ) : (
        <View style={s.list}>
          <SectionTitle title="완료한 주행" />
          {!trips.length && (
            <Card>
              <Text style={shared.muted}>
                아직 완료한 주행이 없어요. 이동 계획에서 직접 주행 기록을 시작할 수 있어요.
              </Text>
            </Card>
          )}
          {trips.map((trip, index) => (
            <View key={trip.id} style={s.groupItem}>
              {(index === 0 ||
                localDateValue(new Date(trip.startedAt)) !==
                  localDateValue(new Date(trips[index - 1].startedAt))) && (
                <Text accessibilityRole="header" style={s.dateHeading}>
                  {dateLabel(trip.startedAt, true)}
                </Text>
              )}
              <Card style={s.historyCard}>
                <View style={s.cardTop}>
                  <Text style={s.small}>
                    {timeLabel(trip.startedAt)} · {durationLabel(trip.durationSeconds)}
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
                  <View style={s.planSummary}>
                    <Text style={s.planTitle}>{trip.destination || '자유 주행'}</Text>
                    <Text style={s.vehicleName}>
                      {state.vehicles.find((item) => item.id === trip.vehicleId)?.name ||
                        '삭제한 차량'}
                    </Text>
                  </View>
                  <Text style={s.distance}>
                    {trip.distanceKm.toFixed(2)}
                    <Text style={s.small}> km</Text>
                  </Text>
                </View>
                {trip.source === 'sample' && (
                  <Text style={s.small}>체험용 기록 · 누적 주행거리에 반영하지 않아요.</Text>
                )}
                {trip.planId && state.plans.some((plan) => plan.id === trip.planId) && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${trip.destination || '자유 주행'}의 이동 계획 보기`}
                    onPress={() =>
                      router.push({ pathname: '/route', params: { id: trip.planId! } })
                    }
                    style={s.textButton}
                  >
                    <Text style={s.link}>연결된 계획 보기</Text>
                    <Icon name="chevron-right" color={C.primary} size={16} />
                  </Pressable>
                )}
              </Card>
            </View>
          ))}
          {pastPlans.length > 0 && (
            <>
              <SectionTitle title="지난 일정" />
              <Text style={s.small}>
                도착 시간이 지난 계획이에요. 실제 주행 완료 여부와는 별개예요.
              </Text>
              {renderPlans(pastPlans)}
            </>
          )}
        </View>
      )}
      <View style={s.notes}>
        <Text style={s.small}>
          새 계획에 사용할 차량: {vehicle?.name || '차량을 등록해 주세요'}
        </Text>
        <Text style={s.small}>
          저장된 경로는 자동 갱신되지 않아요. 출발 전에 교통 상황을 다시 확인해 주세요.
        </Text>
        <View style={s.secondaryLinks}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="출발 알림 보기"
            onPress={() => router.push('/notifications')}
            style={s.textButton}
          >
            <Icon name="bell" size={15} color={C.primary} />
            <Text style={s.link}>출발 알림</Text>
          </Pressable>
          {Platform.OS === 'web' && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="내 기기 위치 보기"
              onPress={() => router.push('/route')}
              style={s.textButton}
            >
              <Icon name="map-pin" size={15} color={C.primary} />
              <Text style={s.link}>내 기기 위치 보기</Text>
            </Pressable>
          )}
        </View>
        {Platform.OS === 'web' && (
          <Text style={s.small}>
            {session
              ? '내 기기 위치는 직접 시작한 동안만 같은 계정에 공유해요.'
              : '기기 간 위치 확인은 로그인 후 사용할 수 있어요.'}
          </Text>
        )}
      </View>
    </Screen>
  );
}

const s = StyleSheet.create({
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    flexWrap: 'wrap',
    borderBottomWidth: 1,
    borderBottomColor: C.line,
  },
  tabs: { flexDirection: 'row', gap: 6 },
  tab: {
    minHeight: 48,
    minWidth: 66,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderBottomWidth: 3,
    borderBottomColor: 'transparent',
  },
  tabSelected: { borderBottomColor: C.primary },
  tabText: { color: C.muted, fontSize: 15, fontWeight: '600' },
  tabTextSelected: { color: C.primary, fontWeight: '800' },
  list: { gap: 18 },
  groupItem: { gap: 10 },
  dateHeading: { color: C.ink, fontSize: 14, fontWeight: '700', marginTop: 4 },
  plan: { gap: 12, padding: 18 },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    columnGap: 8,
  },
  badges: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', flexShrink: 1, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
  notification: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  switch: { minWidth: 48, minHeight: 44 },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  planContent: { flexDirection: 'row', alignItems: 'center', gap: 18 },
  planContentCompact: { flexDirection: 'column', alignItems: 'stretch', gap: 14 },
  planSummary: { flex: 1, minWidth: 0, gap: 5 },
  planTitle: { color: C.ink, fontSize: 18, lineHeight: 26, fontWeight: '700' },
  routeText: { color: C.ink, fontSize: 14, lineHeight: 21 },
  vehicleName: { color: C.muted, fontSize: 12, lineHeight: 19, flexShrink: 1 },
  small: { color: C.muted, fontSize: 12, lineHeight: 19 },
  times: { alignItems: 'flex-end', gap: 4 },
  timesCompact: {
    alignItems: 'flex-start',
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: C.line,
  },
  arrival: { color: C.ink, fontSize: 16, lineHeight: 24, fontWeight: '700' },
  departureTime: { color: C.primary, fontSize: 16, lineHeight: 24, fontWeight: '700' },
  departureDate: { color: C.primary, fontSize: 12, lineHeight: 19 },
  cardFooter: {
    borderTopWidth: 1,
    borderTopColor: C.line,
    paddingTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  evidence: { color: C.muted, fontSize: 12, lineHeight: 19, flex: 1, minWidth: 145 },
  cardFooterCompact: { flexDirection: 'column', alignItems: 'stretch', gap: 0 },
  evidenceCompact: { flex: 0 },
  footerLink: { alignSelf: 'flex-end' },
  textButton: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    paddingHorizontal: 3,
  },
  link: { color: C.primary, fontSize: 13, lineHeight: 20, fontWeight: '600' },
  menu: { borderTopWidth: 1, borderTopColor: C.line, paddingTop: 8, alignItems: 'flex-end' },
  confirm: { gap: 12, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 14 },
  actions: { flexDirection: 'row', gap: 10 },
  action: { flex: 1 },
  empty: { alignItems: 'center', gap: 14, paddingVertical: 30 },
  center: { textAlign: 'center' },
  historyCard: { gap: 12 },
  historyMain: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 14 },
  distance: { color: C.ink, fontSize: 22, fontWeight: '700' },
  notes: { gap: 6, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 16 },
  secondaryLinks: { flexDirection: 'row', flexWrap: 'wrap', gap: 20 },
  liveCard: { gap: 14, borderColor: C.primary },
  liveDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: C.primary },
});
