import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialState } from './state';
import type { Vehicle } from './types';
import {
  auctionInputFromDraft,
  consultationContext,
  consultationVehicleIdentity,
  createAuctionDraft,
} from './aiConsultation';
import { bundledCatalog } from './vehicleCatalog';
import {
  auctionVehicleKey,
  readAuctionCache,
  writeAuctionCache,
  type AuctionCacheEntry,
} from '../services/auctionCache';
import { BackendClient } from '../services/backend';
import {
  isAssistantResult,
  isOfficialVehicleSourceUrl,
  isVehicleRagResult,
} from '../services/aiConsultation';

const vehicle: Vehicle = {
  id: 'synthetic',
  name: 'private nickname',
  model: 'K5 2020',
  powertrain: 'ICE',
  odometerKm: 12000,
  createdAt: '2026-01-01T00:00:00Z',
};
test('analysis draft does not invent fuel, engine or upkeep from powertrain', () => {
  const draft = createAuctionDraft(vehicle, []);
  assert.equal(draft.year, '2020');
  assert.equal(draft.fuel, '');
  assert.equal(draft.engine, '');
  assert.equal(draft.upkeep, '');
  assert.throws(() => auctionInputFromDraft({ ...draft, model: 'K5' }));
  const input = auctionInputFromDraft(
    { ...draft, model: 'K5', upkeep: '15' },
    new Date('2026-11-05'),
  );
  assert.equal(input.vehicle.fuel, null);
  assert.equal(input.monthly_upkeep_krw, 150000);
  assert.equal(input.vehicle.age_years, 6);
  assert.equal(createAuctionDraft({ ...vehicle, model: 'K5 2020 2021' }, []).year, '');
});
test('safe context only contains selected vehicle summaries, never places or notes', () => {
  const state = createInitialState();
  state.vehicles = [vehicle];
  state.selectedVehicleId = vehicle.id;
  state.maintenance = [
    {
      id: 'private-id',
      vehicleId: vehicle.id,
      itemId: 'engine-oil',
      odometerKm: 11000,
      performedAt: '2026-10-01T00:00:00Z',
      note: 'private-note',
    },
  ];
  state.plans = [
    {
      id: 'private-plan',
      vehicleId: vehicle.id,
      origin: 'private-origin',
      destination: 'private-destination',
      eventTitle: 'private-title',
      eventAt: '2026-11-06T09:00:00Z',
      originPoint: { latitude: 37, longitude: 127 },
      driveMinutes: 10,
      walkMinutes: 5,
      bufferMinutes: 5,
      source: 'manual',
      createdAt: '2026-01-01T00:00:00Z',
    },
  ];
  const context = consultationContext(state, vehicle, new Date('2026-11-05T00:00:00Z'));
  assert.equal(JSON.stringify(context).includes('private'), false);
  assert.equal(context.maintenance.find((item) => item.item === 'engine-oil')?.recorded, true);
  assert.equal(context.next_plan?.departure_at, '2026-11-06T08:40:00.000Z');
  assert.equal(
    consultationContext(state, { ...vehicle, id: 'other' }, new Date('2026-11-05')).next_plan,
    null,
  );
});
test('vehicle retrieval identity uses catalog fields and matching confirmed fuel only', () => {
  const entry = { ...bundledCatalog[0], id: 'synthetic-k5', manufacturer: '기아', model: 'K5' };
  const selected = { ...vehicle, catalogId: entry.id };
  const now = new Date('2026-11-05T00:00:00Z');
  const draft = createAuctionDraft(selected, [entry]);
  const confirmed = auctionInputFromDraft({ ...draft, fuel: '휘발유', upkeep: '0' }, now);
  assert.deepEqual(consultationVehicleIdentity(selected, null, now, [entry]), {
    make: '기아',
    model: 'K5',
    model_year: 2020,
    fuel: null,
  });
  assert.equal(consultationVehicleIdentity(selected, confirmed, now, [entry]).fuel, '휘발유');
  for (const changed of [
    { ...confirmed, vehicle: { ...confirmed.vehicle, model: '다른 차' } },
    { ...confirmed, vehicle: { ...confirmed.vehicle, make: '다른 제조사' } },
    { ...confirmed, vehicle: { ...confirmed.vehicle, age_years: 5 } },
  ])
    assert.equal(consultationVehicleIdentity(selected, changed, now, [entry]).fuel, null);
  assert.equal(
    consultationVehicleIdentity({ ...selected, model: 'K5 2020 2021' }, confirmed, now, [entry])
      .model_year,
    null,
  );
  assert.equal(
    consultationVehicleIdentity({ ...selected, model: 'K5 2028' }, confirmed, now, [entry])
      .model_year,
    null,
  );
  assert.deepEqual(consultationVehicleIdentity(vehicle, confirmed, now, []), {
    make: null,
    model: null,
    model_year: 2020,
    fuel: null,
  });
  assert.deepEqual(consultationVehicleIdentity(undefined, confirmed, now, [entry]), {
    make: null,
    model: null,
    model_year: null,
    fuel: null,
  });
  assert.equal(
    JSON.stringify(consultationVehicleIdentity(selected, confirmed, now, [entry])).includes(
      'private',
    ),
    false,
  );
});
test('memory cache isolates session identity, vehicle snapshot and demo state', () => {
  const first = new BackendClient('https://example.test', 'synthetic-a');
  const second = new BackendClient('https://example.test', 'synthetic-b');
  const key = auctionVehicleKey(vehicle, false);
  const entry = { createdAt: 'synthetic', demoInput: false } as AuctionCacheEntry;
  writeAuctionCache(first, key, entry);
  assert.equal(readAuctionCache(first, key), entry);
  assert.equal(readAuctionCache(second, key), null);
  assert.equal(
    readAuctionCache(first, auctionVehicleKey({ ...vehicle, odometerKm: 12001 }, false)),
    null,
  );
  assert.equal(readAuctionCache(first, auctionVehicleKey(vehicle, true)), null);
});
test('assistant response rejects generated prices but permits original numeric evidence', () => {
  const result = {
    ok: true,
    api_version: 'assistant-v1',
    status: 'answered',
    answer: '선택한 차량의 근거를 확인해 보세요.',
    facts: [{ id: 'price', kind: 'evidence', statement: 'K5 · 공매 분석 800만원' }],
    valuation: null,
    provider: {},
    price_generation_by_llm: false,
  };
  assert.equal(isAssistantResult(result), true);
  assert.equal(isAssistantResult({ ...result, answer: '800만원에 팔아요.' }), false);
  assert.equal(isAssistantResult({ ...result, answer: '천만원에 팔아요.' }), false);
  for (const answer of ['일 년 뒤 팔아요.', '한 달 기다려요.', '삼천 원이에요.'])
    assert.equal(isAssistantResult({ ...result, answer }), false);
  for (const answer of [
    '삼천원이에요.',
    '일조 원이에요.',
    '십이개월 뒤예요.',
    '사 건이에요.',
    '세 대예요.',
    '구 분 기다려요.',
  ])
    assert.equal(isAssistantResult({ ...result, answer }), false);
  for (const answer of [
    '공매 조건을 비교하세요.',
    '세대와 트림을 구분하고 공매 조건을 확인하세요.',
    '사건별 정보가 달라요.',
    '한참 기다리는 판단을 보장하지 않아요.',
    '몇가지 근거를 확인하세요.',
    '만일 조건이 바뀌면 다시 확인하세요.',
    '백분율의 의미는 근거와 함께 확인하세요.',
  ])
    assert.equal(isAssistantResult({ ...result, answer }), true);
  assert.equal(isAssistantResult({ ...result, facts: [...result.facts, ...result.facts] }), false);
});

const vehicleSource = {
  source_id: 'vehicle_manual_1',
  source_kind: 'official_manual_summary',
  document_title: '합성 제조사 설명서',
  source_uri: 'https://ownersmanual.kia.com/synthetic-manual.html',
  section: '합성 정비 안내',
  page: 12,
  excerpt: '합성 검증 발췌: 실제 차량 설명서가 아닙니다.',
  applicability: {
    scope: 'model_specific',
    make: '기아',
    model: 'K5',
    year_from: 2020,
    year_to: 2023,
    fuel_types: ['휘발유'],
  },
};
const matchedRag = {
  scope: 'public_vehicle',
  status: 'matched',
  sources: [vehicleSource],
  answer_source_ids: [vehicleSource.source_id],
  method: 'bm25+pgvector-cosine-rrf',
};

test('vehicle sources only accept official HTTPS manual hosts', () => {
  for (const uri of [
    vehicleSource.source_uri,
    'https://ownersmanual.hyundai.com/synthetic.html#section',
    'https://OWNERSMANUAL.KIA.COM:443/synthetic.pdf',
  ])
    assert.equal(isOfficialVehicleSourceUrl(uri), true);
  for (const uri of [
    'http://ownersmanual.kia.com/synthetic.html',
    'https://ownersmanual.kia.com.evil.example/synthetic.html',
    'https://evilownersmanual.kia.com/synthetic.html',
    'https://user:pass@ownersmanual.kia.com/synthetic.html',
    'https://ownersmanual.kia.com:444/synthetic.html',
    'https://ownersmanual.kia.com./synthetic.html',
    'https://example.test/private-project.pdf',
    'file:///private-project.pdf',
    'javascript:alert(1)',
    'https://ownersmanual.kia.com/\nsynthetic.html',
    'https://ownersmanual.kia.com\\@evil.example/synthetic.html',
  ])
    assert.equal(isOfficialVehicleSourceUrl(uri), false, uri);
});

test('vehicle RAG rejects private scope, mismatched selected citations and invented metadata', () => {
  assert.equal(isVehicleRagResult(matchedRag), true);
  assert.equal(isVehicleRagResult({ ...matchedRag, scope: 'private_project' }), false);
  assert.equal(isVehicleRagResult({ ...matchedRag, answer_source_ids: ['unselected'] }), false);
  assert.equal(isVehicleRagResult({ ...matchedRag, answer_source_ids: [] }), false);
  assert.equal(
    isVehicleRagResult({
      ...matchedRag,
      sources: [vehicleSource, vehicleSource],
      answer_source_ids: [vehicleSource.source_id, vehicleSource.source_id],
    }),
    false,
  );
  assert.equal(isVehicleRagResult({ ...matchedRag, status: 'no_match' }), false);
  assert.equal(isVehicleRagResult({ ...matchedRag, sources: [], answer_source_ids: [] }), false);
  for (const source of [
    { ...vehicleSource, source_kind: 'private_project' },
    { ...vehicleSource, source_kind: 'verbatim_manual' },
    { ...vehicleSource, source_uri: 'https://example.test/private-project.pdf' },
    { ...vehicleSource, page: 0 },
    { ...vehicleSource, page: 1.5 },
    { ...vehicleSource, page: 10001 },
    { ...vehicleSource, excerpt: '' },
    { ...vehicleSource, excerpt: 'x'.repeat(1601) },
    { ...vehicleSource, applicability: { ...vehicleSource.applicability, year_to: 2019 } },
    { ...vehicleSource, applicability: { ...vehicleSource.applicability, scope: 'general' } },
  ])
    assert.equal(isVehicleRagResult({ ...matchedRag, sources: [source] }), false);
  const general = {
    ...vehicleSource,
    page: null,
    applicability: {
      scope: 'general',
      make: null,
      model: null,
      year_from: null,
      year_to: null,
      fuel_types: [],
    },
  };
  assert.equal(isVehicleRagResult({ ...matchedRag, sources: [general] }), true);
  for (const status of [
    'disabled',
    'unavailable',
    'needs_vehicle_details',
    'no_match',
    'not_used',
  ]) {
    assert.equal(
      isVehicleRagResult({
        scope: 'public_vehicle',
        status,
        sources: [],
        answer_source_ids: [],
        method: null,
      }),
      true,
    );
  }
  const result = {
    ok: true,
    api_version: 'assistant-v1',
    status: 'answered',
    answer: '공식 자료의 적용 조건을 확인하세요.',
    facts: [],
    valuation: null,
    provider: {},
    price_generation_by_llm: false,
  };
  assert.equal(isAssistantResult({ ...result, vehicle_rag: matchedRag }), true);
  assert.equal(
    isAssistantResult({ ...result, vehicle_rag: { ...matchedRag, scope: 'private_project' } }),
    false,
  );
});
