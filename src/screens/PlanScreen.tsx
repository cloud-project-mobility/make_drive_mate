import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
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
import { createId, departureAt, parseNonNegativeNumber } from '../domain/helpers';
import type { Coordinates, TripPlan } from '../domain/types';
import { dateLabel, localDateValue, localTimeValue, TimeBreakdown, timeLabel } from './tripParts';
import { useNow } from './useNow';
import { BackendRouteSearch, CalendarImport } from './BackendPlanTools';
import type { CalendarEvent, ProviderSource } from '../services/backend';
import { routeApplicationIssue, type AppliedRoute } from '../domain/routing';
import { localArrivalOptions, resolveArrival, utcOffsetLabel } from '../domain/planningTime';

export default function PlanScreen() {
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const calendar = mode === 'calendar';
  const { state, dispatch } = useApp();
  const now = useNow();
  const [initialDate] = useState(() => new Date(Date.now() + 2 * 60 * 60_000));
  const [vehicleId, setVehicleId] = useState(
    state.selectedVehicleId || state.vehicles[0]?.id || '',
  );
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [originPoint, setOriginPoint] = useState<Coordinates | undefined>();
  const [destinationPoint, setDestinationPoint] = useState<Coordinates | undefined>();
  const [eventTitle, setEventTitle] = useState('');
  const [date, setDate] = useState(localDateValue(initialDate));
  const [time, setTime] = useState(localTimeValue(initialDate));
  const [arrivalInstant, setArrivalInstant] = useState<string | null>(null);
  const [drive, setDrive] = useState('30');
  const [walk, setWalk] = useState(String(state.settings.walkMinutes));
  const [buffer, setBuffer] = useState(String(state.settings.bufferMinutes));
  const [sample, setSample] = useState(false);
  const [appliedRoute, setAppliedRoute] = useState<AppliedRoute | null>(null);
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [calendarMessage, setCalendarMessage] = useState('');
  function changeOrigin(value: string) {
    setOrigin(value);
    setOriginPoint(undefined);
    setSelectionRevision((revision) => revision + 1);
  }
  function changeDestination(value: string) {
    setDestination(value);
    setDestinationPoint(undefined);
    setSelectionRevision((revision) => revision + 1);
  }
  function importEvent(event: CalendarEvent, source: ProviderSource) {
    setEventTitle(event.title);
    changeDestination(event.location || '');
    setSample((previous) => previous || source === 'mock');
    if (event.all_day && event.start_date) {
      setArrivalInstant(null);
      setDate(event.start_date);
      setTime('');
      setCalendarMessage('종일 일정이에요. 실제 도착 시간을 직접 입력해 주세요.');
    } else if (event.start_at) {
      setArrivalInstant(event.start_at);
      const start = new Date(event.start_at);
      setDate(localDateValue(start));
      setTime(localTimeValue(start));
      setCalendarMessage(
        '일정의 원래 시각과 장소를 가져왔어요. 날짜나 시간을 수정하면 직접 입력한 현지 시각으로 바뀌어요.',
      );
    }
    setErrors({});
  }
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const arrivalOptions = localArrivalOptions(date, time);
  const eventDate = resolveArrival(date, time, arrivalInstant);
  const driveValue = parseNonNegativeNumber(drive, '운전 시간', 1440);
  const walkValue = parseNonNegativeNumber(walk, '도보 시간', 180);
  const bufferValue = parseNonNegativeNumber(buffer, '여유 시간', 180);
  const routeInputs = {
    origin,
    destination,
    arrivalAt: eventDate?.toISOString() ?? null,
    walkMinutes: walkValue.ok ? walkValue.value : null,
    bufferMinutes: bufferValue.ok ? bufferValue.value : null,
    selectionRevision,
  };
  const routeIssue = routeApplicationIssue(appliedRoute, routeInputs, now);
  const hasValidMinutes =
    driveValue.ok && driveValue.value > 0 && walkValue.ok && bufferValue.ok && !routeIssue;
  const preview =
    eventDate && hasValidMinutes
      ? departureAt({
          eventAt: eventDate.toISOString(),
          driveMinutes: driveValue.value,
          walkMinutes: walkValue.value,
          bufferMinutes: bufferValue.value,
        })
      : null;
  const previousDay =
    !!preview && !!eventDate && localDateValue(preview) !== localDateValue(eventDate);
  function fillSample() {
    setAppliedRoute(null);
    setArrivalInstant(null);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(15, 0, 0, 0);
    changeOrigin('서울역');
    changeDestination('강남역');
    setEventTitle('강남 미팅');
    setDate(localDateValue(tomorrow));
    setTime('15:00');
    setDrive('80');
    setWalk('10');
    setBuffer('10');
    setSample(true);
    setErrors({});
  }
  function save() {
    if (saved) return;
    const next: Record<string, string> = {};
    if (!vehicleId || !state.vehicles.some((item) => item.id === vehicleId))
      next.vehicle = '이동할 차량을 선택해 주세요.';
    if (origin.trim().length < 2) next.origin = '출발지를 2자 이상 입력해 주세요.';
    if (destination.trim().length < 2) next.destination = '도착지를 2자 이상 입력해 주세요.';
    const distinctPoints =
      originPoint &&
      destinationPoint &&
      (originPoint.latitude !== destinationPoint.latitude ||
        originPoint.longitude !== destinationPoint.longitude);
    if (
      (origin.trim() && origin.trim() === destination.trim() && !distinctPoints) ||
      (originPoint && destinationPoint && !distinctPoints)
    )
      next.destination = '출발지와 다른 도착지를 입력해 주세요.';
    if (!eventDate)
      next.date =
        arrivalOptions.length > 1
          ? '이 현지 시각은 두 번 있어요. 아래에서 사용할 UTC 시차를 선택해 주세요.'
          : '날짜는 YYYY-MM-DD, 시간은 HH:MM 형식으로 입력해 주세요.';
    else if (eventDate.getTime() <= now) next.date = '지금보다 이후의 도착 시간을 입력해 주세요.';
    const currentRouteIssue = routeApplicationIssue(
      appliedRoute,
      routeInputs,
      new Date().getTime(),
    );
    if (currentRouteIssue) next.form = currentRouteIssue;
    if (!driveValue.ok) next.drive = driveValue.error;
    else if (!Number.isInteger(driveValue.value) || driveValue.value < 1)
      next.drive = '운전 시간은 1분 이상의 정수로 입력해 주세요.';
    if (!walkValue.ok) next.walk = walkValue.error;
    else if (!Number.isInteger(walkValue.value))
      next.walk = '도보 시간은 분 단위 정수로 입력해 주세요.';
    if (!bufferValue.ok) next.buffer = bufferValue.error;
    else if (!Number.isInteger(bufferValue.value))
      next.buffer = '여유 시간은 분 단위 정수로 입력해 주세요.';
    setErrors(next);
    if (
      Object.keys(next).length ||
      !eventDate ||
      !driveValue.ok ||
      !walkValue.ok ||
      !bufferValue.ok
    )
      return;
    const plan: TripPlan = {
      id: createId('plan'),
      vehicleId,
      origin: origin.trim(),
      destination: destination.trim(),
      eventTitle: eventTitle.trim() || undefined,
      eventAt: eventDate.toISOString(),
      driveMinutes: driveValue.value,
      walkMinutes: walkValue.value,
      bufferMinutes: bufferValue.value,
      ...(originPoint ? { originPoint } : {}),
      ...(destinationPoint ? { destinationPoint } : {}),
      ...(appliedRoute && !routeIssue
        ? {
            distanceKm: appliedRoute.distanceKm,
            route: {
              source: appliedRoute.source,
              computedAt: appliedRoute.computedAt,
              expiresAt: appliedRoute.expiresAt,
            },
          }
        : {}),
      source: sample ? 'sample' : 'manual',
      createdAt: new Date().toISOString(),
    };
    const result = dispatch({ type: 'ADD_PLAN', plan });
    if (!result.ok) {
      setErrors({ form: result.error });
      return;
    }
    setSaved(true);
    router.replace({ pathname: '/route', params: { id: plan.id } });
  }
  return (
    <Screen
      back
      title={calendar ? '일정으로 계획' : '새 이동 계획'}
      eyebrow="PLAN YOUR NEXT DRIVE"
      subtitle="시간을 먼저 정하면 출발이 편해져요."
      footer={
        <Button
          title="계획 저장하고 확인"
          onPress={save}
          disabled={saved || !state.vehicles.length}
          icon="arrow-right"
          testID="save-plan"
        />
      }
    >
      {calendar && (
        <Card style={shared.stack}>
          <View style={[shared.between, { flexWrap: 'wrap' }]}>
            <View style={[shared.row, { flex: 1, minWidth: 230 }]}>
              <Icon name="calendar" color={C.primary} />
              <Text style={[shared.heading, { flexShrink: 1 }]}>
                일정 정보를 가져오거나 입력해요
              </Text>
            </View>
            <Chip label="직접 입력 또는 서버 가져오기" />
          </View>
          <Text style={shared.muted}>
            서버에서 가져온 일정은 출처를 표시해요. 장소와 도착 시간을 확인하고 출발지를 입력해
            주세요.
          </Text>
          <CalendarImport onSelect={importEvent} />
          <Button
            title="예시 일정으로 살펴보기"
            variant="secondary"
            onPress={fillSample}
            icon="eye"
          />
        </Card>
      )}
      {calendarMessage ? <Notice title={calendarMessage} /> : null}
      {sample && (
        <Notice
          title="예시 데이터가 포함된 계획이에요"
          body="실제 캘린더나 교통 데이터가 아니에요. 저장한 뒤에도 예시로 표시해요."
        />
      )}
      {errors.form && <Notice title={errors.form} tone="error" />}
      {!state.vehicles.length && (
        <Card style={shared.stack}>
          <Notice
            title="먼저 차량을 등록해 주세요"
            body="이동 계획과 주행 기록을 저장할 차량이 필요해요."
          />
          <Button title="차량 등록" onPress={() => router.push('/vehicle')} icon="plus" />
        </Card>
      )}
      <View style={s.columns}>
        <View style={s.main}>
          <Card style={shared.stack}>
            <SectionTitle title="01  함께 이동할 차량" />
            <View style={s.chips}>
              {state.vehicles.map((vehicle) => (
                <Chip
                  key={vehicle.id}
                  label={vehicle.name}
                  icon="truck"
                  selected={vehicleId === vehicle.id}
                  onPress={() => setVehicleId(vehicle.id)}
                />
              ))}
            </View>
            {errors.vehicle && <Text style={s.error}>{errors.vehicle}</Text>}
          </Card>
          <Card style={shared.stack}>
            <SectionTitle title="02  어디로 갈까요?" />
            <Field
              label="출발지"
              placeholder="예: 서울역, 서울 중구 한강대로 405"
              value={origin}
              onChangeText={changeOrigin}
              maxLength={160}
              error={errors.origin}
              testID="plan-origin"
              autoComplete="street-address"
            />
            <View style={s.stopDivider}>
              <View style={s.dashed} />
              <Icon name="arrow-down" size={16} color={C.primary} />
            </View>
            <Field
              label="도착지"
              placeholder="예: 강남역 2번 출구"
              value={destination}
              onChangeText={changeDestination}
              maxLength={160}
              error={errors.destination}
              testID="plan-destination"
            />
            <Text style={shared.muted}>
              주소를 저장한 뒤 실제 경로와 교통 상황은 지도 앱에서 확인할 수 있어요.
            </Text>
            <BackendRouteSearch
              origin={origin}
              destination={destination}
              arrivalAt={eventDate?.toISOString() ?? null}
              walkMinutes={walkValue.ok ? walkValue.value : null}
              bufferMinutes={bufferValue.ok ? bufferValue.value : null}
              onOrigin={changeOrigin}
              onDestination={changeDestination}
              selectionRevision={selectionRevision}
              onSelectionChanged={(kind, place, source) => {
                const point = { longitude: place.longitude, latitude: place.latitude };
                if (kind === 'origin') setOriginPoint(point);
                else setDestinationPoint(point);
                if (source === 'mock') setSample(true);
                setSelectionRevision((revision) => revision + 1);
              }}
              onEstimate={(estimate, from, to) => {
                setErrors({});
                setOriginPoint({ longitude: from.longitude, latitude: from.latitude });
                setDestinationPoint({ longitude: to.longitude, latitude: to.latitude });
                setDrive(String(Math.ceil(estimate.duration_s / 60)));
                setAppliedRoute({
                  inputs: routeInputs,
                  distanceKm: estimate.distance_m / 1000,
                  expiresAt: estimate.expires_at,
                  computedAt: estimate.computed_at,
                  source: estimate.source,
                });
                if (estimate.source === 'mock') setSample(true);
              }}
            />
          </Card>
          <Card style={shared.stack}>
            <SectionTitle title="03  언제 도착할까요?" />
            <Field
              label="일정 이름 (선택)"
              placeholder="예: 강남 미팅, 주말 나들이"
              value={eventTitle}
              onChangeText={setEventTitle}
              maxLength={60}
            />
            <View style={s.fields}>
              <View style={s.dateField}>
                <Field
                  label="도착 날짜"
                  placeholder="YYYY-MM-DD"
                  value={date}
                  onChangeText={(value) => {
                    setDate(value);
                    setArrivalInstant(null);
                  }}
                  maxLength={10}
                  testID="plan-date"
                />
              </View>
              <View style={s.timeField}>
                <Field
                  label="도착 시간 · 24시간"
                  placeholder="HH:MM"
                  value={time}
                  onChangeText={(value) => {
                    setTime(value);
                    setArrivalInstant(null);
                  }}
                  maxLength={5}
                  testID="plan-time"
                />
              </View>
            </View>
            {errors.date && (
              <Text accessibilityLiveRegion="polite" style={s.error}>
                {errors.date}
              </Text>
            )}
            {arrivalOptions.length > 1 && (
              <View style={shared.stack}>
                <Notice
                  title="시계가 뒤로 바뀌어 같은 시각이 두 번 있어요"
                  body="일정에서 가져온 시차는 그대로 유지해요. 직접 입력했다면 사용할 시차를 선택해 주세요."
                />
                {arrivalOptions.map((option) => (
                  <Button
                    key={option.toISOString()}
                    title={`${time} · ${utcOffsetLabel(option)} 선택`}
                    variant={
                      eventDate && eventDate.getTimezoneOffset() === option.getTimezoneOffset()
                        ? 'primary'
                        : 'secondary'
                    }
                    onPress={() => setArrivalInstant(option.toISOString())}
                  />
                ))}
              </View>
            )}
            <Text style={shared.muted}>현재 기기의 현지 시간을 기준으로 계산해요.</Text>
          </Card>
        </View>
        <View style={s.side}>
          <Card style={shared.stack}>
            <SectionTitle title="04  이동에 필요한 시간" />
            {routeIssue && <Notice title={routeIssue} tone="warning" />}
            <Field
              label="예상 운전 시간 (분)"
              keyboardType="number-pad"
              value={drive}
              onChangeText={(value) => {
                setDrive(value);
                setAppliedRoute(null);
                setSelectionRevision((revision) => revision + 1);
              }}
              error={errors.drive}
              hint={
                appliedRoute
                  ? '서버 계산을 적용한 시간이에요. 직접 입력하면 서버 경로와의 연결이 해제돼요.'
                  : '직접 예상한 시간이에요. 실시간 교통은 반영하지 않아요.'
              }
              maxLength={4}
              testID="plan-drive"
            />
            <View style={s.fields}>
              <View style={s.smallField}>
                <Field
                  label="주차 후 도보 (분)"
                  keyboardType="number-pad"
                  value={walk}
                  onChangeText={setWalk}
                  error={errors.walk}
                  maxLength={3}
                />
              </View>
              <View style={s.smallField}>
                <Field
                  label="여유 시간 (분)"
                  keyboardType="number-pad"
                  value={buffer}
                  onChangeText={setBuffer}
                  error={errors.buffer}
                  maxLength={3}
                />
              </View>
            </View>
          </Card>
          <Card style={s.preview}>
            <View style={shared.row}>
              <Icon name="clock" color={C.primary} />
              <Text style={s.previewLabel}>이때 출발하면 여유로워요</Text>
            </View>
            <Text style={s.previewTime}>{preview ? timeLabel(preview) : '— : —'}</Text>
            <Text style={s.previewDate}>
              {preview ? dateLabel(preview, true) : '날짜와 시간을 입력해 주세요'}
            </Text>
            {hasValidMinutes && (
              <TimeBreakdown
                drive={driveValue.value}
                walk={walkValue.value}
                buffer={bufferValue.value}
              />
            )}
            {previousDay && (
              <Notice
                title="전날 출발하는 일정이에요"
                body="출발 날짜를 함께 확인해 주세요."
                tone="warning"
              />
            )}
            {preview && preview.getTime() <= now && (
              <Notice
                title="권장 출발 시간이 지났어요"
                body="도착 시간이나 예상 이동 시간을 조정해 주세요."
                tone="warning"
              />
            )}
            <Text style={shared.muted}>
              예상 시간으로 계산한 계획이에요. 실제 교통 상황과 주차 여건에 따라 달라질 수 있어요.
            </Text>
          </Card>
        </View>
      </View>
    </Screen>
  );
}
const s = StyleSheet.create({
  columns: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: 20 },
  main: { flex: 1.2, minWidth: 280, gap: 20 },
  side: { flex: 1, minWidth: 280, gap: 20 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 9 },
  fields: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  dateField: { flex: 1.2, minWidth: 135 },
  timeField: { flex: 1, minWidth: 120 },
  smallField: { flex: 1, minWidth: 110 },
  stopDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 15,
    marginVertical: -8,
  },
  dashed: { width: 1, height: 15, backgroundColor: C.line },
  error: { fontSize: 12, color: C.red, lineHeight: 20 },
  preview: { backgroundColor: '#EEF7F3', borderColor: '#D1E6DC', gap: 15 },
  previewLabel: { color: C.primary, fontSize: 13, fontWeight: '600' },
  previewTime: { fontSize: 58, fontWeight: '800', color: C.ink, letterSpacing: -2 },
  previewDate: { color: C.primary, fontSize: 13, marginTop: -8 },
});
