import React from 'react';
import { Platform, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Button, Card, Chip, Notice, SectionTitle, shared } from './ui';
import LiveLocationMap from './LiveLocationMap';
import { useLiveLocation } from '../services/useLiveLocation';

export default function LiveLocationCard() {
  const live = useLiveLocation();
  if (Platform.OS !== 'web') return null;
  return (
    <Card style={shared.stack}>
      <SectionTitle title="내 기기 실시간 위치" />
      <Text style={shared.muted}>
        이 브라우저가 확인한 기기 위치예요. 차량에서 받은 위치가 아니며 같은 계정으로 로그인한 다른
        기기에만 전송해요.
      </Text>
      <Chip
        label={
          live.status === 'connected'
            ? '기기 연결됨'
            : live.status === 'connecting'
              ? '기기 연결 중'
              : live.status === 'offline'
                ? '인터넷 연결 없음'
                : '기기 연결 안 됨'
        }
      />
      {!live.loggedIn ? (
        <Button
          title="로그인하고 기기 연결"
          variant="secondary"
          onPress={() => router.push('/(tabs)/settings')}
        />
      ) : live.status === 'connected' ? (
        <View style={shared.stack}>
          <Button
            title={live.sharing ? '내 위치 전송 중지' : '내 기기 위치 전송 시작'}
            onPress={
              live.sharing
                ? () => live.stopSharing('내 위치 전송을 멈췄어요.')
                : () => {
                    void live.startSharing();
                  }
            }
            testID="toggle-location-sharing"
          />
          <Button
            title="기기 연결 끊기"
            variant="ghost"
            onPress={() => live.disconnect('기기 연결을 종료했어요.')}
          />
        </View>
      ) : (
        <Button
          title="같은 계정 기기 연결"
          variant="secondary"
          loading={live.status === 'connecting'}
          disabled={live.status === 'offline'}
          onPress={() => {
            void live.connect();
          }}
          testID="connect-live-location"
        />
      )}
      {!!live.notice && <Notice title="위치 연결 안내" body={live.notice} />}
      {live.ownPosition && (
        <View style={shared.stack} testID="own-live-location">
          <Text style={shared.text}>
            현재 기기 · {live.ownPosition.latitude.toFixed(5)},{' '}
            {live.ownPosition.longitude.toFixed(5)}
          </Text>
          <Text style={shared.muted}>
            정확도 약 {Math.round(live.ownPosition.accuracy_m)}m ·{' '}
            {new Date(live.ownPosition.observed_at).toLocaleTimeString('ko-KR')} 측정
          </Text>
        </View>
      )}
      <Text style={shared.text}>같은 계정의 다른 기기 {live.peerPositions.length}대</Text>
      {live.peerPositions.map((point, index) => (
        <View key={point.source_id} style={shared.stack} testID="peer-live-location">
          <Text style={shared.text}>
            다른 기기 {index + 1} · {point.latitude.toFixed(5)}, {point.longitude.toFixed(5)}
          </Text>
          <Text style={shared.muted}>
            정확도 약 {Math.round(point.accuracy_m)}m ·{' '}
            {new Date(point.observed_at).toLocaleTimeString('ko-KR')} 측정
          </Text>
        </View>
      ))}
      <LiveLocationMap ownPosition={live.ownPosition} peerPositions={live.peerPositions} />
      <Text style={shared.muted}>
        위치 전송 시작을 눌러야 권한을 요청해요. 화면을 떠나거나 숨기면 연결을 멈추며, 오래된 위치는
        30초 뒤 지워요. 위치 이력은 주행 기록·백업에 저장하지 않아요.
      </Text>
    </Card>
  );
}
