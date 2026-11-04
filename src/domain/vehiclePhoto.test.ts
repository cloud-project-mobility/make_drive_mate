import assert from 'node:assert/strict';
import test from 'node:test';
import { vehiclePhotoKey } from './vehiclePhoto';

test('vehicle reference photos follow the model name rather than the powertrain', () => {
  assert.equal(vehiclePhotoKey('현대 아반떼 · 2023'), 'avante');
  assert.equal(vehiclePhotoKey('기아 K5 · 2024'), 'k5');
  assert.equal(vehiclePhotoKey('현대 아이오닉 5 · 2024'), 'ioniq5');
  assert.equal(vehiclePhotoKey('Hyundai IONIQ 5 2024'), 'ioniq5');
  assert.equal(vehiclePhotoKey('Kia K5 2024'), 'k5');
});

test('missing and different model names do not borrow another vehicle photo', () => {
  for (const model of ['', '현대 아이오닉 6 2024', '기아 K50 2024', '기아 EV6', '미등록 차량']) {
    assert.equal(vehiclePhotoKey(model), undefined, model);
  }
});
