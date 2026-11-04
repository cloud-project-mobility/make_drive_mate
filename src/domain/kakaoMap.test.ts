import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deviceMapPoints,
  drawDeviceMarkers,
  loadKakaoMaps,
  MAP_CONNECTION_ERROR,
  type KakaoMaps,
} from '../services/kakaoMap';
import type { LivePosition } from '../services/liveLocation';

const position = (source: string, latitude = 37.5): LivePosition => ({
  source_id: source,
  latitude,
  longitude: 127,
  accuracy_m: 10,
  observed_at: '2026-11-04T10:00:00Z',
  received_at: '2026-11-04T10:00:00Z',
});

test('map coordinates are bounded and only this device plus two distinct peers are drawn', () => {
  assert.deepEqual(deviceMapPoints(null, []), []);
  const points = deviceMapPoints(position('own'), [
    position('own'),
    position('invalid', Infinity),
    position('north', 91),
    position('peer1'),
    position('peer1'),
    position('peer2'),
    position('peer3'),
  ]);
  assert.deepEqual(
    points.map((point) => point.label),
    ['이 기기', '같은 계정 기기 1', '같은 계정 기기 2'],
  );
  assert.equal(points[0].own, true);
  assert.equal(points[1].own, false);
  assert.ok(points.every((point) => !('source_id' in point)));
});

test('SDK is requested only by explicit loading, rejects safely, and permits a bounded retry', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const scripts: {
    src?: string;
    onerror?: (() => void) | null;
    onload?: (() => void) | null;
    remove: () => void;
  }[] = [];
  const browser: { kakao?: { maps: unknown } } = {};
  let removed = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => ({ remove: () => removed++ }),
      head: { appendChild: (script: (typeof scripts)[number]) => scripts.push(script) },
    },
  });
  try {
    assert.equal(scripts.length, 0);
    await assert.rejects(loadKakaoMaps(''), /키가 설정되지/);
    assert.equal(scripts.length, 0);
    const failed = loadKakaoMaps('synthetic-test-key');
    assert.equal(scripts.length, 1);
    const sdkUrl = new URL(scripts[0].src!);
    assert.equal(sdkUrl.origin, 'https://dapi.kakao.com');
    assert.deepEqual([...sdkUrl.searchParams.keys()].sort(), ['appkey', 'autoload']);
    assert.equal(sdkUrl.searchParams.get('autoload'), 'false');
    scripts[0].onerror!();
    await assert.rejects(failed, (error: Error) => error.message === MAP_CONNECTION_ERROR);
    assert.equal(removed, 1);
    const retry = loadKakaoMaps('synthetic-test-key');
    assert.equal(loadKakaoMaps('synthetic-test-key'), retry);
    assert.equal(scripts.length, 2);
    const maps = { load: (callback: () => void) => callback(), Map: class {} };
    browser.kakao = { maps };
    scripts[1].onload!();
    assert.equal(await retry, maps);
  } finally {
    for (const [name, descriptor] of [
      ['window', originalWindow],
      ['document', originalDocument],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test('marker redraw returns cleanup for every marker and label without raw device identifiers', () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const labels: { textContent: string; style: object }[] = [];
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => {
        const label = { textContent: '', style: {} };
        labels.push(label);
        return label;
      },
    },
  });
  const cleared: unknown[] = [];
  const bounds: unknown[] = [];
  class LatLng {
    constructor(
      private latitude: number,
      private longitude: number,
    ) {}
    getLat() {
      return this.latitude;
    }
    getLng() {
      return this.longitude;
    }
  }
  class Overlay {
    setMap(value: unknown) {
      cleared.push(value);
    }
  }
  const maps = {
    LatLng,
    LatLngBounds: class {
      extend(point: unknown) {
        bounds.push(point);
      }
    },
    Marker: Overlay,
    CustomOverlay: Overlay,
  } as unknown as KakaoMaps;
  let fitted = 0;
  const map = {
    setCenter() {},
    setBounds() {
      fitted++;
    },
    relayout() {},
  };
  try {
    const clear = drawDeviceMarkers(
      maps,
      map,
      deviceMapPoints(position('private-device-id'), [position('private-peer-id')]),
    );
    assert.equal(bounds.length, 2);
    assert.equal(fitted, 1);
    assert.deepEqual(
      labels.map((label) => label.textContent),
      ['이 기기', '같은 계정 기기 1'],
    );
    clear();
    assert.deepEqual(cleared, [null, null, null, null]);
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
