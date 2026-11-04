import { useState } from 'react';
import { Image, ImageSourcePropType, StyleProp, ViewStyle, View, Text, StyleSheet } from 'react-native';
import { Powertrain } from '../domain/types';
import { findCatalogEntry } from '../domain/vehicleCatalog';
import { useVehicleCatalog } from '../state/VehicleCatalogProvider';
import { C } from './ui';
const artwork = {
  ICE: require('../../assets/vehicles/ice.png'),
  HYB: require('../../assets/vehicles/hybrid.png'),
  EV: require('../../assets/vehicles/ev.png'),
};
const photos: Record<string, ImageSourcePropType> = {
  'avante-cn7-pe': require('../../assets/vehicles/cutouts/avante-cn7-pe.png'),
  'k5-dl3-pe': require('../../assets/vehicles/cutouts/k5-dl3-pe.png'),
  'ioniq5-ne': require('../../assets/vehicles/cutouts/ioniq5-ne.png'),
  'sonata-dn8-pe': require('../../assets/vehicles/cutouts/sonata-dn8-pe.png'),
  'grandeur-gn7': require('../../assets/vehicles/cutouts/grandeur-gn7.png'),
  'k8-gl3': require('../../assets/vehicles/cutouts/k8-gl3.png'),
  'sorento-mq4-pe': require('../../assets/vehicles/cutouts/sorento-mq4-pe.png'),
  'sportage-nq5': require('../../assets/vehicles/cutouts/sportage-nq5.png'),
  'niro-sg2': require('../../assets/vehicles/cutouts/niro-sg2.png'),
  'ev6-cv': require('../../assets/vehicles/cutouts/ev6-cv.png'),
};
export function VehicleArt({
  type = 'ICE',
  model,
  catalogId,
  caption = true,
  style,
}: {
  type?: Powertrain;
  model?: string;
  catalogId?: string;
  caption?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { entries, backendUrl } = useVehicleCatalog();
  const entry = findCatalogEntry(entries, catalogId, model, type);
  const photoKey = entry?.id;
  const [failedPhoto, setFailedPhoto] = useState<string>();
  const sourceKey = `${backendUrl}:${photoKey ?? ''}`;
  const photo = entry && failedPhoto !== sourceKey
    ? photos[entry.id] ?? (entry.imageUrl ? { uri: `${backendUrl}${entry.imageUrl}` } : undefined)
    : undefined;
  return (
    <View style={[s.frame, style]}>
      <Image
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        key={`${sourceKey}:${type}`}
        source={photo ?? artwork[type]}
        resizeMode="contain"
        onError={photo ? () => setFailedPhoto(sourceKey) : undefined}
        style={s.image}
      />
      {!!model && caption && (
        <View style={s.caption}>
          <Text style={s.captionText}>
            {photo ? '배경을 제거한 차종 참고 이미지' : '차종 사진 준비 중 · 기본 이미지'}
          </Text>
        </View>
      )}
    </View>
  );
}
const s = StyleSheet.create({
  frame: { height: 195, borderRadius: 14, overflow: 'hidden', backgroundColor: 'transparent' },
  image: { width: '100%', flex: 1, minHeight: 0 },
  caption: { paddingHorizontal: 10, paddingVertical: 7 },
  captionText: { fontSize: 10, lineHeight: 15, color: C.muted, textAlign: 'center' },
});
