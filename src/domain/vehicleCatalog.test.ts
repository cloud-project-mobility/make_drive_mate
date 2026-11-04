import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bundledCatalog,
  findCatalogEntry,
  parseVehicleCatalogResponse,
  type VehicleCatalogEntry,
} from './vehicleCatalog';

function remoteEntry(): VehicleCatalogEntry {
  const entry = bundledCatalog[0];
  return {
    ...entry,
    powertrains: [...entry.powertrains],
    imageUrl: `/api/v1/vehicle-catalog/${entry.id}/image`,
  };
}

test('bundled catalog is validated and preserves the three existing demo matches', () => {
  assert.ok(bundledCatalog.length > 0 && bundledCatalog.length <= 100);
  assert.equal(
    findCatalogEntry(bundledCatalog, undefined, '현대 아반떼 · 2023', 'ICE')?.id,
    'avante-cn7-pe',
  );
  assert.equal(
    findCatalogEntry(bundledCatalog, undefined, '기아 K5 · 2024', 'HYB')?.id,
    'k5-dl3-pe',
  );
  assert.equal(
    findCatalogEntry(bundledCatalog, undefined, '현대 아이오닉 5 · 2024', 'EV')?.id,
    'ioniq5-ne',
  );
});

test('explicit catalog identity wins but never borrows another image for a wrong ID or powertrain', () => {
  assert.equal(
    findCatalogEntry(bundledCatalog, 'k5-dl3-pe', '현대 아반떼 · 2023', 'HYB')?.id,
    'k5-dl3-pe',
  );
  assert.equal(findCatalogEntry(bundledCatalog, 'missing', '기아 K5 · 2024', 'HYB'), undefined);
  assert.equal(findCatalogEntry(bundledCatalog, 'k5-dl3-pe', '기아 K5 · 2024', 'EV'), undefined);
});

test('free-text fallback requires a supported year, exact model and matching powertrain', () => {
  for (const model of [
    '아반떼',
    '아반떼 2010',
    '아반떼 N 2023',
    '아반떼 2023 2024',
    '기아 K50 2024',
    '현대 아이오닉 6 2024',
  ]) {
    assert.equal(findCatalogEntry(bundledCatalog, undefined, model, 'ICE'), undefined, model);
  }
  assert.equal(findCatalogEntry(bundledCatalog, undefined, '아반떼 2023'), undefined);
  assert.equal(findCatalogEntry(bundledCatalog, undefined, '아반떼 2023', 'EV'), undefined);
  assert.equal(
    findCatalogEntry(bundledCatalog, undefined, '아반떼 2023년형', 'ICE')?.id,
    'avante-cn7-pe',
  );
});

test('overlapping generations require explicit selection instead of first-match guessing', () => {
  const original = bundledCatalog.find((entry) => entry.id === 'avante-cn7-pe')!;
  const overlap = { ...original, id: 'avante-cn7', generation: 'CN7 부분변경 전' };
  assert.equal(
    findCatalogEntry([original, overlap], undefined, '현대 아반떼 2023', 'ICE'),
    undefined,
  );
  assert.equal(findCatalogEntry([original, overlap], overlap.id, undefined, 'ICE'), overlap);
});

test('known transition years require a catalog selection even when only one generation is bundled', () => {
  for (const [id, transitionYear] of [
    ['k8-gl3', 2024],
    ['ev6-cv', 2024],
    ['sportage-nq5', 2024],
    ['sorento-mq4-pe', 2023],
    ['sonata-dn8-pe', 2023],
    ['grandeur-gn7', 2022],
    ['niro-sg2', 2022],
  ] as const) {
    const entry = bundledCatalog.find((candidate) => candidate.id === id)!;
    const model = `${entry.manufacturer} ${entry.model} ${transitionYear}`;
    const type = entry.powertrains[0];
    assert.equal(findCatalogEntry(bundledCatalog, undefined, model, type), undefined, id);
    assert.equal(findCatalogEntry(bundledCatalog, id, model, type), entry, id);
    const unambiguousYear =
      transitionYear === entry.yearFrom ? transitionYear + 1 : transitionYear - 1;
    assert.equal(
      findCatalogEntry(
        bundledCatalog,
        undefined,
        `${entry.manufacturer} ${entry.model} ${unambiguousYear}`,
        type,
      ),
      entry,
      id,
    );
  }
});

test('remote catalog accepts only the exact image route for its own ID', () => {
  const valid = remoteEntry();
  assert.equal(
    parseVehicleCatalogResponse({ vehicles: [valid], total: 1 })[0].imageUrl,
    valid.imageUrl,
  );
  for (const imageUrl of [
    undefined,
    'https://other.example.test/private?token=never-display',
    '//other.example.test/pixel',
    `/api/v1/vehicle-catalog/${valid.id}/image?token=never-display`,
    `/api/v1/vehicle-catalog/${valid.id}/image#fragment`,
    '/api/v1/vehicle-catalog/another-id/image',
    '/api/v1/vehicle-catalog/../vehicles',
    '/api/v1/vehicle-catalog/%2e%2e/image',
  ]) {
    assert.throws(
      () => parseVehicleCatalogResponse({ vehicles: [{ ...valid, imageUrl }], total: 1 }),
      (error: unknown) => error instanceof Error && !error.message.includes('never-display'),
    );
  }
});

test('catalog rejects malformed identities, dates, provenance, enums, size and duplicate IDs', () => {
  const valid = remoteEntry();
  const invalid: Record<string, unknown>[] = [
    { id: '../secret' },
    { manufacturer: 'x'.repeat(61) },
    { model: 'bad\nmodel' },
    { generation: '' },
    { yearFrom: 2023.5 },
    { yearFrom: Number.NaN },
    { yearFrom: 1800 },
    { yearTo: valid.yearFrom - 1 },
    { yearTo: 2200 },
    { powertrains: ['unknown'] },
    { powertrains: ['ICE', 'ICE'] },
    { powertrains: [] },
    { imageObjectKey: 'data/private-token.png' },
    { imageSourceUrl: 'javascript:alert(1)' },
    { imageSourceUrl: 'http://example.test/photo' },
    { imageSourceUrl: 'https://user:private@example.test/photo' },
    { imageLicenseUrl: 'file:///private' },
    { representative: false },
    { note: 'x'.repeat(2001) },
  ];
  for (const change of invalid) {
    assert.throws(() =>
      parseVehicleCatalogResponse({ vehicles: [{ ...valid, ...change }], total: 1 }),
    );
  }
  for (const response of [
    { vehicles: [valid], total: 2 },
    { vehicles: [valid, valid], total: 2 },
    { vehicles: Array.from({ length: 101 }, () => valid), total: 101 },
    { vehicles: [valid], total: '1' },
    null,
  ])
    assert.throws(() => parseVehicleCatalogResponse(response));
});

test('validated results are independent objects with only known catalog fields', () => {
  const original = { ...remoteEntry(), privateDiagnostics: 'must-not-escape' };
  const [parsed] = parseVehicleCatalogResponse({ vehicles: [original], total: 1 });
  assert.equal('privateDiagnostics' in parsed, false);
  assert.notEqual(parsed, original);
  assert.notEqual(parsed.powertrains, original.powertrains);
  assert.deepEqual(parseVehicleCatalogResponse({ vehicles: [], total: 0 }), []);
});
