import { useState } from 'react';
import { Text } from 'react-native';
import { Button, Card, Chip, Notice, SectionTitle, shared } from '../components/ui';
import { useBackend } from '../state/BackendProvider';
import { backendMessage, type VehicleStatus } from '../services/backend';
import type { Powertrain } from '../domain/types';
const warningLabels: Record<string, string> = {
  engine_oil: '엔진오일',
  tire_pressure: '타이어 공기압',
  brake_oil: '브레이크 오일',
  low_fuel: '연료 부족',
  washer_fluid: '워셔액',
  smart_key_battery: '스마트키 배터리',
};
function VehicleStatusContent({ powertrain }: { powertrain: Powertrain }) {
  const { client, session } = useBackend();
  const [status, setStatus] = useState<VehicleStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load() {
    setBusy(true);
    setError('');
    setStatus(null);
    try {
      setStatus(await client.vehicleStatus(powertrain));
    } catch (cause) {
      setError(backendMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card style={shared.stack}>
      <SectionTitle title="현대 차량 상태 연동 테스트" />
      <Text style={shared.muted}>
        로컬 서버의 예시 응답으로 차량 상태를 확인해요. 내 차량의 실시간 정보가 아니며 누적
        주행거리를 자동 변경하지 않아요.
      </Text>
      <Button
        title="서버 예시 차량 상태 확인"
        onPress={load}
        loading={busy}
        disabled={!session}
        variant="secondary"
      />
      {!session && <Text style={shared.muted}>설정에서 로컬 서버에 먼저 로그인해 주세요.</Text>}
      {error ? <Notice title={error} tone="error" /> : null}
      {status && (
        <>
          <Chip
            label={
              status.source === 'mock' ? '예시 차량 · 현대 계정 연결 안 됨' : '서버 차량 상태 응답'
            }
          />
          <Text style={shared.text}>
            누적 {status.odometer_km.toLocaleString('ko-KR')} km
            {status.range_km !== null ? ` · 잔여 주행 ${status.range_km} km` : ''}
          </Text>
          {status.battery_percent !== null && (
            <Text style={shared.text}>배터리 {status.battery_percent}%</Text>
          )}
          <Text style={shared.muted}>
            {status.observed_at
              ? `관측 시각: ${new Date(status.observed_at).toLocaleString('ko-KR')}`
              : '관측 시각의 시간대가 확인되지 않았어요. 현재 실차 상태로 판단하지 마세요.'}
          </Text>
          <Text style={shared.muted}>
            서버 수신: {new Date(status.received_at).toLocaleString('ko-KR')}
          </Text>
          <Text style={shared.muted}>
            {Object.values(status.warnings).some(Boolean)
              ? Object.entries(status.warnings)
                  .filter(([, active]) => active)
                  .map(([name]) => warningLabels[name] || name)
                  .join(' · ')
              : '응답에 포함된 경고 없음 · 실제 정비 상태를 보장하지 않아요.'}
          </Text>
        </>
      )}
    </Card>
  );
}

export default function BackendVehicleStatus({ powertrain }: { powertrain: Powertrain }) {
  const { url, session } = useBackend();
  return (
    <VehicleStatusContent
      key={`${url}:${session?.user.id ?? 'anonymous'}:${session?.expires_at ?? ''}`}
      powertrain={powertrain}
    />
  );
}
