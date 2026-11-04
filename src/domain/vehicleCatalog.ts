import catalogData from '../../assets/vehicles/catalog.json';
import type { Powertrain } from './types';

export interface VehicleCatalogEntry {
  id: string;
  manufacturer: string;
  model: string;
  generation: string;
  yearFrom: number;
  yearTo: number | null;
  powertrains: Powertrain[];
  imageUrl?: string;
  imageObjectKey: string;
  imageSourceUrl: string;
  imageAuthor: string;
  imageLicense: string;
  imageLicenseUrl: string;
  representative: true;
  note: string;
}

const CATALOG_ID = /^[a-z0-9-]{1,80}$/;
const INVALID_CATALOG = '차량 카탈로그 응답 형식을 확인할 수 없어요.';
// Catalog provenance notes identify these years as generation transitions.
const GENERATION_TRANSITION_YEARS: Readonly<Record<string, number>> = {
  'k8-gl3': 2024,
  'ev6-cv': 2024,
  'sportage-nq5': 2024,
  'sorento-mq4-pe': 2023,
  'sonata-dn8-pe': 2023,
  'grandeur-gn7': 2022,
  'niro-sg2': 2022,
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function httpsUrl(value: unknown): value is string {
  if (!text(value, 2048) || value !== value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

function year(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1886 && Number(value) <= 2100;
}

function validEntry(value: unknown, requireImageUrl: boolean): value is VehicleCatalogEntry {
  return (
    object(value) &&
    typeof value.id === 'string' &&
    CATALOG_ID.test(value.id) &&
    text(value.manufacturer, 60) &&
    text(value.model, 100) &&
    text(value.generation, 160) &&
    year(value.yearFrom) &&
    (value.yearTo === null || (year(value.yearTo) && value.yearTo >= value.yearFrom)) &&
    Array.isArray(value.powertrains) &&
    value.powertrains.length >= 1 &&
    value.powertrains.length <= 3 &&
    value.powertrains.every((powertrain) => ['ICE', 'HYB', 'EV'].includes(powertrain)) &&
    new Set(value.powertrains).size === value.powertrains.length &&
    (value.imageUrl === undefined && !requireImageUrl
      ? true
      : value.imageUrl === `/api/v1/vehicle-catalog/${value.id}/image`) &&
    value.imageObjectKey === `data/vehicle-catalog/${value.id}.png` &&
    httpsUrl(value.imageSourceUrl) &&
    text(value.imageAuthor, 240) &&
    text(value.imageLicense, 100) &&
    httpsUrl(value.imageLicenseUrl) &&
    value.representative === true &&
    text(value.note, 2000)
  );
}

function copyEntry(value: VehicleCatalogEntry): VehicleCatalogEntry {
  return {
    id: value.id,
    manufacturer: value.manufacturer,
    model: value.model,
    generation: value.generation,
    yearFrom: value.yearFrom,
    yearTo: value.yearTo,
    powertrains: [...value.powertrains],
    ...(value.imageUrl === undefined ? {} : { imageUrl: value.imageUrl }),
    imageObjectKey: value.imageObjectKey,
    imageSourceUrl: value.imageSourceUrl,
    imageAuthor: value.imageAuthor,
    imageLicense: value.imageLicense,
    imageLicenseUrl: value.imageLicenseUrl,
    representative: true,
    note: value.note,
  };
}

function parseEntries(value: unknown, requireImageUrl: boolean): VehicleCatalogEntry[] {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    !value.every((entry) => validEntry(entry, requireImageUrl)) ||
    new Set(value.map((entry) => entry.id)).size !== value.length
  )
    throw new Error(INVALID_CATALOG);
  return value.map(copyEntry);
}

export const bundledCatalog: VehicleCatalogEntry[] = parseEntries(catalogData, false);

/** Only same-server image routes may become image requests; provenance links are separate. */
export function parseVehicleCatalogResponse(value: unknown): VehicleCatalogEntry[] {
  if (
    !object(value) ||
    !Array.isArray(value.vehicles) ||
    !Number.isInteger(value.total) ||
    value.total !== value.vehicles.length
  )
    throw new Error(INVALID_CATALOG);
  return parseEntries(value.vehicles, true);
}

function normalizeModel(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s·•]+/g, '');
}

/** A free-text model must include one year and match exactly one supported generation. */
export function findCatalogEntry(
  entries: readonly VehicleCatalogEntry[],
  id?: string,
  model?: string,
  type?: Powertrain,
): VehicleCatalogEntry | undefined {
  if (id) {
    const entry = entries.find((candidate) => candidate.id === id);
    return entry && (type === undefined || entry.powertrains.includes(type)) ? entry : undefined;
  }
  if (!model || !type) return undefined;
  const years = [...model.matchAll(/\b(?:19|20)\d{2}\b/g)];
  if (years.length !== 1) return undefined;
  const modelYear = Number(years[0][0]);
  const modelName = normalizeModel(model.replace(years[0][0], '').replace(/년형|연식|년/g, ''));
  const matches = entries.filter(
    (entry) =>
      entry.powertrains.includes(type) &&
      modelYear >= entry.yearFrom &&
      (entry.yearTo === null || modelYear <= entry.yearTo) &&
      [normalizeModel(entry.model), normalizeModel(entry.manufacturer + entry.model)].includes(
        modelName,
      ),
  );
  return matches.length === 1 && GENERATION_TRANSITION_YEARS[matches[0].id] !== modelYear
    ? matches[0]
    : undefined;
}
