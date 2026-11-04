import { router } from 'expo-router';
import { Text } from 'react-native';
import { Button, Screen, shared } from '../components/ui';
import { formatDistance } from '../domain/helpers';
import { useApp } from '../state/AppProvider';
import ValueDashboard from './ValueDashboard';

export default function AnalysisToolsScreen() {
  const { state } = useApp();
  const vehicle =
    state.vehicles.find((item) => item.id === state.selectedVehicleId) ?? state.vehicles[0];
  return (
    <Screen title="가격 비교 도구" back>
      {vehicle ? (
        <>
          <Text style={shared.muted}>
            {vehicle.name} · 등록 주행거리{' '}
            <Text testID="vehicle-odometer">{formatDistance(vehicle.odometerKm)}</Text> km
          </Text>
          <ValueDashboard
            key={`${vehicle.id}:${vehicle.odometerKm}:${vehicle.model}`}
            vehicle={vehicle}
          />
        </>
      ) : (
        <Button title="차량 등록" onPress={() => router.push('/vehicle')} />
      )}
    </Screen>
  );
}
