import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

const hasMapKey = Boolean(process.env.EXPO_PUBLIC_KAKAO_JAVASCRIPT_KEY?.trim());

type Harness = {
  count: () => number;
  cleared: number[];
  emit: () => void;
  fail: (code: number) => void;
  stale: () => void;
};

async function prepare(page: Page) {
  const messages: Record<string, unknown>[] = [];
  const sockets: WebSocketRoute[] = [];
  const mapRequests: string[] = [];
  let tickets = 0;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (/^(dapi\.kakao\.com|maps\.daum\.net)$/.test(url.hostname))
      mapRequests.push(url.origin + url.pathname);
  });
  await page.route('https://dapi.kakao.com/**', (route) => route.abort());
  await page.addInitScript(() => {
    const watches = new Map<
      number,
      { success: PositionCallback; error?: PositionErrorCallback | null }
    >();
    const cleared: number[] = [];
    let next = 100;
    let previous: PositionCallback | undefined;
    const position = () =>
      ({
        timestamp: Date.now(),
        coords: {
          latitude: 37.54321,
          longitude: 127.12345,
          accuracy: 8,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          speed: null,
        },
      }) as GeolocationPosition;
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        watchPosition(success: PositionCallback, error?: PositionErrorCallback | null) {
          const id = ++next;
          previous = success;
          watches.set(id, { success, error });
          return id;
        },
        clearWatch(id: number) {
          cleared.push(id);
          watches.delete(id);
        },
      },
    });
    Object.assign(window, {
      __liveHarness: {
        count: () => watches.size,
        cleared,
        emit: () => [...watches.values()].forEach((watch) => watch.success(position())),
        fail: (code: number) =>
          [...watches.values()].forEach((watch) =>
            watch.error?.({ code } as GeolocationPositionError),
          ),
        stale: () => previous?.(position()),
      },
    });
  });
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const payload = path.endsWith('/auth/login')
      ? {
          access_token: 'synthetic-live-location-token',
          token_type: 'bearer',
          user: { id: 'synthetic-user', email: 'location@example.test' },
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }
      : path.endsWith('/location/ticket')
        ? {
            ticket: 'synthetic-single-use-ticket-00001',
            expires_at: new Date(Date.now() + 30_000).toISOString(),
          }
        : { status: 'ok', provider_mode: 'mock' };
    if (path.endsWith('/location/ticket')) {
      tickets += 1;
      expect(route.request().headers().authorization).toBe('Bearer synthetic-live-location-token');
      expect(route.request().method()).toBe('POST');
    }
    await route.fulfill({ json: payload });
  });
  await page.routeWebSocket('**/api/v1/location/stream', (socket) => {
    expect(new URL(socket.url()).search).toBe('');
    sockets.push(socket);
    socket.onMessage((message) => messages.push(JSON.parse(String(message))));
    socket.send(JSON.stringify({ type: 'ready', source_id: 'own-test-device' }));
  });
  await page.goto('/');
  await page.getByRole('button', { name: '예시 차량으로 둘러보기', exact: true }).click();
  await page.getByRole('tab', { name: '설정', exact: true }).click();
  await page
    .getByRole('textbox', { name: '테스트 계정 이메일', exact: true })
    .fill('location@example.test');
  await page.getByLabel('테스트 계정 비밀번호', { exact: true }).fill('synthetic-password-only');
  await page.getByRole('button', { name: '로컬 서버 로그인', exact: true }).click();
  await expect(page.getByText('location@example.test', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '이동 계획', exact: true }).click();
  await page.getByRole('button', { name: '내 기기 위치 보기', exact: true }).click();
  await expect(page.getByText('내 기기 실시간 위치', { exact: true })).toBeVisible();
  return { messages, sockets, mapRequests, tickets: () => tickets };
}

async function gps(page: Page, action: 'count' | 'emit' | 'stale') {
  return page.evaluate(
    (method) => (window as unknown as { __liveHarness: Harness }).__liveHarness[method](),
    action,
  );
}

test('device sharing waits for explicit opt-in, receives peers, and stops without persisting location', async ({
  page,
}) => {
  const harness = await prepare(page);
  expect(await gps(page, 'count')).toBe(0);
  expect(harness.tickets()).toBe(0);
  expect(harness.sockets).toHaveLength(0);
  expect(harness.mapRequests).toHaveLength(0);
  // CI exports include the public map key; local key-free exports show its missing-key notice.
  if (hasMapKey) await expect(page.getByText('지도 미연결', { exact: true })).toHaveCount(0);
  else await expect(page.getByText('지도 미연결', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '카카오 지도 연결', exact: true })).toBeDisabled();
  await page.getByTestId('connect-live-location').click();
  await expect(page.getByText('기기 연결됨', { exact: true })).toBeVisible();
  expect(await gps(page, 'count')).toBe(0);
  expect(harness.messages).toHaveLength(0);
  const instant = new Date().toISOString();
  harness.sockets[0].send(
    JSON.stringify({
      type: 'position',
      source_id: 'peer-test-device',
      latitude: 37.6,
      longitude: 127.2,
      accuracy_m: 4,
      observed_at: instant,
      received_at: instant,
    }),
  );
  await expect(page.getByTestId('peer-live-location')).toContainText('37.60000, 127.20000');
  await page.getByTestId('toggle-location-sharing').click();
  await expect.poll(() => gps(page, 'count')).toBe(1);
  await gps(page, 'emit');
  await expect(page.getByTestId('own-live-location')).toContainText('37.54321, 127.12345');
  const mapButton = page.getByRole('button', { name: '카카오 지도 연결', exact: true });
  if (hasMapKey) await expect(mapButton).toBeEnabled();
  else await expect(mapButton).toBeDisabled();
  await expect
    .poll(() => harness.messages.filter((item) => item.type === 'position').length)
    .toBe(1);
  expect(Object.keys(harness.messages[0]).sort()).toEqual([
    'accuracy_m',
    'latitude',
    'longitude',
    'observed_at',
    'type',
  ]);
  await page.getByTestId('toggle-location-sharing').click();
  await expect.poll(() => gps(page, 'count')).toBe(0);
  await expect(page.getByTestId('own-live-location')).toHaveCount(0);
  await expect.poll(() => harness.messages.at(-1)?.type).toBe('stop');
  await gps(page, 'stale');
  expect(harness.messages.filter((item) => item.type === 'position')).toHaveLength(1);
  harness.sockets[0].send(JSON.stringify({ type: 'stopped', source_id: 'peer-test-device' }));
  await expect(page.getByTestId('peer-live-location')).toHaveCount(0);
  const storage = await page.evaluate(() => JSON.stringify(localStorage));
  expect(storage).not.toContain('37.54321');
  expect(storage).not.toContain('synthetic-live-location-token');
  expect(harness.mapRequests).toHaveLength(0);
});

test('permission denial, timeout and offline stop sharing and require a fresh explicit start', async ({
  page,
}) => {
  const harness = await prepare(page);
  await page.getByTestId('connect-live-location').click();
  await expect(page.getByText('기기 연결됨', { exact: true })).toBeVisible();
  for (const [code, text] of [
    [1, '위치 권한이 거부됐어요'],
    [3, '위치 확인 시간이 초과됐어요'],
  ] as const) {
    await page.getByTestId('toggle-location-sharing').click();
    await expect.poll(() => gps(page, 'count')).toBe(1);
    await page.evaluate(
      (value) => (window as unknown as { __liveHarness: Harness }).__liveHarness.fail(value),
      code,
    );
    await expect(page.getByText(new RegExp(text))).toBeVisible();
    await expect.poll(() => gps(page, 'count')).toBe(0);
    await expect(
      page.getByRole('button', { name: '내 기기 위치 전송 시작', exact: true }),
    ).toBeVisible();
  }
  await page.getByTestId('toggle-location-sharing').click();
  await expect.poll(() => gps(page, 'count')).toBe(1);
  await gps(page, 'emit');
  await expect(page.getByTestId('own-live-location')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByText('인터넷 연결 없음', { exact: true })).toBeVisible();
  await expect.poll(() => gps(page, 'count')).toBe(0);
  await expect(page.getByTestId('own-live-location')).toHaveCount(0);
  await expect(page.getByTestId('connect-live-location')).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByTestId('connect-live-location')).toBeEnabled();
  expect(harness.tickets()).toBe(1);
});

test('leaving the location screen clears its watch and late callbacks cannot send again', async ({
  page,
}) => {
  const harness = await prepare(page);
  await page.getByTestId('connect-live-location').click();
  await expect(page.getByText('기기 연결됨', { exact: true })).toBeVisible();
  await page.getByTestId('toggle-location-sharing').click();
  await expect.poll(() => gps(page, 'count')).toBe(1);
  await gps(page, 'emit');
  await expect(page.getByTestId('own-live-location')).toBeVisible();
  await page.getByRole('button', { name: '뒤로', exact: true }).click();
  await expect(page.getByRole('heading', { name: '이동 계획', exact: true })).toBeVisible();
  await expect.poll(() => gps(page, 'count')).toBe(0);
  await gps(page, 'stale');
  await expect.poll(() => harness.messages.at(-1)?.type).toBe('stop');
  expect(harness.messages.filter((item) => item.type === 'position')).toHaveLength(1);
});

test('positions expire after thirty seconds and hiding the screen disconnects the device', async ({
  page,
}) => {
  await page.clock.install();
  const harness = await prepare(page);
  await page.getByTestId('connect-live-location').click();
  await expect(page.getByText('기기 연결됨', { exact: true })).toBeVisible();
  await page.getByTestId('toggle-location-sharing').click();
  await expect.poll(() => gps(page, 'count')).toBe(1);
  await gps(page, 'emit');
  const instant = await page.evaluate(() => new Date().toISOString());
  harness.sockets[0].send(
    JSON.stringify({
      type: 'position',
      source_id: 'peer-test-device',
      latitude: 37.6,
      longitude: 127.2,
      accuracy_m: 4,
      observed_at: instant,
      received_at: instant,
    }),
  );
  await expect(page.getByTestId('own-live-location')).toBeVisible();
  await expect(page.getByTestId('peer-live-location')).toBeVisible();
  await page.clock.fastForward(31_000);
  await expect(page.getByTestId('own-live-location')).toHaveCount(0);
  await expect(page.getByTestId('peer-live-location')).toHaveCount(0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByText(/화면이 가려져 위치 연결을 멈췄어요/)).toBeVisible();
  await expect.poll(() => gps(page, 'count')).toBe(0);
  await expect(page.getByText('기기 연결 안 됨', { exact: true })).toBeVisible();
  await expect.poll(() => harness.messages.at(-1)?.type).toBe('stop');
});

test('opening another stack screen stops sharing even while the previous screen stays mounted', async ({
  page,
}) => {
  const harness = await prepare(page);
  await page.getByTestId('connect-live-location').click();
  await expect(page.getByText('기기 연결됨', { exact: true })).toBeVisible();
  await page.getByTestId('toggle-location-sharing').click();
  await expect.poll(() => gps(page, 'count')).toBe(1);
  await gps(page, 'emit');
  await expect(page.getByTestId('own-live-location')).toBeVisible();
  await page.getByRole('button', { name: '도착 시간과 경로도 계획하기', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '도착지', exact: true })).toBeVisible();
  await expect.poll(() => gps(page, 'count')).toBe(0);
  await expect.poll(() => harness.messages.at(-1)?.type).toBe('stop');
  await gps(page, 'stale');
  expect(harness.messages.filter((item) => item.type === 'position')).toHaveLength(1);
  await page.getByRole('button', { name: '뒤로', exact: true }).click();
  await expect(page.getByTestId('own-live-location')).toHaveCount(0);
  await expect(page.getByText('기기 연결 안 됨', { exact: true })).toBeVisible();
});
