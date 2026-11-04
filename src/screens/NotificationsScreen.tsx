import React, { useCallback, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Button, C, Card, Chip, Icon, Notice, Screen, shared } from '../components/ui';
import { useApp } from '../state/AppProvider';
import { departureAt } from '../domain/helpers';
import type { TripPlan } from '../domain/types';
import {
  cancelDeparture,
  listScheduledDepartures,
  scheduleDeparture,
} from '../services/notifications';
import { dateLabel, timeLabel } from './tripParts';
import { useNow } from './useNow';

export default function NotificationsScreen() {
  const { state } = useApp();
  const now = useNow();
  const [scheduledIds, setScheduledIds] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const plans = [...state.plans]
    .filter((plan) => !!plan.eventAt)
    .sort((a, b) => (a.eventAt || '').localeCompare(b.eventAt || ''));
  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      if (Platform.OS !== 'web')
        listScheduledDepartures()
          .then((items) => {
            if (mounted) setScheduledIds(items.map((item) => item.planId));
          })
          .catch(() => {
            if (mounted) setError('기기의 알림 상태를 불러오지 못했어요. 다시 방문해 주세요.');
          });
      return () => {
        mounted = false;
      };
    }, []),
  );
  async function toggle(plan: TripPlan) {
    setBusy(plan.id);
    setError(null);
    setMessage(null);
    try {
      if (scheduledIds.includes(plan.id)) {
        await cancelDeparture(plan.id);
        setScheduledIds((ids) => ids.filter((id) => id !== plan.id));
        setMessage('이 계획의 기기 출발 알림을 해제했어요.');
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
  return (
    <Screen
      back
      title="출발 알림"
      eyebrow="RIGHT ON TIME"
      subtitle="다음 이동을 잊지 않도록, 한곳에서."
    >
      <Card style={s.intro}>
        <View style={s.bell}>
          <Icon name="bell" size={28} color={C.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={shared.heading}>
            {Platform.OS === 'web' ? '내 출발 계획을 확인해요' : '필요한 일정만 알림을 켜요'}
          </Text>
          <Text style={shared.muted}>
            {Platform.OS === 'web'
              ? '웹에서는 기기 알림을 예약할 수 없어요. 모바일 앱에서 알림을 설정해 주세요.'
              : '알림 켜기를 누를 때 기기 권한을 요청해요. 알림을 허용하면 권장 출발 시간에 한 번 알려드려요.'}
          </Text>
        </View>
      </Card>
      {message && <Notice title="알림 설정을 변경했어요" body={message} />}
      {error && <Notice title="알림을 확인해 주세요" body={error} tone="error" />}
      {!plans.length ? (
        <Card style={s.empty}>
          <Icon name="sun" size={38} color={C.primary} />
          <Text style={shared.heading}>아직 예정된 이동이 없어요</Text>
          <Text style={[shared.muted, { textAlign: 'center' }]}>
            도착 시간이 있는 이동 계획을 만들면{'\n'}권장 출발 시간을 이곳에서 볼 수 있어요.
          </Text>
          <Button
            title="이동 계획 만들기"
            icon="plus"
            onPress={() => router.push(state.vehicles.length ? '/plan' : '/vehicle')}
          />
        </Card>
      ) : (
        plans.map((plan) => {
          const departure = departureAt(plan);
          const past = !departure || departure.getTime() <= now;
          const scheduled = scheduledIds.includes(plan.id);
          return (
            <Card key={plan.id} style={s.plan}>
              <View style={shared.between}>
                <View style={shared.row}>
                  <View style={[s.dot, past && { backgroundColor: C.line }]} />
                  <Text style={s.date}>{departure ? dateLabel(departure) : '시간 미정'}</Text>
                </View>
                <Chip
                  label={scheduled ? '기기 알림 켜짐' : past ? '출발 시간 지남' : '앱에서 확인'}
                  selected={scheduled}
                />
              </View>
              <View style={s.planBody}>
                <Text style={s.time}>{departure ? timeLabel(departure) : '—'}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={s.title}>{plan.eventTitle || plan.destination}</Text>
                  <Text style={shared.muted}>
                    {plan.destination} · {plan.eventAt ? timeLabel(plan.eventAt) : ''} 도착
                  </Text>
                </View>
              </View>
              {plan.source === 'sample' && <Chip label="예시 일정 · 내 캘린더와 연결되지 않음" />}
              <Text style={shared.muted}>
                운전 {plan.driveMinutes}분 + 도보 {plan.walkMinutes}분 + 여유 {plan.bufferMinutes}분
              </Text>
              <View style={s.actions}>
                <View style={s.action}>
                  <Button
                    title="이동 계획 열기"
                    variant="secondary"
                    icon="arrow-up-right"
                    onPress={() => router.push({ pathname: '/route', params: { id: plan.id } })}
                  />
                </View>
                {Platform.OS !== 'web' && (
                  <View style={s.action}>
                    <Button
                      title={scheduled ? '알림 해제' : '알림 켜기'}
                      icon={scheduled ? 'bell-off' : 'bell'}
                      variant="ghost"
                      loading={busy === plan.id}
                      disabled={(!scheduled && past) || (busy !== null && busy !== plan.id)}
                      onPress={() => toggle(plan)}
                      testID={`notification-${plan.id}`}
                    />
                  </View>
                )}
              </View>
            </Card>
          );
        })
      )}
      <Notice
        title="이동 계획에 적힌 시간을 기준으로 알려드려요"
        body="교통 상황 변화로 출발 시간을 자동 조정하지 않아요. 기기 알림은 운영체제의 알림·집중 모드 설정에 따라 표시가 늦어지거나 제한될 수 있어요."
      />
    </Screen>
  );
}
const s = StyleSheet.create({
  intro: { flexDirection: 'row', gap: 16, alignItems: 'center' },
  bell: {
    width: 58,
    height: 58,
    backgroundColor: C.mint,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: { alignItems: 'center', gap: 18, paddingVertical: 42 },
  plan: { gap: 16 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.primary },
  date: { fontSize: 12, color: C.muted },
  planBody: { flexDirection: 'row', gap: 22, alignItems: 'center', flexWrap: 'wrap' },
  time: { fontSize: 37, fontWeight: '800', color: C.primary, letterSpacing: -1 },
  title: { color: C.ink, fontSize: 19, fontWeight: '700', lineHeight: 27, marginBottom: 5 },
  actions: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  action: { flex: 1, minWidth: 130 },
});
