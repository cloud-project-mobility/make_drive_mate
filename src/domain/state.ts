import { getMaintenanceItems } from './maintenance';
import type {
  ActiveTrip,
  AppAction,
  AppState,
  MaintenanceRecord,
  Trip,
  TripPlan,
  Vehicle,
} from './types';

export const MAX_VEHICLES = 3;
export const MAX_ODOMETER_KM = 2_000_000;
export const SCHEMA_VERSION = 1 as const;
export const MAX_BACKUP_BYTES = 5 * 1_024 * 1_024;

export function createInitialState(): AppState {
  return {
    version: 1,
    vehicles: [],
    selectedVehicleId: null,
    trips: [],
    plans: [],
    maintenance: [],
    activeTrip: null,
    settings: { walkMinutes: 10, bufferMinutes: 10 },
    onboarded: false,
    demoMode: false,
  };
}

type ObjectValue = Record<string, unknown>;
function object(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown, max = 160): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= max &&
    !/[\u0000-\u001f]/.test(value)
  );
}
function optionalText(value: unknown, max = 160): boolean {
  return value === undefined || text(value, max);
}
function optionalNote(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' &&
      value.trim().length > 0 &&
      value.length <= 500 &&
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))
  );
}
function number(value: unknown, max: number, min = 0): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}
function timestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second] = parts.map(Number);
  const leap = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1] &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59
  );
}
function id(value: unknown): value is string {
  return text(value, 100);
}
function uniqueIds(values: { id: string }[]): boolean {
  return new Set(values.map((value) => value.id)).size === values.length;
}

export function isVehicle(value: unknown): value is Vehicle {
  return (
    object(value) &&
    id(value.id) &&
    text(value.name, 60) &&
    text(value.model, 100) &&
    (value.catalogId === undefined ||
      (typeof value.catalogId === 'string' && /^[a-z0-9-]{1,80}$/.test(value.catalogId))) &&
    typeof value.powertrain === 'string' &&
    ['ICE', 'HYB', 'EV'].includes(value.powertrain) &&
    number(value.odometerKm, MAX_ODOMETER_KM) &&
    timestamp(value.createdAt)
  );
}
export function isTripPlan(value: unknown): value is TripPlan {
  return (
    object(value) &&
    id(value.id) &&
    id(value.vehicleId) &&
    text(value.origin) &&
    text(value.destination) &&
    optionalText(value.eventTitle, 100) &&
    (value.eventAt === undefined || timestamp(value.eventAt)) &&
    number(value.driveMinutes, 1_440, 1) &&
    number(value.walkMinutes, 180) &&
    number(value.bufferMinutes, 180) &&
    (value.distanceKm === undefined || number(value.distanceKm, 10_000)) &&
    (value.originPoint === undefined || coordinates(value.originPoint)) &&
    (value.destinationPoint === undefined || coordinates(value.destinationPoint)) &&
    (value.route === undefined ||
      (object(value.route) &&
        (value.route.source === 'mock' || value.route.source === 'live') &&
        timestamp(value.route.computedAt) &&
        timestamp(value.route.expiresAt) &&
        Date.parse(value.route.expiresAt) > Date.parse(value.route.computedAt) &&
        coordinates(value.originPoint) &&
        coordinates(value.destinationPoint) &&
        number(value.distanceKm, 10_000) &&
        timestamp(value.eventAt) &&
        (value.route.source !== 'mock' || value.source === 'sample'))) &&
    typeof value.source === 'string' &&
    ['manual', 'sample'].includes(value.source) &&
    timestamp(value.createdAt)
  );
}
function coordinates(value: unknown): boolean {
  return object(value) && number(value.longitude, 180, -180) && number(value.latitude, 90, -90);
}
export function isActiveTrip(value: unknown): value is ActiveTrip {
  return (
    object(value) &&
    id(value.id) &&
    id(value.vehicleId) &&
    timestamp(value.startedAt) &&
    number(value.distanceKm, 10_000) &&
    number(value.durationSeconds, 604_800) &&
    (value.planId === undefined || id(value.planId)) &&
    optionalText(value.origin) &&
    optionalText(value.destination)
  );
}
export function isTrip(value: unknown): value is Trip {
  return (
    isActiveTrip(value) &&
    object(value) &&
    timestamp(value.endedAt) &&
    Date.parse(value.endedAt) >= Date.parse(value.startedAt) &&
    value.durationSeconds <=
      (Date.parse(value.endedAt) - Date.parse(value.startedAt)) / 1_000 + 2 &&
    typeof value.source === 'string' &&
    ['gps', 'manual', 'sample'].includes(value.source)
  );
}
export function isMaintenanceRecord(value: unknown): value is MaintenanceRecord {
  return (
    object(value) &&
    id(value.id) &&
    id(value.vehicleId) &&
    id(value.itemId) &&
    number(value.odometerKm, MAX_ODOMETER_KM) &&
    timestamp(value.performedAt) &&
    optionalNote(value.note)
  );
}

export function isAppState(value: unknown): value is AppState {
  if (
    !object(value) ||
    value.version !== 1 ||
    typeof value.onboarded !== 'boolean' ||
    typeof value.demoMode !== 'boolean'
  )
    return false;
  if (
    !Array.isArray(value.vehicles) ||
    value.vehicles.length > MAX_VEHICLES ||
    !value.vehicles.every(isVehicle) ||
    !uniqueIds(value.vehicles)
  )
    return false;
  const vehicles = value.vehicles;
  const ids = new Set(vehicles.map((vehicle) => vehicle.id));
  if (
    value.selectedVehicleId !== null &&
    (!id(value.selectedVehicleId) || !ids.has(value.selectedVehicleId))
  )
    return false;
  if (vehicles.length > 0 && value.selectedVehicleId === null) return false;
  if (
    !object(value.settings) ||
    !number(value.settings.walkMinutes, 180) ||
    !number(value.settings.bufferMinutes, 180)
  )
    return false;
  if (
    value.activeTrip !== null &&
    (!isActiveTrip(value.activeTrip) || !ids.has(value.activeTrip.vehicleId))
  )
    return false;
  if (
    !Array.isArray(value.trips) ||
    value.trips.length > 20_000 ||
    !value.trips.every(isTrip) ||
    !uniqueIds(value.trips) ||
    !value.trips.every((trip) => ids.has(trip.vehicleId))
  )
    return false;
  if (
    !Array.isArray(value.plans) ||
    value.plans.length > 2_000 ||
    !value.plans.every(isTripPlan) ||
    !uniqueIds(value.plans) ||
    !value.plans.every((plan) => ids.has(plan.vehicleId))
  )
    return false;
  if (
    !Array.isArray(value.maintenance) ||
    value.maintenance.length > 20_000 ||
    !value.maintenance.every(isMaintenanceRecord) ||
    !uniqueIds(value.maintenance)
  )
    return false;
  if (
    !value.maintenance.every((record) => {
      const vehicle = vehicles.find((vehicle) => vehicle.id === record.vehicleId);
      return (
        vehicle &&
        record.odometerKm <= vehicle.odometerKm &&
        getMaintenanceItems(vehicle.powertrain).some((item) => item.id === record.itemId)
      );
    })
  )
    return false;
  if (
    value.activeTrip &&
    value.trips.some((trip) => trip.id === (value.activeTrip as ActiveTrip).id)
  )
    return false;
  // Welcome can complete only from an empty installation. Contradictory flags would
  // strand existing records behind the protected navigation stack.
  if (
    !value.onboarded &&
    (value.demoMode ||
      vehicles.length > 0 ||
      value.trips.length > 0 ||
      value.plans.length > 0 ||
      value.maintenance.length > 0 ||
      value.activeTrip !== null)
  )
    return false;
  return true;
}

export type HydrationResult =
  { ok: true; state: AppState; migrated: boolean } | { ok: false; error: string };
function utf8BytesOverLimit(value: string, limit: number): boolean {
  if (value.length > limit) return true;
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
    if (bytes > limit) return true;
  }
  return false;
}

export function parseStoredState(raw: string): HydrationResult {
  if (utf8BytesOverLimit(raw, MAX_BACKUP_BYTES))
    return {
      ok: false,
      error: '데이터가 5 MB 제한을 초과해 불러올 수 없어요. 원본은 변경하지 않았어요.',
    };
  try {
    let parsed: unknown = JSON.parse(raw);
    let migrated = false;
    // v0 used the same models but did not persist plans or interrupted sessions.
    if (object(parsed) && parsed.version === 0) {
      parsed = {
        ...parsed,
        version: 1,
        plans: parsed.plans ?? [],
        activeTrip: parsed.activeTrip ?? null,
      };
      migrated = true;
    }
    if (!isAppState(parsed))
      return {
        ok: false,
        error:
          '저장된 데이터 형식을 확인할 수 없어요. 원본을 보관했어요. 백업 후 초기화하거나 다시 불러와 주세요.',
      };
    return { ok: true, state: parsed, migrated };
  } catch {
    return {
      ok: false,
      error:
        '저장된 데이터를 읽을 수 없어요. 원본은 덮어쓰지 않았어요. 백업 후 초기화하거나 다시 불러와 주세요.',
    };
  }
}

export function createDemoState(now = new Date()): AppState {
  const state = createInitialState();
  const createdAt = now.toISOString();
  state.vehicles = [
    {
      id: 'demo-avante',
      name: '나의 아반떼',
      model: '현대 아반떼 · 2023',
      powertrain: 'ICE',
      odometerKm: 48_250,
      createdAt,
    },
    {
      id: 'demo-k5',
      name: '우리 집 K5',
      model: '기아 K5 · 2024',
      powertrain: 'HYB',
      odometerKm: 26_340,
      createdAt,
    },
    {
      id: 'demo-ioniq5',
      name: '아이오닉 5',
      model: '현대 아이오닉 5 · 2024',
      powertrain: 'EV',
      odometerKm: 31_780,
      createdAt,
    },
  ];
  const performedAt = new Date(now.getTime() - 90 * 86_400_000).toISOString();
  state.maintenance = [
    {
      id: 'demo-oil-1',
      vehicleId: 'demo-avante',
      itemId: 'engine-oil',
      odometerKm: 39_000,
      performedAt,
    },
    {
      id: 'demo-air-1',
      vehicleId: 'demo-avante',
      itemId: 'engine-air-filter',
      odometerKm: 28_500,
      performedAt,
    },
    {
      id: 'demo-oil-2',
      vehicleId: 'demo-k5',
      itemId: 'engine-oil',
      odometerKm: 21_000,
      performedAt,
    },
    {
      id: 'demo-brakes-2',
      vehicleId: 'demo-k5',
      itemId: 'brakes',
      odometerKm: 16_000,
      performedAt,
    },
    {
      id: 'demo-cabin-3',
      vehicleId: 'demo-ioniq5',
      itemId: 'cabin-filter',
      odometerKm: 27_000,
      performedAt,
    },
  ];
  state.selectedVehicleId = state.vehicles[0].id;
  state.onboarded = true;
  state.demoMode = true;
  return state;
}

export class DomainError extends Error {}
function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DomainError(message);
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'COMPLETE_ONBOARDING':
      requireCondition(
        !state.onboarded && state.vehicles.length === 0,
        '이미 시작한 데이터가 있어요. 기존 차량을 계속 이용해 주세요.',
      );
      return action.demo ? createDemoState() : { ...state, onboarded: true, demoMode: false };
    case 'ADD_VEHICLE':
      requireCondition(
        state.vehicles.length < MAX_VEHICLES,
        '차량은 최대 3대까지 등록할 수 있어요.',
      );
      requireCondition(
        isVehicle(action.vehicle),
        '차량 이름, 모델, 구동 방식과 주행거리를 확인해 주세요.',
      );
      requireCondition(
        !state.vehicles.some((vehicle) => vehicle.id === action.vehicle.id),
        '이미 등록된 차량이에요.',
      );
      return {
        ...state,
        vehicles: [...state.vehicles, action.vehicle],
        selectedVehicleId: action.vehicle.id,
      };
    case 'UPDATE_VEHICLE': {
      const old = state.vehicles.find((vehicle) => vehicle.id === action.vehicle.id);
      requireCondition(old && isVehicle(action.vehicle), '수정할 차량 정보를 확인해 주세요.');
      requireCondition(
        action.vehicle.odometerKm >= old.odometerKm,
        '누적 주행거리는 현재 기록보다 작게 변경할 수 없어요.',
      );
      requireCondition(
        state.activeTrip?.vehicleId !== old.id || action.vehicle.odometerKm === old.odometerKm,
        '주행 기록을 마친 뒤 누적 거리를 수정해 주세요.',
      );
      requireCondition(
        old.powertrain === action.vehicle.powertrain ||
          !state.maintenance.some((record) => record.vehicleId === old.id),
        '점검 기록이 있는 차량의 구동 방식은 변경할 수 없어요.',
      );
      return {
        ...state,
        vehicles: state.vehicles.map((vehicle) =>
          vehicle.id === old.id ? { ...action.vehicle, createdAt: old.createdAt } : vehicle,
        ),
      };
    }
    case 'DELETE_VEHICLE': {
      requireCondition(
        state.activeTrip?.vehicleId !== action.vehicleId,
        '주행을 저장하거나 취소한 뒤 차량을 삭제해 주세요.',
      );
      const vehicles = state.vehicles.filter((vehicle) => vehicle.id !== action.vehicleId);
      return {
        ...state,
        vehicles,
        selectedVehicleId:
          state.selectedVehicleId === action.vehicleId
            ? (vehicles[0]?.id ?? null)
            : state.selectedVehicleId,
        trips: state.trips.filter((trip) => trip.vehicleId !== action.vehicleId),
        plans: state.plans.filter((plan) => plan.vehicleId !== action.vehicleId),
        maintenance: state.maintenance.filter((record) => record.vehicleId !== action.vehicleId),
      };
    }
    case 'SELECT_VEHICLE':
      requireCondition(
        state.vehicles.some((vehicle) => vehicle.id === action.vehicleId),
        '차량을 찾을 수 없어요.',
      );
      return { ...state, selectedVehicleId: action.vehicleId };
    case 'ADD_PLAN':
      requireCondition(
        isTripPlan(action.plan) &&
          state.vehicles.some((vehicle) => vehicle.id === action.plan.vehicleId),
        '이동 계획의 차량, 장소와 시간을 확인해 주세요.',
      );
      requireCondition(
        !state.plans.some((plan) => plan.id === action.plan.id),
        '이미 저장한 계획이에요.',
      );
      requireCondition(
        state.plans.length < 2_000,
        '이동 계획이 가득 찼어요. 지난 계획을 정리해 주세요.',
      );
      return { ...state, plans: [action.plan, ...state.plans] };
    case 'DELETE_PLAN':
      return { ...state, plans: state.plans.filter((plan) => plan.id !== action.planId) };
    case 'START_TRIP':
      requireCondition(
        !state.activeTrip,
        '이미 기록 중인 주행이 있어요. 먼저 저장하거나 취소해 주세요.',
      );
      requireCondition(
        isActiveTrip(action.trip) &&
          state.vehicles.some((vehicle) => vehicle.id === action.trip.vehicleId),
        '주행을 시작할 차량을 확인해 주세요.',
      );
      requireCondition(
        !state.trips.some((trip) => trip.id === action.trip.id),
        '이미 저장한 주행이에요.',
      );
      return { ...state, activeTrip: action.trip };
    case 'UPDATE_ACTIVE_TRIP':
      requireCondition(
        isActiveTrip(action.trip) &&
          state.activeTrip?.id === action.trip.id &&
          state.activeTrip.vehicleId === action.trip.vehicleId &&
          state.activeTrip.planId === action.trip.planId &&
          state.activeTrip.origin === action.trip.origin &&
          state.activeTrip.destination === action.trip.destination &&
          state.activeTrip.startedAt === action.trip.startedAt,
        '진행 중인 주행 정보를 확인해 주세요.',
      );
      requireCondition(
        action.trip.distanceKm >= state.activeTrip.distanceKm &&
          action.trip.durationSeconds >= state.activeTrip.durationSeconds,
        '이미 기록된 거리와 시간을 줄일 수 없어요.',
      );
      return { ...state, activeTrip: action.trip };
    case 'DISCARD_ACTIVE_TRIP':
      return { ...state, activeTrip: null };
    case 'ADD_TRIP': {
      requireCondition(isTrip(action.trip), '저장할 주행의 시간과 거리를 확인해 주세요.');
      const vehicle = state.vehicles.find((vehicle) => vehicle.id === action.trip.vehicleId);
      requireCondition(vehicle, '기록할 차량을 찾을 수 없어요.');
      requireCondition(
        !state.trips.some((trip) => trip.id === action.trip.id),
        '이미 저장한 주행이에요.',
      );
      requireCondition(
        state.trips.length < 20_000,
        '주행 기록이 가득 찼어요. 데이터를 백업하고 정리해 주세요.',
      );
      if (state.activeTrip?.id === action.trip.id) {
        requireCondition(
          action.trip.vehicleId === state.activeTrip.vehicleId &&
            action.trip.startedAt === state.activeTrip.startedAt &&
            action.trip.planId === state.activeTrip.planId &&
            action.trip.origin === state.activeTrip.origin &&
            action.trip.destination === state.activeTrip.destination &&
            action.trip.durationSeconds >= state.activeTrip.durationSeconds &&
            action.trip.distanceKm >= state.activeTrip.distanceKm,
          '진행 중인 주행 정보와 일치하지 않아요.',
        );
      }
      const distance = action.trip.source === 'sample' ? 0 : action.trip.distanceKm;
      requireCondition(
        vehicle.odometerKm + distance <= MAX_ODOMETER_KM,
        '누적 주행거리 상한을 초과해 저장할 수 없어요.',
      );
      return {
        ...state,
        trips: [action.trip, ...state.trips],
        activeTrip: state.activeTrip?.id === action.trip.id ? null : state.activeTrip,
        vehicles: state.vehicles.map((item) =>
          item.id === vehicle.id
            ? { ...item, odometerKm: Math.round((item.odometerKm + distance) * 1_000) / 1_000 }
            : item,
        ),
      };
    }
    case 'ADD_MAINTENANCE': {
      const vehicle = state.vehicles.find((vehicle) => vehicle.id === action.record.vehicleId);
      requireCondition(
        isMaintenanceRecord(action.record) && vehicle,
        '점검 기록의 날짜와 주행거리를 확인해 주세요.',
      );
      requireCondition(
        action.record.odometerKm <= vehicle.odometerKm,
        '점검 시 주행거리는 현재 누적 주행거리 이하여야 해요.',
      );
      requireCondition(
        Date.parse(action.record.performedAt) <= Date.now(),
        '미래 날짜의 점검은 완료 기록으로 저장할 수 없어요.',
      );
      requireCondition(
        getMaintenanceItems(vehicle.powertrain).some((item) => item.id === action.record.itemId),
        '이 차량에 해당하는 점검 항목을 선택해 주세요.',
      );
      requireCondition(
        !state.maintenance.some((record) => record.id === action.record.id),
        '이미 저장된 점검 기록이에요.',
      );
      requireCondition(
        state.maintenance.length < 20_000,
        '점검 기록이 가득 찼어요. 데이터를 백업하고 정리해 주세요.',
      );
      return { ...state, maintenance: [action.record, ...state.maintenance] };
    }
    case 'UPDATE_SETTINGS': {
      const settings = { ...state.settings, ...action.settings };
      requireCondition(
        number(settings.walkMinutes, 180) && number(settings.bufferMinutes, 180),
        '도보와 여유 시간은 0~180분 사이로 입력해 주세요.',
      );
      return { ...state, settings };
    }
    case 'IMPORT_DATA':
      requireCondition(
        !state.activeTrip,
        '진행 중인 주행을 저장하거나 취소한 뒤 백업을 복원해 주세요.',
      );
      requireCondition(
        isAppState(action.state) && action.state.onboarded,
        '시작을 완료한 DriveMate 백업 데이터만 복원할 수 있어요.',
      );
      requireCondition(
        !action.state.activeTrip,
        '진행 중인 주행이 포함된 백업은 복원할 수 없어요. 원래 기기에서 주행을 마친 뒤 다시 백업해 주세요.',
      );
      requireCondition(
        !utf8BytesOverLimit(JSON.stringify(action.state), MAX_BACKUP_BYTES),
        '백업 파일은 5 MB 이하여야 해요.',
      );
      return JSON.parse(JSON.stringify(action.state)) as AppState;
    case 'RESET_DATA':
      requireCondition(!state.activeTrip, '진행 중인 주행을 저장하거나 취소한 뒤 초기화해 주세요.');
      return createInitialState();
    default:
      return state;
  }
}
