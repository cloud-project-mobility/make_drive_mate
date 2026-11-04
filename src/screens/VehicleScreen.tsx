import { useRef, useState } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Button, C, Card, Chip, Field, Notice, Screen, shared } from '../components/ui';
import { VehicleArt } from '../components/VehicleArt';
import { VehiclePhotoCredits } from '../components/VehiclePhotoCredits';
import { VehicleCatalogPicker } from '../components/VehicleCatalogPicker';
import { SettingsDisclosure } from '../components/SettingsDisclosure';
import { useApp } from '../state/AppProvider';
import { useBackend } from '../state/BackendProvider';
import { useVehicleCatalog } from '../state/VehicleCatalogProvider';
import { useMounted } from '../services/useMounted';
import { deleteRegisteredVehicle, saveRegisteredVehicle } from '../services/vehicleCatalog';
import { applyStateTransaction } from '../domain/stateTransaction';
import type { VehicleCatalogEntry } from '../domain/vehicleCatalog';
import { createId, parseNonNegativeNumber } from '../domain/helpers';
import { cancelDeparture } from '../services/notifications';
import type { AppAction, Powertrain, Vehicle } from '../domain/types';
import BackendVehicleStatus from './BackendVehicleStatus';
export default function VehicleScreen() {
  const { id, onboarding: onboardingParam } = useLocalSearchParams<{
    id?: string;
    onboarding?: string;
  }>();
  const onboarding = onboardingParam === '1';
  const { state, dispatch } = useApp();
  const { client, session, isCurrentClient } = useBackend();
  const { entries } = useVehicleCatalog();
  const isMounted = useMounted();
  const existing = state.vehicles.find((v) => v.id === id);
  const [name, setName] = useState(existing?.name ?? '');
  const [model, setModel] = useState(existing?.model ?? '');
  const [catalogId, setCatalogId] = useState(existing?.catalogId);
  const [year, setYear] = useState(existing?.model.match(/\b(?:19|20)\d{2}\b/)?.[0] ?? '');
  const [km, setKm] = useState(existing?.odometerKm.toString() ?? '');
  const [type, setType] = useState<Powertrain>(existing?.powertrain ?? 'ICE');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showCatalog, setShowCatalog] = useState(false);
  const busyRef = useRef(false);
  const draftIdentity = useRef({
    id: existing?.id ?? createId('vehicle'),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  });
  const selected = entries.find((entry) => entry.id === catalogId);
  const displayModel = selected ? `${selected.manufacturer} ${selected.model} · ${year}` : model;
  const locked = state.activeTrip?.vehicleId === existing?.id && !!existing;
  const disabled = locked || busy;
  function selectCatalog(entry: VehicleCatalogEntry) {
    setCatalogId(entry.id);
    if (!name.trim()) setName(`나의 ${entry.model}`);
    if (!entry.powertrains.includes(type)) setType(entry.powertrains[0]);
    if (Number(year) < entry.yearFrom || (entry.yearTo !== null && Number(year) > entry.yearTo))
      setYear('');
    setErrors({});
    setShowCatalog(false);
  }
  async function save() {
    if (saved || disabled || busyRef.current) return;
    if (onboarding && !session) {
      setErrors({ form: '차량을 계정에 저장하려면 다시 로그인해 주세요.' });
      return;
    }
    const n = parseNonNegativeNumber(km, '누적 주행거리');
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = '차량 이름을 입력해 주세요.';
    if (!displayModel.trim()) next.model = '제조사·모델·연식을 입력해 주세요.';
    if (catalogId && !selected)
      next.model = '선택한 차종을 찾을 수 없어요. 차종을 다시 선택해 주세요.';
    if (selected && !selected.powertrains.includes(type))
      next.form = '선택한 차종의 구동 방식을 다시 확인해 주세요.';
    if (
      selected &&
      (!/^\d{4}$/.test(year) ||
        Number(year) < selected.yearFrom ||
        (selected.yearTo !== null && Number(year) > selected.yearTo))
    )
      next.year = `${selected.yearFrom}${selected.yearTo === null ? '년 이후' : `–${selected.yearTo}년 중`} 차량등록증의 연식을 입력해 주세요.`;
    if (!n.ok) next.km = n.error;
    setErrors(next);
    if (Object.keys(next).length || !n.ok) return;
    const vehicle: Vehicle = {
      ...draftIdentity.current,
      name: name.trim(),
      model: displayModel.trim(),
      odometerKm: n.value,
      powertrain: type,
      ...(catalogId ? { catalogId } : {}),
    };
    const action: AppAction = { type: existing ? 'UPDATE_VEHICLE' : 'ADD_VEHICLE', vehicle };
    busyRef.current = true;
    setBusy(true);
    let serverSaved = false;
    let savedVehicle = vehicle;
    try {
      applyStateTransaction(state, action);
      if (session) {
        if (!isCurrentClient(client))
          throw new Error('로그인 정보가 바뀌었어요. 현재 계정을 확인해 주세요.');
        savedVehicle = await saveRegisteredVehicle(client, vehicle);
        serverSaved = true;
        if (!isMounted()) return;
        if (!isCurrentClient(client))
          throw new Error(
            '로그인 정보가 바뀌었어요. 현재 계정을 확인한 뒤 차량 목록을 불러와 주세요.',
          );
      }
      if (!isMounted()) return;
      const result = dispatch(
        { type: existing ? 'UPDATE_VEHICLE' : 'ADD_VEHICLE', vehicle: savedVehicle },
        { expectedState: state },
      );
      if (!result.ok)
        throw new Error(
          `${serverSaved ? '계정에는 저장됐어요. 내 차량에서 계정 차량을 불러와 주세요. ' : ''}${result.error}`,
        );
      setSaved(true);
      if (onboarding) router.replace('/(tabs)');
      else router.dismissTo('/(tabs)');
    } catch (error) {
      if (isMounted())
        setErrors({
          form:
            error instanceof Error
              ? error.message
              : '차량을 저장하지 못했어요. 다시 시도해 주세요.',
        });
    } finally {
      busyRef.current = false;
      if (isMounted()) setBusy(false);
    }
  }
  async function remove() {
    if (!existing || disabled || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      applyStateTransaction(state, { type: 'DELETE_VEHICLE', vehicleId: existing.id });
      await Promise.all(
        state.plans.filter((p) => p.vehicleId === existing.id).map((p) => cancelDeparture(p.id)),
      );
      if (!isMounted()) return;
      if (session) {
        if (!isCurrentClient(client))
          throw new Error('로그인 정보가 바뀌었어요. 다시 확인해 주세요.');
        await deleteRegisteredVehicle(client, existing.id);
        if (!isMounted()) return;
        if (!isCurrentClient(client))
          throw new Error('로그인 정보가 바뀌었어요. 현재 계정의 차량 목록을 다시 확인해 주세요.');
      }
      const result = dispatch(
        { type: 'DELETE_VEHICLE', vehicleId: existing.id },
        { expectedState: state },
      );
      if (!result.ok) throw new Error(result.error);
      router.dismissTo('/(tabs)');
    } catch (error) {
      if (isMounted())
        setErrors({
          form:
            error instanceof Error
              ? error.message
              : '차량을 삭제하지 못했어요. 해제된 알림은 다시 켜 주세요.',
        });
    } finally {
      busyRef.current = false;
      if (isMounted()) setBusy(false);
    }
  }
  if (onboarding && !session)
    return (
      <Screen back title="로그인이 필요해요">
        <Notice title="차량을 계정에 저장하려면 다시 로그인해 주세요." />
        <Button
          title="로그인하고 차량 등록"
          onPress={() => router.replace('/settings?onboarding=1&mode=login')}
        />
      </Screen>
    );
  if (id && !existing)
    return (
      <Screen back title="차량을 찾을 수 없어요">
        <Notice title="삭제되었거나 올바르지 않은 차량이에요." />
        <Button title="내 차량으로" onPress={() => router.dismissTo('/(tabs)')} />
      </Screen>
    );
  if (!existing && state.vehicles.length >= 3)
    return (
      <Screen back title="차량은 최대 3대까지">
        <Notice title="기존 차량을 정리한 뒤 새 차량을 등록해 주세요." />
        <Button title="내 차량으로" onPress={() => router.dismissTo('/(tabs)')} />
      </Screen>
    );
  return (
    <Screen
      back
      title={existing ? '차량 정보' : '내 차 등록'}
      subtitle={
        existing
          ? '차량 정보와 누적 주행거리를 관리해요.'
          : `차량등록증과 계기판의 정보를 입력해 주세요. (${state.vehicles.length}/3대)`
      }
      footer={
        <Button
          title={existing ? '변경사항 저장' : onboarding ? '등록하고 시작하기' : '차량 등록하기'}
          icon="check"
          onPress={save}
          disabled={disabled || saved}
          loading={busy}
          testID="save-vehicle"
        />
      }
    >
      {onboarding && (
        <View style={shared.row}>
          <Chip label="계정 연결됨" selected />
          <Text style={shared.heading}>2 차량 등록</Text>
        </View>
      )}
      {(selected || existing) && (
        <View style={s.preview}>
          <VehicleArt
            type={type}
            model={displayModel}
            catalogId={catalogId}
            style={{ height: 112 }}
          />
          <VehiclePhotoCredits />
        </View>
      )}
      <Button
        title={showCatalog ? '차종 목록 닫기' : '차종 목록에서 선택'}
        variant="secondary"
        disabled={disabled}
        onPress={() => setShowCatalog(!showCatalog)}
      />
      {showCatalog && (
        <VehicleCatalogPicker selectedId={catalogId} disabled={disabled} onSelect={selectCatalog} />
      )}
      <Notice
        title={session ? '등록하면 로그인한 계정에도 저장돼요.' : '현재는 이 기기에 저장돼요.'}
        body={
          session
            ? '차량 정보와 선택한 차종 사진이 연결돼요. 다른 기기에서 계정 차량을 불러올 수 있어요.'
            : '설정에서 서버에 로그인하면 차량을 계정에 저장하고 다른 기기에서 불러올 수 있어요.'
        }
      />
      {locked && (
        <Notice
          title="주행을 마친 뒤 수정할 수 있어요."
          body="기록 중인 차량의 정보와 거리를 보호하고 있어요."
          tone="warning"
        />
      )}
      {!!errors.form && <Notice title={errors.form} tone="error" />}
      <Card style={{ gap: 22 }}>
        <Field
          label="차량 이름"
          value={name}
          onChangeText={setName}
          placeholder="예: 나의 아반떼"
          maxLength={30}
          error={errors.name}
          editable={!disabled}
        />
        {selected ? (
          <View style={{ gap: 12 }}>
            <Text style={shared.heading}>
              {selected.manufacturer} {selected.model}
            </Text>
            <Text style={shared.muted}>{selected.generation}</Text>
            <Field
              label="차량 연식 (년)"
              value={year}
              onChangeText={setYear}
              keyboardType="number-pad"
              placeholder="차량등록증의 연식"
              maxLength={4}
              editable={!disabled}
              error={errors.year}
            />
            <Button
              title="차종 직접 입력"
              variant="ghost"
              disabled={disabled}
              onPress={() => {
                setModel(displayModel);
                setCatalogId(undefined);
              }}
            />
          </View>
        ) : (
          <Field
            label="제조사 · 모델 · 연식"
            value={model}
            onChangeText={setModel}
            placeholder="예: 현대 아반떼 2023"
            maxLength={80}
            error={errors.model}
            editable={!disabled}
          />
        )}
        <Field
          label="현재 누적 주행거리 (km)"
          value={km}
          onChangeText={setKm}
          placeholder="예: 48,250"
          keyboardType="decimal-pad"
          maxLength={12}
          error={errors.km}
          hint="계기판에 표시된 누적 주행거리를 입력해 주세요."
          editable={!disabled}
        />
        <View style={{ gap: 10 }}>
          <Text style={s.label}>구동 방식</Text>
          <View style={s.types}>
            {(
              [
                { id: 'ICE', label: '내연기관', icon: 'truck' },
                { id: 'HYB', label: '하이브리드', icon: 'repeat' },
                { id: 'EV', label: '전기차', icon: 'zap' },
              ] as const
            ).map((t) => (
              <View key={t.id} style={{ flex: 1 }}>
                <Chip
                  label={t.label}
                  icon={t.icon}
                  selected={type === t.id}
                  onPress={
                    disabled || (selected && !selected.powertrains.includes(t.id))
                      ? undefined
                      : () => setType(t.id)
                  }
                />
              </View>
            ))}
          </View>
          <Text style={shared.muted}>
            {type === 'EV'
              ? '전기차에 맞는 타이어·브레이크·필터·냉각 점검을 보여드려요.'
              : '엔진오일을 포함해 구동 방식에 맞는 점검 항목을 보여드려요.'}
          </Text>
        </View>
      </Card>
      {existing && (
        <SettingsDisclosure title="차량 연동 상태" description="외부 차량 정보의 연결 여부">
          <BackendVehicleStatus key={type} powertrain={type} />
        </SettingsDisclosure>
      )}
      {existing && (
        <Card style={{ gap: 12 }}>
          <Text style={s.label}>차량 삭제</Text>
          <Text style={shared.muted}>
            이 차량의 주행 기록, 이동 계획, 점검 기록이 함께 삭제됩니다.
          </Text>
          {confirmDelete ? (
            <>
              <Notice
                title={`‘${existing.name}’의 모든 기록을 삭제할까요?`}
                body="삭제한 기록은 되돌릴 수 없어요."
                tone="warning"
              />
              <Button
                title="차량과 연결된 기록 삭제"
                variant="danger"
                disabled={disabled}
                onPress={remove}
              />
              <Button
                title="삭제 취소"
                variant="ghost"
                disabled={busy}
                onPress={() => setConfirmDelete(false)}
              />
            </>
          ) : (
            <Button
              title="차량 삭제하기"
              variant="ghost"
              disabled={disabled}
              onPress={() => setConfirmDelete(true)}
            />
          )}
        </Card>
      )}
    </Screen>
  );
}
const s = StyleSheet.create({
  preview: { backgroundColor: C.mint, borderRadius: 20, padding: 8 },
  label: { fontSize: 14, fontWeight: '600', color: C.ink },
  types: { flexDirection: 'row', gap: 8 },
});
