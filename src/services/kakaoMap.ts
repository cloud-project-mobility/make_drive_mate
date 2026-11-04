import type { LivePosition } from './liveLocation';

interface MapPoint {
  getLat(): number;
  getLng(): number;
}
interface MapBounds {
  extend(point: MapPoint): void;
}
export interface KakaoMap {
  setCenter(point: MapPoint): void;
  setBounds(bounds: MapBounds): void;
  relayout(): void;
}
interface MapOverlay {
  setMap(map: KakaoMap | null): void;
}
export interface KakaoMaps {
  load(callback: () => void): void;
  Map: new (container: HTMLElement, options: { center: MapPoint; level: number }) => KakaoMap;
  LatLng: new (latitude: number, longitude: number) => MapPoint;
  LatLngBounds: new () => MapBounds;
  Marker: new (options: { map: KakaoMap; position: MapPoint; title: string }) => MapOverlay;
  CustomOverlay: new (options: {
    map: KakaoMap;
    position: MapPoint;
    content: HTMLElement;
    yAnchor: number;
  }) => MapOverlay;
  event: {
    addListener(map: KakaoMap, event: string, callback: () => void): void;
    removeListener(map: KakaoMap, event: string, callback: () => void): void;
  };
}

export const MAP_CONNECTION_ERROR =
  '카카오 지도를 불러오지 못했어요. 인터넷 연결, 지도 이용 설정, 현재 웹 주소의 허용 도메인 등록을 확인해 주세요.';
let loading: Promise<KakaoMaps> | null = null;

/** Call only after the user explicitly connects the map. No coordinates enter the SDK URL. */
export function loadKakaoMaps(javascriptKey: string): Promise<KakaoMaps> {
  if (!javascriptKey.trim()) return Promise.reject(new Error('지도 연결 키가 설정되지 않았어요.'));
  if (typeof window === 'undefined' || typeof document === 'undefined')
    return Promise.reject(new Error('웹 브라우저에서 지도를 연결해 주세요.'));
  if (loading) return loading;
  loading = new Promise<KakaoMaps>((resolve, reject) => {
    const browser = window as Window & { kakao?: { maps?: KakaoMaps } };
    const script = document.createElement('script');
    let finished = false;
    const finish = (maps?: KakaoMaps) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      if (maps) resolve(maps);
      else {
        script.remove();
        reject(new Error(MAP_CONNECTION_ERROR));
      }
    };
    const timer = setTimeout(() => finish(), 15000);
    const initialize = () => {
      try {
        const maps = browser.kakao?.maps;
        if (!maps || typeof maps.load !== 'function') return finish();
        maps.load(() => finish(typeof maps.Map === 'function' ? maps : undefined));
      } catch {
        finish();
      }
    };
    if (browser.kakao?.maps?.Map) initialize();
    else {
      script.async = true;
      script.referrerPolicy = 'strict-origin-when-cross-origin';
      script.src = `https://dapi.kakao.com/v2/maps/sdk.js?autoload=false&appkey=${encodeURIComponent(javascriptKey.trim())}`;
      script.onload = initialize;
      script.onerror = () => finish();
      document.head.appendChild(script);
    }
  }).catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

export interface DeviceMapPoint {
  latitude: number;
  longitude: number;
  label: string;
  own: boolean;
}

export function deviceMapPoints(
  ownPosition: LivePosition | null,
  peerPositions: LivePosition[],
): DeviceMapPoint[] {
  const valid = (position: LivePosition) =>
    Number.isFinite(position.latitude) &&
    Number.isFinite(position.longitude) &&
    Math.abs(position.latitude) <= 90 &&
    Math.abs(position.longitude) <= 180;
  const points: DeviceMapPoint[] = [];
  if (ownPosition && valid(ownPosition))
    points.push({
      latitude: ownPosition.latitude,
      longitude: ownPosition.longitude,
      label: '이 기기',
      own: true,
    });
  const seen = new Set(ownPosition ? [ownPosition.source_id] : []);
  for (const position of peerPositions) {
    if (seen.has(position.source_id) || !valid(position)) continue;
    seen.add(position.source_id);
    const number = points.filter((point) => !point.own).length + 1;
    if (number > 2) break;
    points.push({
      latitude: position.latitude,
      longitude: position.longitude,
      label: `같은 계정 기기 ${number}`,
      own: false,
    });
  }
  return points;
}

export function drawDeviceMarkers(maps: KakaoMaps, map: KakaoMap, points: DeviceMapPoint[]) {
  const overlays: MapOverlay[] = [];
  const bounds = new maps.LatLngBounds();
  for (const point of points) {
    const position = new maps.LatLng(point.latitude, point.longitude);
    bounds.extend(position);
    overlays.push(new maps.Marker({ map, position, title: point.label }));
    const label = document.createElement('span');
    label.textContent = point.label;
    Object.assign(label.style, {
      display: 'block',
      padding: '4px 8px',
      borderRadius: '6px',
      fontSize: '12px',
      background: '#FFFFFF',
      color: point.own ? '#0875FF' : '#10203B',
      border: '1px solid #E2EBF7',
      whiteSpace: 'nowrap',
    });
    overlays.push(new maps.CustomOverlay({ map, position, content: label, yAnchor: 2.7 }));
  }
  if (points.length === 1) map.setCenter(new maps.LatLng(points[0].latitude, points[0].longitude));
  else if (points.length > 1) map.setBounds(bounds);
  return () => overlays.forEach((overlay) => overlay.setMap(null));
}
