import { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Button, Card, Chip, Notice, SectionTitle, shared } from '../components/ui';
import { formatDistance } from '../domain/helpers';
import { MAX_VEHICLES } from '../domain/state';
import type { Vehicle } from '../domain/types';
import { BackendError, type BackendClient } from '../services/backend';
import { listRegisteredVehicles } from '../services/vehicleCatalog';
import { useMounted } from '../services/useMounted';
import { useApp } from '../state/AppProvider';
import { useBackend } from '../state/BackendProvider';

interface VehicleListResult {
  client: BackendClient;
  vehicles: Vehicle[] | null;
  loading: boolean;
  error: string;
  message: string;
}

const powertrainLabels = { ICE: '내연기관', HYB: '하이브리드', EV: '전기차' };

export default function ServerVehicles() {
  const { client, session, isCurrentClient } = useBackend();
  const { state, dispatch, ready } = useApp();
  const isMounted = useMounted();
  const [result, setResult] = useState<VehicleListResult | null>(null);
  const requestSequence = useRef(0);
  const pendingClient = useRef<BackendClient | null>(null);
  const current = session && result?.client === client ? result : null;
  const busy = current?.loading ?? false;
  const full = state.vehicles.length >= MAX_VEHICLES;
  const isCurrent = () => isMounted() && isCurrentClient(client);

  async function load() {
    if (!session || !isCurrent() || pendingClient.current === client) return;
    const sequence = ++requestSequence.current;
    pendingClient.current = client;
    setResult({ client, vehicles: null, loading: true, error: '', message: '' });
    try {
      const vehicles = await listRegisteredVehicles(client);
      if (!isCurrent() || requestSequence.current !== sequence) return;
      setResult({ client, vehicles, loading: false, error: '', message: '' });
    } catch (cause) {
      if (!isCurrent() || requestSequence.current !== sequence) return;
      setResult({
        client,
        vehicles: null,
        loading: false,
        error:
          cause instanceof BackendError && cause.status === 401
            ? '로그인이 만료됐어요. 설정에서 다시 로그인해 주세요.'
            : '계정 차량을 불러오지 못했어요. 연결 상태를 확인하고 다시 시도해 주세요.',
        message: '',
      });
    } finally {
      if (pendingClient.current === client && requestSequence.current === sequence) {
        pendingClient.current = null;
      }
    }
  }

  function add(vehicle: Vehicle) {
    if (
      !isCurrent() ||
      !current ||
      current.loading ||
      !current.vehicles?.some((candidate) => candidate.id === vehicle.id)
    )
      return;
    if (state.vehicles.some((candidate) => candidate.id === vehicle.id)) {
      setResult({ ...current, error: '', message: '이미 이 기기에 등록된 차량이에요.' });
      return;
    }
    const added = dispatch({ type: 'ADD_VEHICLE', vehicle }, { expectedState: state });
    if (!isCurrent()) return;
    setResult({
      ...current,
      error: added.ok ? '' : added.error,
      message: added.ok ? `${vehicle.name} 차량을 이 기기에 추가했어요.` : '',
    });
  }

  if (!session) return null;

  return (
    <Card style={shared.stack}>
      <SectionTitle title="계정에 저장한 차량" />
      <Text style={shared.muted}>저장된 차량을 선택해 이 기기에 추가할 수 있어요.</Text>
      <Button
        title="계정 차량 불러오기"
        onPress={load}
        loading={busy}
        disabled={busy}
        variant="secondary"
      />
      {current?.error ? <Notice title={current.error} tone="error" /> : null}
      {current?.message ? <Notice title={current.message} /> : null}
      {current?.vehicles?.length === 0 && (
        <Text style={shared.muted}>이 계정에 저장한 차량이 아직 없어요.</Text>
      )}
      {current?.vehicles?.map((vehicle) => {
        const exists = state.vehicles.some((candidate) => candidate.id === vehicle.id);
        return (
          <View key={vehicle.id} style={shared.stack}>
            <Text style={shared.text}>{vehicle.name}</Text>
            <Text style={shared.muted}>{vehicle.model}</Text>
            <Text style={shared.muted}>
              {powertrainLabels[vehicle.powertrain]} · {formatDistance(vehicle.odometerKm)} km
            </Text>
            {exists ? (
              <Chip label="이 기기에 등록됨" />
            ) : (
              <Button
                title="이 기기에 추가"
                onPress={() => add(vehicle)}
                disabled={busy || full || !ready}
                variant="secondary"
              />
            )}
          </View>
        );
      })}
      {full && (
        <Text style={shared.muted}>
          이 기기에는 차량을 최대 {MAX_VEHICLES}대까지 등록할 수 있어요.
        </Text>
      )}
    </Card>
  );
}
