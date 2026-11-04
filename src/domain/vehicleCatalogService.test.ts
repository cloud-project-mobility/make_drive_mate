import assert from 'node:assert/strict';
import test from 'node:test';
import type { Vehicle } from './types';
import { bundledCatalog } from './vehicleCatalog';
import { BackendClient, BackendError } from '../services/backend';
import {
  deleteRegisteredVehicle,
  fetchVehicleCatalog,
  listRegisteredVehicles,
  saveRegisteredVehicle,
} from '../services/vehicleCatalog';

const vehicle: Vehicle & { catalogId?: string } = {
  id: 'vehicle-1',
  name: '내 차',
  model: '현대 아반떼 · 2023',
  powertrain: 'ICE',
  odometerKm: 10000,
  createdAt: '2026-11-04T00:00:00Z',
  catalogId: 'avante-cn7-pe',
};

function mockClient(body: unknown) {
  const calls: { url: string; options?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    calls.push({ url: String(input), options });
    return new Response(JSON.stringify(body));
  };
  return {
    client: new BackendClient('http://localhost:18085', 'memory-test-token', fetcher),
    calls,
  };
}

function invalidResponse(error: unknown): boolean {
  return (
    error instanceof BackendError &&
    error.code === 'invalid_response' &&
    !error.message.includes('private')
  );
}

test('catalog service requests its API route and validates same-server image URLs', async () => {
  const entry = {
    ...bundledCatalog[0],
    imageUrl: `/api/v1/vehicle-catalog/${bundledCatalog[0].id}/image`,
  };
  const { client, calls } = mockClient({ vehicles: [entry], total: 1 });
  assert.deepEqual(await fetchVehicleCatalog(client), [entry]);
  assert.equal(calls[0].url, 'http://localhost:18085/api/v1/vehicle-catalog');
  assert.equal(calls[0].options?.body, undefined);
  const bad = mockClient({
    vehicles: [{ ...entry, imageUrl: 'https://private.example.test/pixel' }],
    total: 1,
  });
  await assert.rejects(fetchVehicleCatalog(bad.client), invalidResponse);
});

test('vehicle listing validates maximum, uniqueness and complete vehicle records', async () => {
  const valid = mockClient({ vehicles: [vehicle] });
  assert.deepEqual(await listRegisteredVehicles(valid.client), [vehicle]);
  assert.equal(valid.calls[0].url, 'http://localhost:18085/api/v1/vehicles');
  for (const body of [
    { vehicles: [vehicle, vehicle] },
    { vehicles: Array.from({ length: 4 }, (_, index) => ({ ...vehicle, id: `v-${index}` })) },
    { vehicles: [{ ...vehicle, odometerKm: -1 }] },
    { vehicles: [{ ...vehicle, catalogId: '../private' }] },
    { vehicles: [{ ...vehicle, id: 'garage/car ?1' }] },
    { vehicles: [{ ...vehicle, createdAt: '2026-02-30T00:00:00Z' }] },
    { private: 'diagnostics' },
  ])
    await assert.rejects(listRegisteredVehicles(mockClient(body).client), invalidResponse);
});

test('save sends a bare vehicle object matching the backend contract without mutating input', async () => {
  const input = { ...vehicle, id: 'garage_car-1', privateToken: 'must-not-be-sent' };
  const expected = { ...vehicle, id: input.id };
  const { client, calls } = mockClient({
    vehicle: { ...expected, privateDiagnostics: 'must-not-escape' },
  });
  const saved = await saveRegisteredVehicle(client, input);
  assert.equal(calls[0].url, 'http://localhost:18085/api/v1/vehicles/garage_car-1');
  assert.equal(calls[0].options?.method, 'PUT');
  assert.deepEqual(JSON.parse(String(calls[0].options?.body)), expected);
  assert.deepEqual(saved, expected);
  assert.notEqual(saved, input);
  assert.equal(input.privateToken, 'must-not-be-sent');
  assert.equal(
    new Headers(calls[0].options?.headers).get('Authorization'),
    'Bearer memory-test-token',
  );
  assert.equal(calls[0].options?.credentials, 'omit');
  assert.equal(calls[0].options?.redirect, 'error');
});

test('save rejects invalid input without a request and mismatched returned identity', async () => {
  const invalid = mockClient({ vehicle });
  await assert.rejects(
    saveRegisteredVehicle(invalid.client, { ...vehicle, odometerKm: -1 }),
    /저장할 차량/,
  );
  await assert.rejects(
    saveRegisteredVehicle(invalid.client, { ...vehicle, id: 'garage/car ?1' }),
    /저장할 차량/,
  );
  assert.equal(invalid.calls.length, 0);
  for (const response of [
    { ...vehicle, id: 'another-private-vehicle' },
    { ...vehicle, createdAt: '2026-11-03T00:00:00Z' },
    { ...vehicle, powertrain: 'unknown' },
  ])
    await assert.rejects(
      saveRegisteredVehicle(mockClient({ vehicle: response }).client, vehicle),
      invalidResponse,
    );
});

test('delete validates identity and requires an explicit successful result', async () => {
  const { client, calls } = mockClient({ ok: true });
  await deleteRegisteredVehicle(client, 'garage_car-1');
  assert.equal(calls[0].url, 'http://localhost:18085/api/v1/vehicles/garage_car-1');
  assert.equal(calls[0].options?.method, 'DELETE');
  assert.equal(calls[0].options?.body, undefined);
  for (const body of [{ ok: false }, { ok: 'true' }, null]) {
    await assert.rejects(
      deleteRegisteredVehicle(mockClient(body).client, vehicle.id),
      invalidResponse,
    );
  }
  const untouched = mockClient({ ok: true });
  for (const id of ['', ' ', 'x'.repeat(101), 'bad\nvalue', 'garage/car ?1']) {
    await assert.rejects(deleteRegisteredVehicle(untouched.client, id), /삭제할 차량/);
  }
  assert.equal(untouched.calls.length, 0);
});

test('registration helpers preserve backend authentication failures and leave local objects intact', async () => {
  const fetcher: typeof fetch = async () =>
    new Response(
      JSON.stringify({ error: { code: 'unauthorized', message: '다시 로그인해 주세요.' } }),
      { status: 401 },
    );
  const client = new BackendClient('http://localhost:18085', undefined, fetcher);
  const before = JSON.stringify(vehicle);
  await assert.rejects(
    saveRegisteredVehicle(client, vehicle),
    (error: unknown) => error instanceof BackendError && error.status === 401,
  );
  assert.equal(JSON.stringify(vehicle), before);
});
