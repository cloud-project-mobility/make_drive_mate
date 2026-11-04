import { useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { useVehicleCatalog } from '../state/VehicleCatalogProvider';
import { C, Icon, Notice, shared } from './ui';

export function VehiclePhotoCredits() {
  const { entries } = useVehicleCatalog();
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState('');
  async function open(url: string) {
    setError('');
    try {
      await Linking.openURL(url);
    } catch {
      setError('사진 출처를 열지 못했어요. 연결 상태를 확인하고 다시 시도해 주세요.');
    }
  }
  return (
    <View style={{ gap: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="차량 사진 안내와 출처"
        accessibilityState={{ expanded }}
        aria-expanded={expanded}
        onPress={() => setExpanded(!expanded)}
        style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 7 }}
      >
        <Icon name="image" size={14} color={C.muted} />
        <Text style={[shared.muted, { flex: 1 }]}>차종 참고 이미지 · 사진 안내와 출처</Text>
        <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={15} color={C.muted} />
      </Pressable>
      {expanded && (
        <View style={{ padding: 16, backgroundColor: C.surface, borderRadius: 14, gap: 14 }}>
          <Text style={shared.muted}>
            내 차량이나 개별 매물의 실제 사진이 아니에요. 연식·색상·트림·판매 국가에 따라
            외관이 다를 수 있으며, 사진으로 차량 상태나 가격을 판단하지 않아요.
            사진이 없는 차종은 기본 이미지를 표시해요.
          </Text>
          {entries.map((credit) => (
            <View key={credit.id} style={{ gap: 3 }}>
              <Text style={[shared.text, { fontWeight: '600' }]}>
                {credit.manufacturer} {credit.model}
              </Text>
              <Text style={shared.muted}>{credit.generation}</Text>
              <Text style={shared.muted}>{credit.imageAuthor}</Text>
              <View style={[shared.row, { flexWrap: 'wrap', gap: 16 }]}>
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel={`${credit.model} 사진 원본 · 외부 사이트`}
                  onPress={() => void open(credit.imageSourceUrl)}
                  style={{ minHeight: 44, justifyContent: 'center' }}
                >
                  <Text style={{ color: C.primary, fontSize: 12 }}>Wikimedia Commons ↗</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel={`${credit.model} ${credit.imageLicense} 이용 조건 · 외부 사이트`}
                  onPress={() => void open(credit.imageLicenseUrl)}
                  style={{ minHeight: 44, justifyContent: 'center' }}
                >
                  <Text style={{ color: C.primary, fontSize: 12 }}>{credit.imageLicense} ↗</Text>
                </Pressable>
              </View>
            </View>
          ))}
          <Text style={shared.muted}>이미지 편집: AI로 배경 제거·여백 조정.</Text>
          <Text style={shared.muted}>
            CC BY-SA로 표시한 사진의 편집본은 해당 원본과 동일한 라이선스로 제공해요.
            원본 저작자·출처와 각 이용 조건은 위 링크에서 확인할 수 있어요.
          </Text>
          {!!error && <Notice title={error} tone="error" />}
        </View>
      )}
    </View>
  );
}
