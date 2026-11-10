import { useRef } from 'react';
import { router } from 'expo-router';
import { ScrollView, Text, View } from 'react-native';
import { Button, Screen, shared } from '../components/ui';
import { formatDistance } from '../domain/helpers';
import { useApp } from '../state/AppProvider';
import ValueDashboard from './ValueDashboard';

export default function AnalysisToolsScreen() {
  const { state } = useApp();
  const scrollRef = useRef<ScrollView>(null);
  const dashboardOffset = useRef(0);
  const offlineOffset = useRef(0);
  const vehicle =
    state.vehicles.find((item) => item.id === state.selectedVehicleId) ?? state.vehicles[0];
  return (
    <Screen title="가격 비교 도구" back scrollRef={scrollRef}>
      {vehicle ? (
        <>
          <Text style={shared.muted}>
            {vehicle.name} · 등록 주행거리{' '}
            <Text testID="vehicle-odometer">{formatDistance(vehicle.odometerKm)}</Text> km
          </Text>
          <View
            onLayout={(event) => {
              dashboardOffset.current = event.nativeEvent.layout.y;
            }}
          >
            <ValueDashboard
              key={`${vehicle.id}:${vehicle.odometerKm}:${vehicle.model}`}
              vehicle={vehicle}
              onOfflineLayout={(offset) => {
                offlineOffset.current = offset;
              }}
              onApplied={() =>
                scrollRef.current?.scrollTo({
                  y: dashboardOffset.current + offlineOffset.current,
                  animated: true,
                })
              }
            />
          </View>
        </>
      ) : (
        <Button title="차량 등록" onPress={() => router.push('/vehicle')} />
      )}
    </Screen>
  );
}
