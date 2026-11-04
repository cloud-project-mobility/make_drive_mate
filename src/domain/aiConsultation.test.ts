import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialState } from './state';
import type { Vehicle } from './types';
import { auctionInputFromDraft, consultationContext, createAuctionDraft } from './aiConsultation';
import {
  auctionVehicleKey,
  readAuctionCache,
  writeAuctionCache,
  type AuctionCacheEntry,
} from '../services/auctionCache';
import { BackendClient } from '../services/backend';
import { isAssistantResult } from '../services/aiConsultation';

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
