import { useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import type { LivePosition } from '../services/liveLocation';
import {
  deviceMapPoints,
  drawDeviceMarkers,
  loadKakaoMaps,
  MAP_CONNECTION_ERROR,
  type DeviceMapPoint,
  type KakaoMap,
  type KakaoMaps,
} from '../services/kakaoMap';
import { Button, Notice, shared } from './ui';

export interface LiveLocationMapProps {
  ownPosition: LivePosition | null;
  peerPositions: LivePosition[];
}

export default function LiveLocationMap({ ownPosition, peerPositions }: LiveLocationMapProps) {
  const points = useMemo(
    () => deviceMapPoints(ownPosition, peerPositions),
    [ownPosition, peerPositions],
  );
  const key = process.env.EXPO_PUBLIC_KAKAO_JAVASCRIPT_KEY?.trim() ?? '';
  return (
    <View style={shared.stack} testID="live-location-map">
      <Text style={shared.muted}>
        카카오 지도를 연결하면 지도 제공을 위해 표시 지역이 카카오에 전달돼요. 이 기기와 같은 계정의
        공유 기기를 표시하며, 차량에 설치된 위치 장치의 정보는 아니에요.
      </Text>
      {!key && (
        <Notice
          title="지도 미연결"
          body="이 웹 버전에 카카오 지도 연결 키가 설정되지 않았어요. 기기 위치 공유와 지도 연결은 별개예요."
        />
      )}
      {!points.length && (
        <Text style={shared.muted}>
          위치 공유를 시작하거나 다른 기기의 공유 위치를 받아 주세요.
        </Text>
      )}
      {key && points.length ? (
        <MapConnection points={points} javascriptKey={key} />
      ) : (
        <Button
          title="카카오 지도 연결"
          onPress={() => {}}
          disabled
          variant="secondary"
          icon="map"
        />
      )}
    </View>
  );
}

function MapConnection({
  points,
  javascriptKey,
}: {
  points: DeviceMapPoint[];
  javascriptKey: string;
}) {
  const latestPoints = useRef(points);
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<{ maps: KakaoMaps; map: KakaoMap; clearMarkers: () => void } | null>(
    null,
  );
  const [requested, setRequested] = useState(false);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  useEffect(() => {
    latestPoints.current = points;
    const current = instance.current;
    if (current) {
      current.clearMarkers();
      current.clearMarkers = drawDeviceMarkers(current.maps, current.map, points);
    }
  }, [points]);

  useEffect(() => {
    if (!requested || !container.current) return;
    let cancelled = false;
    let resize: ResizeObserver | undefined;
    let tileTimer: ReturnType<typeof setTimeout> | undefined;
    let stopListening: (() => void) | undefined;
    const host = container.current;
    const clearMap = () => {
      clearTimeout(tileTimer);
      stopListening?.();
      stopListening = undefined;
      resize?.disconnect();
      instance.current?.clearMarkers();
      instance.current = null;
      host.replaceChildren();
    };
    loadKakaoMaps(javascriptKey)
      .then((maps) => {
        if (cancelled || !latestPoints.current.length) return;
        try {
          const first = latestPoints.current[0];
          const map = new maps.Map(host, {
            center: new maps.LatLng(first.latitude, first.longitude),
            level: 5,
          });
          instance.current = { maps, map, clearMarkers: () => {} };
          const ready = () => {
            if (cancelled) return;
            clearTimeout(tileTimer);
            setState('ready');
          };
          maps.event.addListener(map, 'tilesloaded', ready);
          stopListening = () => maps.event.removeListener(map, 'tilesloaded', ready);
          tileTimer = setTimeout(() => {
            if (!cancelled) {
              clearMap();
              setState('error');
            }
          }, 20000);
          instance.current.clearMarkers = drawDeviceMarkers(maps, map, latestPoints.current);
          if (typeof ResizeObserver !== 'undefined') {
            resize = new ResizeObserver(() => map.relayout());
            resize.observe(host);
          }
        } catch {
          clearMap();
          if (!cancelled) setState('error');
        }
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
      clearMap();
    };
  }, [requested, javascriptKey]);

  return (
    <View style={shared.stack}>
      {requested ? (
        <>
          <div
            ref={container}
            role="region"
            aria-label="내 기기와 같은 계정 기기의 카카오 지도"
            data-testid="kakao-map-canvas"
            style={{ width: '100%', height: 300, borderRadius: 12, overflow: 'hidden' }}
          />
          {state === 'loading' && (
            <Text accessibilityLiveRegion="polite" style={shared.muted}>
              카카오 지도 연결 중…
            </Text>
          )}
          {state === 'ready' && (
            <Text style={shared.muted}>
              카카오 지도 · {points.map((point) => point.label).join(' · ')}
            </Text>
          )}
          {state === 'error' && (
            <Notice title="지도 미연결" body={MAP_CONNECTION_ERROR} tone="error" />
          )}
          <Button
            title="지도 연결 닫기"
            onPress={() => {
              setRequested(false);
              setState('idle');
            }}
            variant="secondary"
            icon="x"
          />
        </>
      ) : (
        <Button
          title="카카오 지도 연결"
          onPress={() => {
            setState('loading');
            setRequested(true);
          }}
          variant="secondary"
          icon="map"
        />
      )}
    </View>
  );
}
