import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendClient, BackendError } from '../services/backend';
import { importHyundaiSample, parseHyundaiSample, readHyundaiSample } from '../services/hyundaiSample';

const sample = {
  vehicle: {
    id: 'account-sample-1',
    name: '현대 샘플 차량',
    model: '현대 샘플 차량 · 차종 미확인',
    powertrain: 'EV',
    odometerKm: 12500,
    createdAt: '2026-11-07T00:00:00Z',
  },
  status: {
    source: 'hyundai_sample',
    is_mock: true,
    is_sample: true,
    odometer_km: 12500,
    received_at: '2026-11-07T00:00:00Z',
    observed_at: null,
    provider_timestamp_raw: '20261028090000',
    vehicle_profile_source: 'user_selected_app_category',
  },
};

function mockClient(body: unknown, status = 200) {
  const calls: { url: string; options?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    calls.push({ url: String(input), options });
    return new Response(JSON.stringify(body), { status });
  };
  return {
    client: new BackendClient('http://localhost:18085', 'memory-test-token', fetcher),
    calls,
  };
}

test('sample parser preserves explicit sample provenance and drops unrequested fields', () => {
  assert.deepEqual(
    parseHyundaiSample({
      ...sample,
      vehicle: { ...sample.vehicle, private: 'private-value' },
      status: { ...sample.status, private: 'private-value', battery_percent: 72 },
    }),
    sample,
  );
});

test('sample parser rejects fabricated provenance and malformed readings', () => {
  for (const status of [
    { ...sample.status, source: 'mock' },
    { ...sample.status, source: 'live' },
    { ...sample.status, is_sample: false },
    { ...sample.status, is_mock: false },
    { ...sample.status, odometer_km: -1 },
    { ...sample.status, odometer_km: Infinity },
    { ...sample.status, odometer_km: 2_000_001 },
    { ...sample.status, received_at: '2026-11-07' },
    { ...sample.status, observed_at: '2026-11-07T09:00:00' },
    { ...sample.status, provider_timestamp_raw: 'private-diagnostics' },
    { ...sample.status, vehicle_profile_source: 'hyundai' },
  ]) {
    assert.throws(
      () => parseHyundaiSample({ ...sample, status }),
      (error: unknown) => error instanceof BackendError && error.code === 'invalid_response',
    );
  }
  assert.throws(() => parseHyundaiSample({ ...sample, vehicle: { ...sample.vehicle, id: '../bad' } }));
});

test('import sends only the selected app category and existing account authentication', async () => {
  const { client, calls } = mockClient(sample);
  assert.deepEqual(await importHyundaiSample(client, 'EV'), sample);
  assert.equal(calls[0].url, 'http://localhost:18085/api/v1/vehicles/hyundai-sample?powertrain=EV');
  assert.equal(calls[0].options?.method, 'POST');
  assert.equal(calls[0].options?.body, undefined);
  assert.equal(new Headers(calls[0].options?.headers).get('Authorization'), 'Bearer memory-test-token');
});

test('saved sample reads never make an import request and preserve not-found errors', async () => {
  const { client, calls } = mockClient(sample);
  assert.deepEqual(await readHyundaiSample(client), sample);
  assert.equal(calls[0].url, 'http://localhost:18085/api/v1/vehicles/hyundai-sample');
  assert.notEqual(calls[0].options?.method, 'POST');
  await assert.rejects(
    readHyundaiSample(mockClient({ error: { code: 'not_found', message: 'No sample' } }, 404).client),
    (error: unknown) => error instanceof BackendError && error.status === 404,
  );
});
