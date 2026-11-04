import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { VehicleCatalogEntry } from '../domain/vehicleCatalog';
import { useVehicleCatalog } from '../state/VehicleCatalogProvider';
import { VehicleArt } from './VehicleArt';
import { C, Card, Field, Notice, shared } from './ui';

export function VehicleCatalogPicker({ selectedId, disabled, onSelect }: {
  selectedId?: string;
  disabled: boolean;
  onSelect: (entry: VehicleCatalogEntry) => void;
}) {
  const { entries, source, loading, error } = useVehicleCatalog();
  const [query, setQuery] = useState('');
  const filtered = entries.filter((entry) =>
    `${entry.manufacturer} ${entry.model} ${entry.generation}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <Card style={{ gap: 14 }}>
      <Text style={shared.heading}>내 차종 찾기</Text>
      <Text style={shared.muted}>
        {source === 'server' ? '서버 차량 목록' : '기본 차량 목록'} · {entries.length}종{loading ? ' · 업데이트 확인 중' : ''}
      </Text>
      <Field label="차종 검색" value={query} onChangeText={setQuery} editable={!disabled}
        placeholder="예: 아반떼, 쏘렌토, EV6" maxLength={60} />
      {!!error && <Notice title="기본 차량 목록을 표시하고 있어요." body={error} />}
      <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ gap: 12, paddingBottom: 8 }}>
        {filtered.map((entry) => (
          <Pressable key={entry.id} accessibilityRole="button"
            accessibilityLabel={`${entry.manufacturer} ${entry.model} ${entry.generation} 선택`}
            accessibilityState={{ selected: selectedId === entry.id, disabled }}
            disabled={disabled} onPress={() => onSelect(entry)}
            style={{ width: 210, padding: 14, borderRadius: 16, borderWidth: 1,
              borderColor: selectedId === entry.id ? C.primary : C.line,
              backgroundColor: selectedId === entry.id ? C.mint : C.bg }}>
            <VehicleArt catalogId={entry.id} type={entry.powertrains[0]} caption={false} style={{ height: 112 }} />
            <Text style={[shared.text, { fontWeight: '700' }]}>{entry.manufacturer} {entry.model}</Text>
            <Text style={shared.muted}>{entry.generation}</Text>
            <Text style={shared.muted}>{entry.yearFrom}–{entry.yearTo ?? '현재'}년 · 등록 지원 범위</Text>
          </Pressable>
        ))}
      </ScrollView>
      {!filtered.length && <Text style={shared.muted}>등록된 차종이 없어요. 아래에서 직접 입력할 수 있어요.</Text>}
      <View><Text style={shared.muted}>차량등록증의 연식과 세대를 확인해 주세요. 사진은 외관 참고용이에요.</Text></View>
    </Card>
  );
}
