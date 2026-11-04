import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { C, Icon, Notice } from './ui';
import { VehicleArt } from './VehicleArt';
import { useApp } from '../state/AppProvider';
import { formatDistance } from '../domain/helpers';

export function VehiclePicker() {
  const { state, dispatch } = useApp();
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState('');
  const vehicle =
    state.vehicles.find((item) => item.id === state.selectedVehicleId) ?? state.vehicles[0];
  if (!vehicle) return null;
  return (
    <View style={s.container}>
      <View style={s.summary}>
        <View style={s.copy}>
          <Text style={s.caption}>
            내 차 · {state.vehicles.indexOf(vehicle) + 1} / {state.vehicles.length}대
            {state.demoMode ? ' · 예시 차량' : ''}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="차량 선택"
            accessibilityState={{ expanded }}
            aria-expanded={expanded}
            onPress={() => setExpanded(!expanded)}
            style={s.selector}
          >
            <Text style={s.name}>{vehicle.name}</Text>
            <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={19} color={C.muted} />
          </Pressable>
          <Text style={s.description}>{vehicle.model}</Text>
          <Text style={s.description}>
            {{ ICE: '내연기관', HYB: '하이브리드', EV: '전기차' }[vehicle.powertrain]} ·{' '}
            <Text testID="vehicle-odometer">{formatDistance(vehicle.odometerKm)}</Text> km
          </Text>
        </View>
        <VehicleArt
          type={vehicle.powertrain}
          model={vehicle.model}
          catalogId={vehicle.catalogId}
          caption={false}
          style={s.art}
        />
      </View>
      {expanded && (
        <View style={s.options}>
          {state.vehicles.map((item) => (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              accessibilityLabel={item.name}
              aria-pressed={item.id === vehicle.id}
              onPress={() => {
                const result = dispatch({ type: 'SELECT_VEHICLE', vehicleId: item.id });
                setError(result.ok ? '' : result.error);
                if (result.ok) setExpanded(false);
              }}
              style={[s.option, item.id === vehicle.id && s.selected]}
            >
              <Text style={s.optionText}>{item.name}</Text>
              {item.id === vehicle.id && <Icon name="check" size={16} color={C.primary} />}
            </Pressable>
          ))}
        </View>
      )}
      {!!error && <Notice title={error} tone="error" />}
    </View>
  );
}
const s = StyleSheet.create({
  container: { gap: 12 },
  summary: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  copy: { flex: 1, minWidth: 0, gap: 4 },
  caption: { color: C.muted, fontSize: 13, lineHeight: 21 },
  selector: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  name: { color: C.ink, fontSize: 25, lineHeight: 33, fontWeight: '700', flexShrink: 1 },
  description: { color: C.muted, fontSize: 14, lineHeight: 22 },
  art: { width: '32%', maxWidth: 210, height: 100 },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  option: {
    minHeight: 44,
    padding: 12,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: C.line,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  selected: { borderColor: C.primary, backgroundColor: C.mint },
  optionText: { color: C.ink, fontSize: 14 },
});
