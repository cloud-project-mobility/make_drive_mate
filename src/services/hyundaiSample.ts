import { isVehicle } from '../domain/state';
import type { Powertrain, Vehicle } from '../domain/types';
import { BackendClient, BackendError } from './backend';

export interface HyundaiSample {
  vehicle: Vehicle;
  status: {
    source: 'hyundai_sample';
    is_mock: true;
    is_sample: true;
    odometer_km: number;
    received_at: string;
    observed_at: string | null;
    provider_timestamp_raw?: string;
    vehicle_profile_source: 'user_selected_app_category';
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function instant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 40 &&
    /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function parseHyundaiSample(value: unknown): HyundaiSample {
  if (!object(value) || !isVehicle(value.vehicle) || !object(value.status))
    throw new BackendError('저장된 샘플 응답을 확인할 수 없어요.', 502, 'invalid_response');
  const vehicle = value.vehicle;
  const status = value.status;
  if (
    !/^[A-Za-z0-9_-]{1,100}$/.test(vehicle.id) ||
    status.source !== 'hyundai_sample' ||
    status.is_mock !== true ||
    status.is_sample !== true ||
    status.vehicle_profile_source !== 'user_selected_app_category' ||
    typeof status.odometer_km !== 'number' ||
    !Number.isFinite(status.odometer_km) ||
    status.odometer_km < 0 ||
    status.odometer_km > 2_000_000 ||
    !instant(status.received_at) ||
    (status.observed_at !== null && !instant(status.observed_at)) ||
    (status.provider_timestamp_raw !== undefined &&
      (typeof status.provider_timestamp_raw !== 'string' ||
        !/^\d{14}$/.test(status.provider_timestamp_raw)))
  )
    throw new BackendError('저장된 샘플 응답을 확인할 수 없어요.', 502, 'invalid_response');
  return {
    vehicle: {
      id: vehicle.id,
      name: vehicle.name,
      model: vehicle.model,
      powertrain: vehicle.powertrain,
      odometerKm: vehicle.odometerKm,
      createdAt: vehicle.createdAt,
    },
    status: {
      source: 'hyundai_sample',
      is_mock: true,
      is_sample: true,
      odometer_km: status.odometer_km,
      received_at: status.received_at,
      observed_at: status.observed_at,
      ...(status.provider_timestamp_raw === undefined
        ? {}
        : { provider_timestamp_raw: status.provider_timestamp_raw }),
      vehicle_profile_source: 'user_selected_app_category',
    },
  };
}

export async function readHyundaiSample(client: BackendClient): Promise<HyundaiSample> {
  return parseHyundaiSample(await client.request<unknown>('/vehicles/hyundai-sample'));
}

export async function importHyundaiSample(
  client: BackendClient,
  powertrain: Powertrain,
): Promise<HyundaiSample> {
  if (!['ICE', 'HYB', 'EV'].includes(powertrain))
    throw new BackendError('앱에서 사용할 차량 분류를 선택해 주세요.', 400, 'invalid_vehicle');
  return parseHyundaiSample(
    await client.request<unknown>(`/vehicles/hyundai-sample?powertrain=${powertrain}`, {
      method: 'POST',
    }),
  );
}
