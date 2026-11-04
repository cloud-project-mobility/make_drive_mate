export type VehiclePhotoKey = 'avante' | 'k5' | 'ioniq5';

/** Photos identify the model only, never the individual vehicle or its condition. */
export function vehiclePhotoKey(model: string): VehiclePhotoKey | undefined {
  const normalized = model.toLowerCase().replace(/\s+/g, ' ').trim();
  if (/(?:아반떼|avante|elantra)(?:[^a-z]|$)/.test(normalized)) return 'avante';
  if (/(?:^|기아\s*|kia\s*)k5(?:[^a-z0-9]|$)/.test(normalized)) return 'k5';
  if (/(?:아이오닉|ioniq)\s*5(?:[^0-9]|$)/.test(normalized)) return 'ioniq5';
  return undefined;
}
