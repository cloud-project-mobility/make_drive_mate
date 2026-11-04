/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { attachCurrentSubscription, type RemovableSubscription } from '../services/subscription';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('a stale rejected watcher cannot pause a newer successful session', async () => {
  let session = 1;
  let failures = 0;
  let attached: RemovableSubscription | null = null;
  const old = deferred<RemovableSubscription>();
  const oldResult = attachCurrentSubscription(
    () => old.promise,
    () => session === 1,
    (subscription) => {
      attached = subscription;
    },
    () => {
      failures += 1;
    },
  );
  session = 2; // Pause then resume while the native subscription request is unresolved.
  const current = { remove: () => undefined };
  assert.equal(
    await attachCurrentSubscription(
      async () => current,
      () => session === 2,
      (subscription) => {
        attached = subscription;
      },
      () => {
        failures += 1;
      },
    ),
    'attached',
  );
  old.reject(new Error('Delayed native location rejection'));
  assert.equal(await oldResult, 'cancelled');
  assert.equal(attached, current);
  assert.equal(failures, 0);
});

test('a watcher resolving after pause or unmount is removed without becoming hidden', async () => {
  let current = true;
  let removed = 0;
  let attached = 0;
  const pending = deferred<RemovableSubscription>();
  const result = attachCurrentSubscription(
    () => pending.promise,
    () => current,
    () => {
      attached += 1;
    },
    () => assert.fail('A cancelled request must not report an active failure'),
  );
  current = false;
  pending.resolve({
    remove: () => {
      removed += 1;
    },
  });
  assert.equal(await result, 'cancelled');
  assert.equal(removed, 1);
  assert.equal(attached, 0);
});

test('a current subscription failure is surfaced exactly once', async () => {
  let failures = 0;
  const result = await attachCurrentSubscription(
    async () => {
      throw new Error('Permission revoked');
    },
    () => true,
    () => assert.fail('A rejected watcher cannot attach'),
    () => {
      failures += 1;
    },
  );
  assert.equal(result, 'failed');
  assert.equal(failures, 1);
});
