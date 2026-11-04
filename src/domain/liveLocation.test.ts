/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserLocationHub } from '../services/browserLocation';
import { BackendClient } from '../services/backend';
import { locationSocketUrl, locationTicket, parseLocationMessage } from '../services/liveLocation';

test('location sockets use the same HTTPS origin and never carry credentials in the URL', () => {
  assert.equal(
    locationSocketUrl('https://app.example.test', 'https://app.example.test'),
    'wss://app.example.test/api/v1/location/stream',
  );
  assert.equal(
    locationSocketUrl('http://127.0.0.1:18085', 'http://127.0.0.1:8081'),
    'ws://127.0.0.1:18085/api/v1/location/stream',
  );
  for (const address of [
    'https://other.example.test',
    'https://app.example.test/?token=test',
    'https://user:pass@app.example.test',
    'http://app.example.test',
  ])
    assert.throws(() => locationSocketUrl(address, 'https://app.example.test'));
});

test('location messages reject old, malformed or out-of-range device coordinates', () => {
  const now = Date.parse('2026-11-04T12:00:00Z');
  const valid = {
    type: 'position',
    source_id: 'device-1',
    latitude: 37.5,
    longitude: 127,
    accuracy_m: 20,
    observed_at: new Date(now).toISOString(),
    received_at: new Date(now).toISOString(),
  };
  assert.equal(parseLocationMessage(JSON.stringify(valid), now)?.type, 'position');
  for (const changes of [
    { latitude: 91 },
    { longitude: 181 },
    { accuracy_m: -1 },
    { accuracy_m: null },
    { source_id: '../test' },
    { received_at: new Date(now - 30_001).toISOString() },
    { observed_at: new Date(now - 120_001).toISOString() },
    { observed_at: '2026-11-04' },
  ])
    assert.equal(parseLocationMessage(JSON.stringify({ ...valid, ...changes }), now), null);
  assert.equal(parseLocationMessage('{broken'), null);
  assert.equal(parseLocationMessage('null'), null);
  assert.equal(
    parseLocationMessage(JSON.stringify({ type: 'ready', source_id: 'device-1' }))?.type,
    'ready',
  );
});

test('ticket request uses existing bearer HTTP authentication and validates the one-use response', async () => {
  let authorization: string | undefined;
  let target = '';
  const client = new BackendClient(
    'https://app.example.test',
    'test-session-only',
    async (url, init) => {
      authorization = (init?.headers as Record<string, string>).Authorization;
      target = String(url);
      return new Response(
        JSON.stringify({
          ticket: 'temporary-ticket-for-unit-test',
          expires_at: new Date(Date.now() + 30_000).toISOString(),
        }),
        { status: 200 },
      );
    },
  );
  assert.equal(await locationTicket(client), 'temporary-ticket-for-unit-test');
  assert.equal(authorization, 'Bearer test-session-only');
  assert.equal(target, 'https://app.example.test/api/v1/location/ticket');
  const invalid = new BackendClient(
    'https://app.example.test',
    'test-session-only',
    async () =>
      new Response(JSON.stringify({ ticket: 'short', expires_at: '2000-01-01T00:00:00Z' }), {
        status: 200,
      }),
  );
  await assert.rejects(() => locationTicket(invalid));
});

test('GPS recording and location sharing use one watch and remove only their own subscriptions', () => {
  const hub = createBrowserLocationHub();
  let watches = 0;
  let clears = 0;
  let onPosition: PositionCallback = () => undefined;
  let onError: PositionErrorCallback = () => undefined;
  const browser = {
    watchPosition(position: PositionCallback, error: PositionErrorCallback) {
      watches += 1;
      onPosition = position;
      onError = error;
      return 5;
    },
    clearWatch(id: number) {
      assert.equal(id, 5);
      clears += 1;
    },
  } as unknown as Geolocation;
  let recorderPoints = 0;
  let sharedPoints = 0;
  let reason = '';
  const recorder = hub.subscribe(
    browser,
    () => {
      recorderPoints += 1;
    },
    () => undefined,
  );
  const shared = hub.subscribe(
    browser,
    () => {
      sharedPoints += 1;
    },
    (value) => {
      reason = value;
    },
  );
  assert.equal(watches, 1);
  onPosition({} as GeolocationPosition);
  assert.equal(recorderPoints, 1);
  assert.equal(sharedPoints, 1);
  onError({ code: 3 } as GeolocationPositionError);
  assert.equal(reason, 'timeout');
  shared.remove();
  assert.equal(clears, 0);
  onPosition({} as GeolocationPosition);
  assert.equal(recorderPoints, 2);
  assert.equal(sharedPoints, 1);
  recorder.remove();
  recorder.remove();
  assert.equal(clears, 1);
});

test('late callbacks from a cleared browser watch cannot reach a resumed consumer', () => {
  const hub = createBrowserLocationHub();
  const callbacks: { position: PositionCallback; error: PositionErrorCallback }[] = [];
  const browser = {
    watchPosition(position: PositionCallback, error: PositionErrorCallback) {
      callbacks.push({ position, error });
      return callbacks.length;
    },
    clearWatch() {},
  } as unknown as Geolocation;
  const first = hub.subscribe(
    browser,
    () => undefined,
    () => undefined,
  );
  first.remove();
  let received = 0;
  let failures = 0;
  const resumed = hub.subscribe(
    browser,
    () => {
      received += 1;
    },
    () => {
      failures += 1;
    },
  );
  callbacks[0].position({} as GeolocationPosition);
  callbacks[0].error({ code: 1 } as GeolocationPositionError);
  assert.equal(received, 0);
  assert.equal(failures, 0);
  callbacks[1].position({} as GeolocationPosition);
  assert.equal(received, 1);
  resumed.remove();
});
