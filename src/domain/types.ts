export type Powertrain = 'ICE' | 'HYB' | 'EV';

export interface Vehicle {
  id: string;
  name: string;
  model: string;
  powertrain: Powertrain;
  odometerKm: number;
  createdAt: string;
  catalogId?: string;
}

export interface Coordinates {
  longitude: number;
  latitude: number;
}

export interface TripPlan {
  id: string;
  vehicleId: string;
  origin: string;
  destination: string;
  eventTitle?: string;
  /** ISO timestamp, with a real date so a departure on the previous day is preserved. */
  eventAt?: string;
  driveMinutes: number;
  walkMinutes: number;
  bufferMinutes: number;
  distanceKm?: number;
  originPoint?: Coordinates;
  destinationPoint?: Coordinates;
  route?: { source: 'mock' | 'live'; computedAt: string; expiresAt: string };
  source: 'manual' | 'sample';
  createdAt: string;
}

export interface Trip {
  id: string;
  vehicleId: string;
  startedAt: string;
  endedAt: string;
  distanceKm: number;
  durationSeconds: number;
  source: 'gps' | 'manual' | 'sample';
  origin?: string;
  destination?: string;
  planId?: string;
}

export interface ActiveTrip {
  id: string;
  vehicleId: string;
  startedAt: string;
  distanceKm: number;
  durationSeconds: number;
  origin?: string;
  destination?: string;
  planId?: string;
}

export interface MaintenanceRecord {
  id: string;
  vehicleId: string;
  itemId: string;
  odometerKm: number;
  performedAt: string;
  note?: string;
}

export interface MaintenanceItem {
  id: string;
  name: string;
  intervalKm?: number;
  intervalMonths?: number;
  description: string;
}

export interface Settings {
  walkMinutes: number;
  bufferMinutes: number;
}

export interface AppState {
  version: 1;
  vehicles: Vehicle[];
  selectedVehicleId: string | null;
  trips: Trip[];
  plans: TripPlan[];
  maintenance: MaintenanceRecord[];
  activeTrip: ActiveTrip | null;
  settings: Settings;
  onboarded: boolean;
  demoMode: boolean;
}

export type AppAction =
  | { type: 'COMPLETE_ONBOARDING'; demo: boolean }
  | { type: 'ADD_VEHICLE'; vehicle: Vehicle }
  | { type: 'UPDATE_VEHICLE'; vehicle: Vehicle }
  | { type: 'DELETE_VEHICLE'; vehicleId: string }
  | { type: 'SELECT_VEHICLE'; vehicleId: string }
  | { type: 'ADD_PLAN'; plan: TripPlan }
  | { type: 'DELETE_PLAN'; planId: string }
  | { type: 'ADD_TRIP'; trip: Trip }
  | { type: 'START_TRIP'; trip: ActiveTrip }
  | { type: 'UPDATE_ACTIVE_TRIP'; trip: ActiveTrip }
  | { type: 'DISCARD_ACTIVE_TRIP' }
  | { type: 'ADD_MAINTENANCE'; record: MaintenanceRecord }
  | { type: 'UPDATE_SETTINGS'; settings: Partial<Settings> }
  | { type: 'IMPORT_DATA'; state: AppState }
  | { type: 'RESET_DATA' };

export type ActionResult = { ok: true } | { ok: false; error: string };

export interface StorageError {
  kind: 'load' | 'corrupt' | 'save';
  message: string;
}
