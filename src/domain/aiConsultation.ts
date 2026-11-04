import type { AppState, Vehicle } from './types';
import { bundledCatalog, findCatalogEntry, type VehicleCatalogEntry } from './vehicleCatalog';
import { getVehicleMaintenance } from './maintenance';
import { departureAt, parseNonNegativeNumber } from './helpers';
import type { AuctionAnalysisInput } from '../services/auctionCache';

export interface AuctionDraft {
  make: string;
  model: string;
  year: string;
  mileage: string;
  fuel: string;
  category: string;
  engine: string;
  monthlyKm: string;
  upkeep: string;
}
export function createAuctionDraft(
  vehicle?: Vehicle,
  catalogEntries: VehicleCatalogEntry[] = bundledCatalog,
): AuctionDraft {
  const entry = vehicle
    ? findCatalogEntry(catalogEntries, vehicle.catalogId, vehicle.model, vehicle.powertrain)
    : undefined;
  const years = vehicle?.model.match(/\b(?:19|20)\d{2}\b/g) ?? [];
  return {
    make: entry?.manufacturer ?? '',
    model: entry?.model ?? '',
    year: years.length === 1 ? years[0] : '',
    mileage: vehicle ? String(vehicle.odometerKm) : '',
    fuel: '',
    category: '',
    engine: '',
    monthlyKm: '1000',
    upkeep: '',
  };
}
export function auctionInputFromDraft(draft: AuctionDraft, now = new Date()): AuctionAnalysisInput {
  const number = (raw: string, label: string, max?: number) => {
    const result = parseNonNegativeNumber(raw, label, max);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
  const year = number(draft.year, '연식', now.getFullYear());
  if (
    !Number.isInteger(year) ||
    year < 1970 ||
    !draft.model.trim() ||
    draft.model.trim().length > 100
  )
    throw new Error('실제 모델명과 연식을 확인해 주세요.');
  for (const value of [draft.make, draft.model, draft.fuel, draft.category]) {
    if (value.length > 100 || /[\u0000-\u001f\u007f]/.test(value))
      throw new Error('차량 정보에 지원하지 않는 문자가 있어요.');
  }
  return {
    vehicle: {
      make: draft.make.trim() || null,
      model: draft.model.trim(),
      fuel: draft.fuel.trim() || null,
      vehicle_category: draft.category.trim() || null,
      age_years: now.getFullYear() - year,
      odometer_km: number(draft.mileage, '주행거리'),
      engine_cc: draft.engine.trim() ? number(draft.engine, '배기량', 30_000) : null,
    },
    monthly_km: number(draft.monthlyKm, '월 주행거리', 100_000),
    monthly_upkeep_krw: Math.round(number(draft.upkeep, '월 유지비', 10_000) * 10_000),
    months: [0, 6, 12],
  };
}
// Construct a new allowlisted object. Never spread records containing notes or destinations.
export function consultationContext(state: AppState, vehicle?: Vehicle, now = new Date()) {
  const plan = vehicle
    ? state.plans
        .filter(
          (item) =>
            item.vehicleId === vehicle.id &&
            item.eventAt &&
            Date.parse(item.eventAt) > now.getTime(),
        )
        .sort((a, b) => Date.parse(a.eventAt!) - Date.parse(b.eventAt!))[0]
    : undefined;
  const departure = plan ? departureAt(plan) : null;
  return {
    demo: state.demoMode,
    vehicle: vehicle ? { powertrain: vehicle.powertrain, odometer_km: vehicle.odometerKm } : null,
    maintenance: vehicle
      ? getVehicleMaintenance(vehicle, state.maintenance, now).map((item) => ({
          item: item.item.id,
          status: item.status,
          recorded: item.lastRecord !== null,
        }))
      : [],
    next_plan: plan
      ? {
          event_at: new Date(plan.eventAt!).toISOString(),
          departure_at: departure?.toISOString() ?? null,
          route_fresh:
            !!plan.route &&
            plan.route.source === 'live' &&
            Date.parse(plan.route.expiresAt) > now.getTime(),
          sample: plan.source === 'sample',
        }
      : null,
  };
}
export type ConsultationContext = ReturnType<typeof consultationContext>;
