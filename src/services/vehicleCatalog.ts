import { isVehicle, MAX_VEHICLES } from '../domain/state';
import type { Vehicle } from '../domain/types';
import { parseVehicleCatalogResponse, type VehicleCatalogEntry } from '../domain/vehicleCatalog';
import { BackendClient, BackendError } from './backend';

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidResponse(): BackendError {
  return new BackendError(
    '서버 응답 형식이 올바르지 않아요. 현재 차량 정보는 변경하지 않았어요.',
    502,
    'invalid_response',
  );
}

function validVehicle(value: unknown): value is Vehicle & { catalogId?: string } {
  return (
    isVehicle(value) &&
    object(value) &&
    /^[A-Za-z0-9_-]{1,100}$/.test(value.id) &&
    (value.catalogId === undefined ||
      (typeof value.catalogId === 'string' && /^[a-z0-9-]{1,80}$/.test(value.catalogId)))
  );
}

function copyVehicle(vehicle: Vehicle & { catalogId?: string }): Vehicle {
  return {
    id: vehicle.id,
    name: vehicle.name,
    model: vehicle.model,
    powertrain: vehicle.powertrain,
    odometerKm: vehicle.odometerKm,
    createdAt: vehicle.createdAt,
    ...(vehicle.catalogId === undefined ? {} : { catalogId: vehicle.catalogId }),
  };
}

export async function fetchVehicleCatalog(client: BackendClient): Promise<VehicleCatalogEntry[]> {
  const response = await client.request<unknown>('/vehicle-catalog', { timeoutMs: 5000 });
  try {
    return parseVehicleCatalogResponse(response);
  } catch {
    throw invalidResponse();
  }
}

export async function listRegisteredVehicles(client: BackendClient): Promise<Vehicle[]> {
  const response = await client.request<unknown>('/vehicles');
  if (
    !object(response) ||
    !Array.isArray(response.vehicles) ||
    response.vehicles.length > MAX_VEHICLES ||
    !response.vehicles.every(validVehicle) ||
    new Set(response.vehicles.map((vehicle) => vehicle.id)).size !== response.vehicles.length
  )
    throw invalidResponse();
  return response.vehicles.map(copyVehicle);
}

export async function saveRegisteredVehicle(
  client: BackendClient,
  vehicle: Vehicle,
): Promise<Vehicle> {
  if (!validVehicle(vehicle))
    throw new BackendError('저장할 차량 정보를 확인해 주세요.', 400, 'invalid_vehicle');
  const payload = copyVehicle(vehicle);
  const response = await client.request<unknown>(`/vehicles/${encodeURIComponent(vehicle.id)}`, {
    method: 'PUT',
    body: payload,
  });
  if (
    !object(response) ||
    !validVehicle(response.vehicle) ||
    response.vehicle.id !== payload.id ||
    response.vehicle.createdAt !== payload.createdAt
  )
    throw invalidResponse();
  return copyVehicle(response.vehicle);
}

export async function deleteRegisteredVehicle(client: BackendClient, id: string): Promise<void> {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id))
    throw new BackendError('삭제할 차량 정보를 확인해 주세요.', 400, 'invalid_vehicle');
  const response = await client.request<unknown>(`/vehicles/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!object(response) || response.ok !== true) throw invalidResponse();
}
