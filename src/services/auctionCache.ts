import type { Vehicle } from '../domain/types';
import type { BackendClient } from './backend';
import type { AuctionResult } from './onbidValuation';

export interface AuctionAnalysisInput {
  vehicle: {
    make: string | null;
    model: string;
    fuel: string | null;
    vehicle_category: string | null;
    age_years: number;
    odometer_km: number;
    engine_cc: number | null;
  };
  monthly_km: number;
  months: number[];
  monthly_upkeep_krw: number;
}
export interface AuctionCacheEntry {
  result: AuctionResult;
  input: AuctionAnalysisInput;
  createdAt: string;
  demoInput: boolean;
}
// Client identity changes on login/logout/server changes. Never persist this cache.
const cache = new WeakMap<BackendClient, Map<string, AuctionCacheEntry>>();
const listeners = new Set<() => void>();
export const auctionVehicleKey = (vehicle: Vehicle | undefined, demo: boolean) =>
  JSON.stringify([vehicle ?? null, demo]);
export function readAuctionCache(client: BackendClient, key: string) {
  return cache.get(client)?.get(key) ?? null;
}
export function writeAuctionCache(client: BackendClient, key: string, entry: AuctionCacheEntry) {
  const scoped = cache.get(client) ?? new Map<string, AuctionCacheEntry>();
  // Only the latest vehicle snapshot is needed; stale snapshots cannot accumulate.
  scoped.clear();
  scoped.set(key, entry);
  cache.set(client, scoped);
  listeners.forEach((listener) => listener());
}
export function subscribeAuctionCache(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
