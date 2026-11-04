import type { MaintenanceItem, MaintenanceRecord, Powertrain, Vehicle } from './types';

const common: MaintenanceItem[] = [
  {
    id: 'tires',
    name: '타이어',
    intervalKm: 40_000,
    description: '마모·공기압·손상 상태를 함께 확인해요.',
  },
  {
    id: 'brakes',
    name: '브레이크',
    intervalKm: 20_000,
    description: '패드와 제동 상태를 정비소에서 확인해요.',
  },
  {
    id: 'cabin-filter',
    name: '실내 필터',
    intervalKm: 10_000,
    intervalMonths: 12,
    description: '먼지가 많거나 냄새가 나면 먼저 확인해요.',
  },
  {
    id: 'wipers',
    name: '와이퍼',
    intervalMonths: 12,
    description: '시야가 흐리거나 소음이 나면 상태를 확인해요.',
  },
];
const engine: MaintenanceItem[] = [
  {
    id: 'engine-oil',
    name: '엔진오일',
    intervalKm: 10_000,
    intervalMonths: 12,
    description: '제조사 규격과 가혹 조건 교환 주기를 확인해요.',
  },
  {
    id: 'engine-air-filter',
    name: '엔진 에어필터',
    intervalKm: 20_000,
    description: '차종과 운행 환경에 따라 주기가 달라요.',
  },
];

/** These defaults reproduce the design's examples, not a vehicle-specific service schedule. */
export function getMaintenanceItems(powertrain: Powertrain): MaintenanceItem[] {
  return [
    ...common,
    ...(powertrain === 'EV'
      ? [
          {
            id: 'cooling',
            name: '냉각 시스템',
            description: '제조사 매뉴얼에 따른 전문 점검이 필요해요.',
          },
        ]
      : engine),
  ].map((item) => ({ ...item }));
}

export interface MaintenanceStatus {
  item: MaintenanceItem;
  status: 'unrecorded' | 'ok' | 'dueSoon' | 'overdue' | 'manual';
  label: string;
  remainingKm: number | null;
  remainingDays: number | null;
  dueAt: string | null;
  lastRecord: MaintenanceRecord | null;
}

function addMonthsClamped(date: Date, months: number): Date {
  const year = date.getFullYear();
  const month = date.getMonth() + months;
  const end = new Date(year, month + 1, 0).getDate();
  return new Date(
    year,
    month,
    Math.min(date.getDate(), end),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  );
}

export function getMaintenanceStatus(
  vehicle: Vehicle,
  item: MaintenanceItem,
  records: MaintenanceRecord[],
  now = new Date(),
): MaintenanceStatus {
  const lastRecord =
    records
      .filter((record) => record.vehicleId === vehicle.id && record.itemId === item.id)
      .sort(
        (left, right) =>
          Date.parse(right.performedAt) - Date.parse(left.performedAt) ||
          right.odometerKm - left.odometerKm,
      )[0] ?? null;
  if (!lastRecord)
    return {
      item,
      status: 'unrecorded',
      label: '점검 기록이 필요해요',
      remainingKm: null,
      remainingDays: null,
      dueAt: null,
      lastRecord: null,
    };
  const remainingKm =
    item.intervalKm == null ? null : lastRecord.odometerKm + item.intervalKm - vehicle.odometerKm;
  const dueDate =
    item.intervalMonths == null
      ? null
      : addMonthsClamped(new Date(lastRecord.performedAt), item.intervalMonths);
  const remainingDays = dueDate
    ? Math.ceil((dueDate.getTime() - now.getTime()) / 86_400_000)
    : null;
  const overdue =
    (remainingKm != null && remainingKm <= 0) || (remainingDays != null && remainingDays <= 0);
  const dueSoon =
    (remainingKm != null && remainingKm <= 1_000) || (remainingDays != null && remainingDays <= 30);
  const status = overdue
    ? 'overdue'
    : dueSoon
      ? 'dueSoon'
      : remainingKm == null && remainingDays == null
        ? 'manual'
        : 'ok';
  const parts = [
    remainingKm == null
      ? null
      : remainingKm <= 0
        ? `${Math.abs(remainingKm).toLocaleString('ko-KR', { maximumFractionDigits: 1 })} km 초과`
        : `${remainingKm.toLocaleString('ko-KR', { maximumFractionDigits: 1 })} km 남음`,
    remainingDays == null
      ? null
      : remainingDays <= 0
        ? `${Math.abs(remainingDays)}일 경과`
        : `${remainingDays}일 남음`,
  ].filter(Boolean);
  return {
    item,
    status,
    label: parts.join(' · ') || '제조사 기준으로 확인',
    remainingKm,
    remainingDays,
    dueAt: dueDate?.toISOString() ?? null,
    lastRecord,
  };
}

export function getVehicleMaintenance(
  vehicle: Vehicle,
  records: MaintenanceRecord[],
  now = new Date(),
): MaintenanceStatus[] {
  const priority = { overdue: 0, dueSoon: 1, unrecorded: 2, manual: 3, ok: 4 };
  return getMaintenanceItems(vehicle.powertrain)
    .map((item) => getMaintenanceStatus(vehicle, item, records, now))
    .sort((a, b) => priority[a.status] - priority[b.status]);
}
