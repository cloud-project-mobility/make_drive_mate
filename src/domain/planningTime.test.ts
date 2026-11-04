import assert from 'node:assert/strict';
import test from 'node:test';
import { localArrivalOptions, resolveArrival, utcOffsetLabel } from './planningTime';

function inTimezone(zone: string, run: () => void) {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

test('calendar imports preserve both repeated-hour instants and source seconds', () => {
  inTimezone('America/New_York', () => {
    const options = localArrivalOptions('2026-11-01', '01:30');
    assert.deepEqual(
      options.map((value) => value.toISOString()),
      ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z'],
    );
    assert.deepEqual(options.map(utcOffsetLabel), ['UTC-04:00', 'UTC-05:00']);
    for (const offset of ['-04:00', '-05:00']) {
      const input = `2026-11-01T01:30:27${offset}`;
      assert.equal(resolveArrival('2026-11-01', '01:30', input)?.getTime(), Date.parse(input));
    }
    assert.equal(resolveArrival('2026-11-01', '01:30', null), null);
    assert.equal(
      resolveArrival('2026-11-01', '01:30', options[1].toISOString())?.getTime(),
      options[1].getTime(),
    );
    assert.equal(
      resolveArrival('2026-11-01', '03:00', '2026-11-01T01:30:00-05:00')?.toISOString(),
      '2026-11-01T08:00:00.000Z',
    );
  });
});
test('nonexistent local times are rejected and half-hour folds are also explicit', () => {
  inTimezone('America/New_York', () =>
    assert.deepEqual(localArrivalOptions('2026-03-08', '02:30'), []),
  );
  inTimezone('Australia/Lord_Howe', () => {
    const options = localArrivalOptions('2026-04-05', '01:45');
    assert.equal(options.length, 2);
    assert.equal(options[1].getTime() - options[0].getTime(), 30 * 60000);
  });
});
test('ordinary Korean local inputs keep existing behavior and invalid dates stay invalid', () => {
  inTimezone('Asia/Seoul', () => {
    assert.equal(
      resolveArrival('2026-10-30', '15:00', null)?.toISOString(),
      '2026-10-30T06:00:00.000Z',
    );
    assert.equal(resolveArrival('2026-02-30', '15:00', null), null);
    assert.equal(resolveArrival('2026-10-30', '', null), null);
  });
});
