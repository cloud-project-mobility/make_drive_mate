import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendClient, BackendError, normalizeBackendUrl } from '../services/backend';

test('backend addresses accept local native LAN and HTTPS but reject credentials and insecure remote hosts', () => {
  assert.equal(normalizeBackendUrl(' http://127.0.0.1:8000/ '), 'http://127.0.0.1:8000');
  assert.equal(normalizeBackendUrl('http://192.168.0.4:8000'), 'http://192.168.0.4:8000');
  assert.equal(normalizeBackendUrl('http://10.0.2.2:8000'), 'http://10.0.2.2:8000');
  assert.equal(normalizeBackendUrl('https://demo.example.test'), 'https://demo.example.test');
  for (const url of [
    'file:///tmp/a',
    'http://remote.example.test',
    'http://127.example.test',
    'http://192.168.example.test',
    'https://user:secret@example.test',
    'https://example.test/api',
    'https://example.test/?key=secret',
    'https://example.test/#token',
  ])
    assert.throws(() => normalizeBackendUrl(url), BackendError);
});

test('API requests carry a memory bearer, omit cookies, reject redirects, and encode queries', async () => {
  const calls: { url: string; options?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    calls.push({ url: String(input), options });
    return new Response(JSON.stringify({ source: 'mock', places: [] }), { status: 200 });
  };
  await new BackendClient('http://127.0.0.1:8000', 'test-only-token', fetcher).places(
    '서울역 & 시청',
  );
  assert.equal(
    calls[0].url,
    'http://127.0.0.1:8000/api/v1/places?q=%EC%84%9C%EC%9A%B8%EC%97%AD%20%26%20%EC%8B%9C%EC%B2%AD',
  );
  assert.equal(
    new Headers(calls[0].options?.headers).get('Authorization'),
    'Bearer test-only-token',
  );
  assert.equal(calls[0].options?.credentials, 'omit');
  assert.equal(calls[0].options?.redirect, 'error');
});

test('snapshot conflicts preserve error status and message for a fresh review', async () => {
  const fetcher: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        error: { code: 'revision_conflict', message: '다른 기기에서 먼저 저장했어요.' },
      }),
      { status: 409 },
    );
  await assert.rejects(
    new BackendClient('http://localhost:8000', 'token', fetcher).snapshot(),
    (error: unknown) =>
      error instanceof BackendError &&
      error.status === 409 &&
      error.code === 'revision_conflict' &&
      error.message === '다른 기기에서 먼저 저장했어요.',
  );
});

test('provider reauthorization preserves the local account session while local authentication failure clears it', async () => {
  for (const code of ['oauth_reauthorization_required', 'unauthorized']) {
    let invalidatedSessions = 0;
    const fetcher: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { code, message: '다시 연결해 주세요.' } }), {
        status: 401,
      });
    const client = new BackendClient(
      'http://localhost:8000',
      'valid-local-session',
      fetcher,
      () => {
        invalidatedSessions += 1;
      },
    );
    await assert.rejects(
      client.calendar(),
      (error: unknown) =>
        error instanceof BackendError && error.status === 401 && error.code === code,
    );
    assert.equal(invalidatedSessions, code === 'unauthorized' ? 1 : 0);
  }
});

test('invalid JSON and unavailable servers return actionable errors without response contents', async () => {
  const html: typeof fetch = async () =>
    new Response('<html>private upstream diagnostics</html>', { status: 502 });
  await assert.rejects(
    new BackendClient('http://localhost:8000', undefined, html).health(),
    /DriveMate API 주소/,
  );
  const unavailable: typeof fetch = async () => {
    throw new Error('internal socket exception');
  };
  await assert.rejects(
    new BackendClient('http://localhost:8000', undefined, unavailable).health(),
    /서버에 연결하지 못했어요/,
  );
});

test('route body sends coordinates and timezone-aware arrival, preserving mock attribution', async () => {
  let payload: Record<string, unknown> = {};
  const fetcher: typeof fetch = async (_url, options) => {
    payload = JSON.parse(String(options?.body));
    return new Response(
      JSON.stringify({
        source: 'mock',
        duration_s: 720,
        distance_m: 2100,
        departure_at: '2026-10-30T05:28:00Z',
        arrival_at: '2026-10-30T06:00:00Z',
        computed_at: '2026-10-28T00:00:00Z',
        expires_at: '2026-10-28T00:05:00Z',
      }),
    );
  };
  const origin = {
    id: 'seoul',
    name: '서울역',
    address: '서울',
    longitude: 126.9726,
    latitude: 37.5547,
  };
  const destination = {
    id: 'cityhall',
    name: '서울시청',
    address: '서울',
    longitude: 126.9784,
    latitude: 37.5666,
  };
  const result = await new BackendClient('http://localhost:8000', 'token', fetcher).route(
    origin,
    destination,
    '2026-10-30T15:00:00+09:00',
    10,
    10,
  );
  assert.deepEqual(payload, {
    origin: { longitude: 126.9726, latitude: 37.5547 },
    destination: { longitude: 126.9784, latitude: 37.5666 },
    arrival_at: '2026-10-30T15:00:00+09:00',
    walk_minutes: 10,
    buffer_minutes: 10,
  });
  assert.equal(result.source, 'mock');
});

test('malformed successful provider responses are rejected before screens can render or apply data', async () => {
  const cases: { body: unknown; call: (client: BackendClient) => Promise<unknown> }[] = [
    {
      body: {
        source: 'mock',
        places: [{ id: 'x', name: 'broken', address: '', longitude: null, latitude: 37 }],
      },
      call: (client) => client.places('서울'),
    },
    { body: { source: 'mystery', places: [] }, call: (client) => client.places('서울') },
    {
      body: {
        source: 'mock',
        events: [
          {
            id: 'x',
            title: 'bad date',
            location: null,
            all_day: true,
            start_at: null,
            end_at: null,
            start_date: '2026-02-30',
            end_date: '2026-03-02',
          },
        ],
      },
      call: (client) => client.calendar(),
    },
    {
      body: {
        source: 'mock',
        events: [
          {
            id: 'x',
            title: 'naive timezone',
            location: null,
            all_day: false,
            start_at: '2026-10-30T09:00:00',
            end_at: '2026-10-30T10:00:00',
            start_date: null,
            end_date: null,
          },
        ],
      },
      call: (client) => client.calendar(),
    },
    {
      body: {
        source: 'mock',
        odometer_km: 12500,
        range_km: 100,
        battery_percent: 150,
        warnings: {},
        observed_at: null,
        received_at: '2026-10-28T00:00:00Z',
      },
      call: (client) => client.vehicleStatus('EV'),
    },
    {
      body: { revision: 1, state: { vehicles: [] }, updated_at: null },
      call: (client) => client.snapshot(),
    },
    {
      body: {
        access_token: 'x',
        token_type: 'bearer',
        user: { id: 'x', email: 'x@example.test' },
        expires_at: 'not-a-date',
      },
      call: (client) => client.authenticate('login', 'x@example.test', 'test-only-password'),
    },
  ];
  for (const item of cases) {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify(item.body));
    await assert.rejects(
      item.call(new BackendClient('http://localhost:8000', 'token', fetcher)),
      (error: unknown) => error instanceof BackendError && error.code === 'invalid_response',
    );
  }
});
