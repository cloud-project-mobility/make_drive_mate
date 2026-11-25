import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoutePoller, ROUTE_REFRESH_MS } from './routePolling';

test('a confirmed visible route refreshes at five minutes; GPS renders and duplicate clicks do not request', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  let calls = 0;
  const poller = createRoutePoller(
    async () => {
      calls++;
    },
    () => 'retry',
  );
  poller.setVisible(true);
  assert.equal(calls, 0);
  poller.request();
  poller.request();
  await Promise.resolve();
  for (let gpsUpdate = 0; gpsUpdate < 60; gpsUpdate++) poller.setVisible(true);
  t.mock.timers.tick(ROUTE_REFRESH_MS - 1);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  assert.equal(calls, 2);
  await Promise.resolve();
  poller.setVisible(false);
  t.mock.timers.tick(ROUTE_REFRESH_MS * 3);
  assert.equal(calls, 2);
  poller.setVisible(true);
  t.mock.timers.tick(0);
  assert.equal(calls, 3);
  poller.setVisible(false);
});

test('leaving a route invalidates its slow response when the destination changes', async () => {
  let complete!: () => void;
  let seenSignal: AbortSignal | undefined;
  const applied: string[] = [];
  const old = createRoutePoller(
    async (signal) => {
      seenSignal = signal;
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      if (!signal.aborted) applied.push('old');
    },
    () => 'retry',
  );
  old.setVisible(true);
  old.request();
  old.setVisible(false);
  const current = createRoutePoller(
    async () => {
      applied.push('new');
    },
    () => 'retry',
  );
  current.setVisible(true);
  current.request();
  complete();
  await Promise.resolve();
  assert.equal(seenSignal?.aborted, true);
  assert.deepEqual(applied, ['new']);
  current.setVisible(false);
});

test('a rate-limit response pauses automatic refresh and suppresses immediate manual retries', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  let calls = 0;
  const poller = createRoutePoller(
    async () => {
      calls++;
      throw Error('429');
    },
    () => 'pause',
  );
  poller.setVisible(true);
  poller.request();
  await Promise.resolve();
  poller.request();
  t.mock.timers.tick(ROUTE_REFRESH_MS * 3);
  assert.equal(calls, 1);
  poller.request();
  assert.equal(calls, 2);
  poller.setVisible(false);
});

test('timeout retries only on the next interval and a repeated failure stops automatic retries', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  let calls = 0;
  let lastGood = 0;
  const poller = createRoutePoller(
    async () => {
      if (++calls > 1) throw Error('timeout');
      lastGood = 23;
    },
    () => 'retry',
  );
  poller.setVisible(true);
  poller.request();
  for (let interval = 0; interval < 5; interval++) {
    await Promise.resolve();
    t.mock.timers.tick(ROUTE_REFRESH_MS);
  }
  assert.equal(calls, 3);
  assert.equal(lastGood, 23);
  poller.setVisible(false);
});
