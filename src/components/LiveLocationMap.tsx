import { useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { deviceMapPoints } from '../services/kakaoMap';
import type { LivePosition } from '../services/liveLocation';
import { Button, Notice, shared } from './ui';

export interface LiveLocationMapProps {
  ownPosition: LivePosition | null;
  peerPositions: LivePosition[];
}

export default function LiveLocationMap({ ownPosition, peerPositions }: LiveLocationMapProps) {
  const points = deviceMapPoints(ownPosition, peerPositions);
  const [error, setError] = useState(false);
  async function openMap(latitude: number, longitude: number) {
    setError(false);
    try {
      await Linking.openURL(`https://map.kakao.com/link/map/${latitude},${longitude}`);
    } catch {
      setError(true);
    }
  }
  return (
    <View style={shared.stack}>
      <Text style={shared.muted}>
        앱에서는 카카오 지도에서 기기 위치를 확인할 수 있어요. 버튼을 누르면 해당 위치가 카카오에
        전달돼요. 차량에 설치된 위치 장치의 정보는 아니에요.
      </Text>
      {points.map((point) => (
        <Button
          key={point.label}
          title={`${point.label} 카카오 지도 열기`}
          onPress={() => openMap(point.latitude, point.longitude)}
          variant="secondary"
          icon="map"
        />
      ))}
      {!points.length && <Text style={shared.muted}>먼저 공유된 기기 위치가 필요해요.</Text>}
      {error && (
        <Notice
          title="지도를 열지 못했어요"
          body="인터넷 연결을 확인하고 다시 시도해 주세요."
          tone="error"
        />
      )}
    </View>
  );
}
