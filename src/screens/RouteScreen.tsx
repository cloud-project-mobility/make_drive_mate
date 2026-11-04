import React, { useState } from 'react';
import { Linking, Modal, Platform, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
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
import { GPS_MAX_ACCURACY_METERS } from '../domain/gps';
import type { ActiveTrip } from '../domain/types';
import { useTripRecorder } from '../services/useTripRecorder';
import { dateLabel, durationLabel, RouteStops, TimeBreakdown, timeLabel } from './tripParts';
import { useNow } from './useNow';
import { mapsUrl } from '../domain/routing';
import LiveLocationCard from '../components/LiveLocationCard';

export default function RouteScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { state } = useApp();
  const now = useNow();
  const recorder = useTripRecorder();
  const [feedback, setFeedback] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'finish' | 'cancel' | null>(null);
  const [completed, setCompleted] = useState(false);
  const [savedTrip, setSavedTrip] = useState<ActiveTrip | null>(null);
  const requestedPlan = state.plans.find((item) => item.id === id);
  const active = recorder.activeTrip;
  const boundTrip = active || savedTrip;
  const candidatePlan = boundTrip
    ? state.plans.find((item) => item.id === boundTrip.planId)
    : requestedPlan;
  const plan =
    candidatePlan &&
    (!boundTrip ||
      (candidatePlan.id === boundTrip.planId &&
        candidatePlan.vehicleId === boundTrip.vehicleId &&
        candidatePlan.origin === boundTrip.origin &&
        candidatePlan.destination === boundTrip.destination))
      ? candidatePlan
      : undefined;
  const vehicle = state.vehicles.find(
    (item) => item.id === (boundTrip?.vehicleId || plan?.vehicleId || state.selectedVehicleId),
  );
  const origin = boundTrip ? boundTrip.origin : plan?.origin;
  const destination = boundTrip ? boundTrip.destination : plan?.destination;
  const mapLink =
    origin && destination
      ? mapsUrl({
          origin,
          destination,
          originPoint: plan?.originPoint,
          destinationPoint: plan?.destinationPoint,
        })
      : null;
  const hasMapDirections = mapLink?.startsWith('https://map.kakao.com/link/by/car/') ?? false;
  const departure = plan ? departureAt(plan) : null;
  const recording = recorder.status === 'recording';
  const requesting = recorder.status === 'requesting';
  async function start() {
    if (!vehicle) {
      setFeedback('주행을 기록할 차량을 먼저 등록해 주세요.');
      return;
    }
    setFeedback(null);
    setCompleted(false);
    setSavedTrip(null);
    const result = await recorder.start(vehicle.id, {
      origin,
      destination,
      ...(plan ? { planId: plan.id } : {}),
    });
    if (!result.ok) setFeedback(result.error);
  }
  async function resume() {
    setFeedback(null);
    const result = await recorder.resume();
    if (!result.ok) setFeedback(result.error);
  }
  function finish() {
    const snapshot = active
      ? { ...active, distanceKm: recorder.distanceKm, durationSeconds: recorder.durationSeconds }
      : null;
    const result = recorder.finish();
    if (!result.ok) {
      setFeedback(result.error);
      return;
    }
    setConfirm(null);
    setSavedTrip(snapshot);
    setCompleted(true);
  }
  async function openMaps() {
    if (!mapLink) return;
    if (recording) recorder.pause();
    try {
      await Linking.openURL(mapLink);
    } catch {
      setFeedback('카카오맵을 열지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.');
    }
  }
  const footer = completed ? (
    <Button
      title="저장한 주행 기록 보기"
      icon="check-circle"
      onPress={() => router.replace({ pathname: '/(tabs)/trips', params: { view: 'history' } })}
    />
  ) : active ? (
    <View style={s.actions}>
      <View style={s.action}>
        <Button
          title={recording ? '일시 정지' : '기록 재개'}
          icon={recording ? 'pause' : 'play'}
          variant="secondary"
          onPress={recording ? recorder.pause : resume}
          loading={requesting}
        />
      </View>
      <View style={s.action}>
        <Button
          title="종료하고 저장"
          icon="square"
          onPress={() => setConfirm('finish')}
          disabled={requesting}
          testID="finish-trip"
        />
      </View>
    </View>
  ) : (
    <Button
      title={vehicle ? `${vehicle.name} · GPS 기록 시작` : '차량 등록하고 시작'}
      icon="play"
      onPress={vehicle ? start : () => router.push('/vehicle')}
      loading={requesting}
      testID="start-trip"
    />
  );
  if (id && !plan && !active)
    return (
      <Screen back title="이동 계획을 찾을 수 없어요">
        <Notice title="삭제되었거나 저장되지 않은 계획이에요" />
        <Button
          title="이동 계획으로 돌아가기"
          onPress={() => router.replace({ pathname: '/(tabs)/trips', params: { view: 'history' } })}
        />
      </Screen>
    );
  return (
    <Screen
      back
      title={destination ? `${destination}으로 이동` : '자유 주행 기록'}
      eyebrow={active ? 'YOUR DRIVE, IN PROGRESS' : 'READY WHEN YOU ARE'}
      subtitle={active ? '이동한 만큼, 정확하게 남겨요.' : '계획을 확인하고 편안하게 출발하세요.'}
      footer={footer}
    >
      {requesting && (
        <Button
          title="위치 요청 취소"
          variant="ghost"
          onPress={() => {
            recorder.cancel();
            setFeedback(null);
          }}
        />
      )}
      {completed && (
        <Notice
          title="주행 기록을 저장했어요"
          body="측정한 거리와 시간을 주행 기록에서 확인할 수 있어요. 차량 누적 주행거리에도 반영했어요."
        />
      )}
      {active && requestedPlan && requestedPlan.id !== plan?.id && (
        <Notice
          title="먼저 시작한 주행을 표시하고 있어요"
          body="다른 이동 계획을 시작하려면 진행 중인 기록을 먼저 저장하거나 취소해 주세요. 기록할 차량과 출발·도착지는 처음 시작한 값으로 유지해요."
        />
      )}
      {(feedback || recorder.error) && (
        <Card style={shared.stack}>
          <Notice
            title="잠시 확인해 주세요"
            body={feedback || recorder.error || undefined}
            tone="error"
          />
          {Platform.OS === 'web' ? (
            <Text style={shared.muted}>
              브라우저 주소창의 사이트 설정에서 위치 권한을 허용한 뒤 다시 시작해 주세요. 위치
              측정에는 HTTPS 또는 localhost가 필요해요.
            </Text>
          ) : (
            <Button
              title="기기 권한 설정 열기"
              variant="secondary"
              icon="settings"
              onPress={() => {
                Linking.openSettings().catch(() =>
                  setFeedback('기기 설정에서 DriveMate의 위치 권한을 직접 허용해 주세요.'),
                );
              }}
            />
          )}
        </Card>
      )}
      <Modal
        visible={confirm !== null && !!active}
        transparent
        animationType="fade"
        onRequestClose={() => setConfirm(null)}
      >
        <View style={s.modalBackdrop}>
          <Card style={s.modalCard}>
            {confirm === 'finish' ? (
              <>
                <Text accessibilityRole="header" style={shared.heading}>
                  주행을 마칠까요?
                </Text>
                <Text style={shared.muted}>
                  {vehicle?.name}에 {recorder.distanceKm.toFixed(2)} km와{' '}
                  {durationLabel(recorder.durationSeconds)}을 저장해요. 이 거리가 누적 주행거리에
                  더해져요.
                </Text>
                <Button
                  title="주행 종료 · 기록 저장"
                  icon="check"
                  onPress={finish}
                  testID="confirm-save-trip"
                />
                <Button title="계속 기록하기" variant="ghost" onPress={() => setConfirm(null)} />
              </>
            ) : (
              <>
                <Text accessibilityRole="header" style={shared.heading}>
                  측정한 내용을 버릴까요?
                </Text>
                <Text style={shared.muted}>이번 주행의 거리와 시간은 저장되지 않아요.</Text>
                <Button
                  title="측정 내용 버리기"
                  variant="danger"
                  onPress={() => {
                    recorder.cancel();
                    setConfirm(null);
                  }}
                />
                <Button title="돌아가기" variant="ghost" onPress={() => setConfirm(null)} />
              </>
            )}
          </Card>
        </View>
      </Modal>
      <View style={s.columns}>
        <View style={s.main}>
          <LiveLocationCard />
          {origin && destination ? (
            <Card style={s.routeCard}>
              <View style={s.diagram}>
                <View style={s.gridLineOne} />
                <View style={s.gridLineTwo} />
                <View style={s.gridLineThree} />
                <View style={s.diagramLabel}>
                  <Icon name="map" size={14} color={C.muted} />
                  <Text style={s.diagramLabelText}>경로 개요 · 실제 지도 아님</Text>
                </View>
                <View style={s.routeLine} />
                <View style={s.pointStart}>
                  <View style={s.pointCircle}>
                    <View style={s.pointInner} />
                  </View>
                  <View style={s.pointTag}>
                    <Text style={s.pointLabel}>출발</Text>
                    <Text style={s.pointText} numberOfLines={2}>
                      {origin}
                    </Text>
                  </View>
                </View>
                <View style={s.pointEnd}>
                  <View style={s.destinationPin}>
                    <Icon name="map-pin" size={22} color="#FFF" />
                  </View>
                  <View style={s.pointTag}>
                    <Text style={s.pointLabel}>도착</Text>
                    <Text style={s.pointText} numberOfLines={2}>
                      {destination}
                    </Text>
                  </View>
                </View>
                <View style={s.schematicNote}>
                  <Text style={s.schematicNoteText}>
                    실제 도로·거리·교통 정보는 지도 앱에서 확인
                  </Text>
                </View>
              </View>
              <View style={s.routeBody}>
                <RouteStops origin={origin} destination={destination} />
                <Button
                  title={hasMapDirections ? '카카오맵에서 길안내' : '카카오맵에서 목적지 검색'}
                  variant="secondary"
                  icon="external-link"
                  onPress={openMaps}
                  testID="open-maps"
                />
                <Text style={shared.muted}>
                  {hasMapDirections
                    ? '카카오맵 앱 또는 웹에서 선택한 출발지와 도착지의 자동차 경로를 열어요.'
                    : '장소 좌표가 없어 카카오맵에서 목적지를 검색해요. 정확한 장소와 출발지를 선택해 주세요.'}
                  {active
                    ? ' 다른 앱으로 전환하면 거리 측정은 일시 정지돼요.'
                    : ' 이동 시간은 실제 경로를 확인한 뒤 판단해 주세요.'}
                </Text>
              </View>
            </Card>
          ) : (
            <Card style={s.freeDrive}>
              <View style={s.freeIcon}>
                <Icon name="navigation" size={40} color={C.primary} />
              </View>
              <Text style={s.freeTitle}>목적지 없이, 가볍게.</Text>
              <Text style={[shared.muted, { textAlign: 'center' }]}>
                위치 권한을 허용하고 시작하면{'\n'}앱을 보고 있는 동안 실제 이동 거리를 기록해요.
              </Text>
              <Button
                title="도착 시간과 경로도 계획하기"
                variant="secondary"
                onPress={() => router.push('/plan')}
              />
            </Card>
          )}
          {plan && (
            <Card style={shared.stack}>
              <View style={[shared.between, { flexWrap: 'wrap' }]}>
                <SectionTitle title={plan.eventTitle || '도착 계획'} />
                {plan.source === 'sample' && <Chip label="예시 일정 또는 경로" />}
              </View>
              <TimeBreakdown
                drive={plan.driveMinutes}
                walk={plan.walkMinutes}
                buffer={plan.bufferMinutes}
              />
              <View style={s.schedule}>
                <View style={s.scheduleItem}>
                  <Text style={shared.muted}>권장 출발</Text>
                  <Text style={s.scheduleTime}>{departure ? timeLabel(departure) : '—'}</Text>
                  <Text style={s.scheduleDate}>
                    {departure ? dateLabel(departure) : '시간 미정'}
                  </Text>
                </View>
                <View style={s.scheduleArrow}>
                  <Icon name="arrow-right" color={C.muted} />
                </View>
                <View style={s.scheduleItem}>
                  <Text style={shared.muted}>도착 목표</Text>
                  <Text style={s.scheduleTime}>{plan.eventAt ? timeLabel(plan.eventAt) : '—'}</Text>
                  <Text style={s.scheduleDate}>
                    {plan.eventAt ? dateLabel(plan.eventAt) : '시간 미정'}
                  </Text>
                </View>
              </View>
              {departure && departure.getTime() < now && (
                <Notice
                  title="권장 출발 시간이 지났어요"
                  body="현재 교통 상황을 확인하고 도착 시간을 다시 판단해 주세요."
                  tone="warning"
                />
              )}
              <Text style={shared.muted}>
                {plan.route
                  ? `${plan.route.source === 'mock' ? '예시 경로' : '서버 경로'}를 ${new Date(plan.route.computedAt).toLocaleString('ko-KR')}에 계산해 저장했어요. 자동으로 갱신되지 않아요.`
                  : '입력한 예상 시간으로 계산했어요. 실시간 교통이나 자동 경로 갱신은 제공하지 않아요.'}
              </Text>
              {plan.route && now >= Date.parse(plan.route.expiresAt) && (
                <Notice
                  title="저장한 경로의 유효 시간이 지났어요"
                  body="현재 교통 상황을 반영한 시간이 아니에요. 지도 앱에서 다시 확인하거나 새 이동 계획에서 경로를 계산해 주세요."
                  tone="warning"
                />
              )}
              <Button
                title="출발 알림 관리"
                icon="bell"
                variant="ghost"
                onPress={() => router.push('/notifications')}
              />
            </Card>
          )}
        </View>
        <View style={s.side}>
          <Card style={[s.recorder, active && { borderColor: C.primary }]}>
            <View style={shared.between}>
              <Chip
                label={
                  recording
                    ? 'GPS 측정 중'
                    : active
                      ? '기록 일시 정지'
                      : completed
                        ? '저장한 주행'
                        : '주행 기록 준비'
                }
                icon={recording ? 'radio' : 'activity'}
                selected={!!active}
              />
              <Icon name="navigation" color={C.primary} />
            </View>
            <Text style={s.distance}>
              {(savedTrip?.distanceKm ?? recorder.distanceKm).toFixed(2)}
              <Text style={s.distanceUnit}> km</Text>
            </Text>
            <Text style={shared.muted}>이번 주행에서 측정한 거리</Text>
            <View style={s.divider} />
            <View style={shared.between}>
              <Text style={shared.muted}>기록 시간</Text>
              <Text style={s.metricValue}>
                {durationLabel(savedTrip?.durationSeconds ?? recorder.durationSeconds)}
              </Text>
            </View>
            <View style={shared.between}>
              <Text style={shared.muted}>기록할 차량</Text>
              <Text style={s.metricValue}>{vehicle?.name || '등록 필요'}</Text>
            </View>
            <View style={shared.between}>
              <Text style={shared.muted}>위치 정확도</Text>
              <Text style={s.metricValue}>
                {recorder.accuracy == null ? '측정 대기' : `약 ${Math.round(recorder.accuracy)}m`}
              </Text>
            </View>
            {active && !recording && (
              <Notice
                title="기록을 잠시 멈췄어요"
                body="정지한 동안 이동한 거리는 포함하지 않아요. 준비되면 기록을 재개해 주세요."
              />
            )}
            {recording && recorder.accuracy == null && (
              <Text style={shared.muted}>
                첫 위치를 확인하고 있어요. 하늘이 보이는 곳에서 잠시 기다려 주세요.
              </Text>
            )}
            {recorder.accuracy != null && recorder.accuracy > GPS_MAX_ACCURACY_METERS && (
              <Notice
                title="위치 신호가 약해요"
                body="정확도가 낮은 위치는 거리 계산에서 제외될 수 있어요."
                tone="warning"
              />
            )}
          </Card>
          <Card style={shared.stack}>
            <View style={shared.row}>
              <Icon name="shield" color={C.primary} />
              <Text style={shared.heading}>직접 시작하고, 직접 저장</Text>
            </View>
            <Text style={shared.muted}>
              기록 시작을 누를 때 위치 권한을 요청해요. 앱이 화면에서 벗어나면 측정을 멈춰요.
            </Text>
            <Text style={shared.muted}>
              잠금 화면이나 내비게이션 앱을 사용하는 동안에는 거리를 계속 측정하지 않아요. 측정하지
              못한 구간은 추정해서 더하지 않아요.
            </Text>
            <Text style={shared.muted}>
              운전 중에는 기기를 조작하지 말고 안전한 곳에 정차한 후 사용해 주세요.
            </Text>
          </Card>
          {active && (
            <Button title="이번 측정 취소" variant="ghost" onPress={() => setConfirm('cancel')} />
          )}
        </View>
      </View>
    </Screen>
  );
}
const s = StyleSheet.create({
  modalBackdrop: {
    flex: 1,
    backgroundColor: '#17343299',
    padding: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCard: { width: '100%', maxWidth: 430, gap: 18 },
  columns: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: 20 },
  main: { flex: 1.2, minWidth: 280, gap: 20 },
  side: { flex: 1, minWidth: 280, gap: 20 },
  routeCard: { padding: 0, overflow: 'hidden' },
  routeBody: { gap: 18, padding: 22 },
  diagram: { height: 270, backgroundColor: '#EAF1EA', overflow: 'hidden' },
  gridLineOne: {
    position: 'absolute',
    width: '170%',
    height: 26,
    left: '-20%',
    top: 108,
    backgroundColor: '#FBFCF8',
    transform: [{ rotate: '-28deg' }],
  },
  gridLineTwo: {
    position: 'absolute',
    width: 20,
    height: 390,
    backgroundColor: '#FBFCF8',
    left: '57%',
    top: -60,
    transform: [{ rotate: '-28deg' }],
  },
  gridLineThree: {
    position: 'absolute',
    width: '120%',
    height: 15,
    left: '-10%',
    top: 194,
    backgroundColor: '#FBFCF8',
    transform: [{ rotate: '-28deg' }],
  },
  diagramLabel: {
    alignSelf: 'flex-start',
    margin: 16,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: '#FFFFFFE8',
    borderRadius: 9,
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
  },
  diagramLabelText: { color: C.muted, fontSize: 10, fontWeight: '600' },
  routeLine: {
    position: 'absolute',
    height: 92,
    width: '54%',
    left: '20%',
    top: 100,
    borderLeftWidth: 5,
    borderBottomWidth: 5,
    borderColor: C.primary,
    borderBottomLeftRadius: 26,
  },
  pointStart: {
    position: 'absolute',
    top: 77,
    left: '14%',
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    maxWidth: '75%',
  },
  pointCircle: {
    height: 32,
    width: 32,
    borderRadius: 16,
    backgroundColor: 'white',
    borderWidth: 2,
    borderColor: C.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pointInner: { width: 11, height: 11, borderRadius: 6, backgroundColor: C.primary },
  pointTag: {
    backgroundColor: '#FFFFFFF0',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    maxWidth: 170,
    flexShrink: 1,
  },
  pointLabel: { fontSize: 9, color: C.muted, marginBottom: 3 },
  pointText: { fontSize: 12, color: C.ink, fontWeight: '700', lineHeight: 17 },
  pointEnd: {
    position: 'absolute',
    top: 158,
    left: '55%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    maxWidth: '44%',
  },
  destinationPin: {
    width: 37,
    height: 42,
    backgroundColor: C.primary,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  schematicNote: {
    position: 'absolute',
    bottom: 12,
    alignSelf: 'center',
    backgroundColor: '#F9FCF5E8',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  schematicNoteText: { fontSize: 9, color: C.muted },
  freeDrive: { alignItems: 'center', gap: 20, paddingVertical: 42 },
  freeIcon: {
    width: 90,
    height: 90,
    backgroundColor: C.mint,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  freeTitle: { color: C.ink, fontWeight: '800', fontSize: 26 },
  schedule: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  scheduleItem: { flex: 1, gap: 6 },
  scheduleArrow: { width: 26 },
  scheduleTime: { fontSize: 31, color: C.ink, fontWeight: '800' },
  scheduleDate: { fontSize: 11, color: C.muted },
  recorder: { gap: 17 },
  distance: { color: C.ink, fontSize: 56, fontWeight: '800', letterSpacing: -2, marginTop: 12 },
  distanceUnit: { color: C.muted, fontSize: 17, fontWeight: '500', letterSpacing: 0 },
  divider: { height: 1, backgroundColor: C.line, marginVertical: 4 },
  metricValue: { color: C.ink, fontSize: 13, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  actions: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  action: { flex: 1, minWidth: 130 },
  confirm: { gap: 15, borderColor: C.primary, backgroundColor: '#F2F8F5' },
});
