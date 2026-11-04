import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { C, Icon } from '../components/ui';

export function dateLabel(value: Date | string, includeYear = false) {
  const date = typeof value === 'string' ? new Date(value) : value;
  return date.toLocaleDateString('ko-KR', {
    ...(includeYear ? { year: 'numeric' as const } : {}),
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  });
}
export function timeLabel(value: Date | string) {
  const date = typeof value === 'string' ? new Date(value) : value;
  return date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
}
export function durationLabel(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`
    : `${minutes}분 ${Math.floor(seconds % 60)}초`;
}
export function localDateValue(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function localTimeValue(date: Date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
export function RouteStops({ origin, destination }: { origin: string; destination: string }) {
  return (
    <View style={s.stops}>
      <View style={s.stop}>
        <View style={s.originDot} />
        <View style={s.stopText}>
          <Text style={s.caption}>출발</Text>
          <Text style={s.address}>{origin}</Text>
        </View>
      </View>
      <View style={s.connector} />
      <View style={s.stop}>
        <Icon name="map-pin" size={18} color={C.primary} />
        <View style={s.stopText}>
          <Text style={s.caption}>도착</Text>
          <Text style={s.address}>{destination}</Text>
        </View>
      </View>
    </View>
  );
}
export function TimeBreakdown({
  drive,
  walk,
  buffer,
}: {
  drive: number;
  walk: number;
  buffer: number;
}) {
  return (
    <View style={s.breakdown}>
      {(
        [
          { icon: 'navigation', title: '예상 운전', value: drive },
          { icon: 'map-pin', title: '주차 후 도보', value: walk },
          { icon: 'coffee', title: '여유 시간', value: buffer },
        ] as const
      ).map((item) => (
        <View key={item.title} style={s.timeItem}>
          <Icon name={item.icon} size={17} color={C.muted} />
          <Text style={s.caption}>{item.title}</Text>
          <Text style={s.timeNumber}>
            {item.value}
            <Text style={s.unit}> 분</Text>
          </Text>
        </View>
      ))}
    </View>
  );
}
const s = StyleSheet.create({
  stops: { gap: 0 },
  stop: { flexDirection: 'row', gap: 12, alignItems: 'center', minHeight: 45 },
  stopText: { flex: 1, gap: 3 },
  originDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: C.muted,
    marginHorizontal: 4,
  },
  connector: {
    height: 18,
    borderLeftWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#A7C1BA',
    marginLeft: 8,
  },
  caption: { color: C.muted, fontSize: 12, lineHeight: 18 },
  address: { color: C.ink, fontSize: 15, lineHeight: 22, fontWeight: '600' },
  breakdown: {
    flexDirection: 'row',
    paddingVertical: 16,
    gap: 8,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: C.line,
  },
  timeItem: { flex: 1, gap: 7 },
  timeNumber: { fontSize: 21, color: C.ink, fontWeight: '700' },
  unit: { fontSize: 12, fontWeight: '400', color: C.muted },
});
