/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPersistenceQueue } from '../services/localPersistence';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('a change queued during write completion persists without another user action', async () => {
  const first = deferred();
  const writes: string[] = [];
  const queue = createPersistenceQueue(
    async (value) => {
      writes.push(value);
      if (value === 'old') await first.promise;
    },
    () => undefined,
    () => assert.fail('Storage succeeds'),
  );
  const old = queue.enqueue('old');
  await Promise.resolve();
  first.resolve();
  // Queue after the writer finishes, but before the drain promise's subscribers run.
  await Promise.resolve();
  const newest = new Promise<void>((resolve) => {
    queueMicrotask(() => void queue.enqueue('newest').then(resolve));
  });
  await Promise.all([old, newest]);
  assert.deepEqual(writes, ['old', 'newest']);
});

test('writes are serialized and intermediate pending states are coalesced', async () => {
  const first = deferred();
  const writes: string[] = [];
  const queue = createPersistenceQueue(
    async (value) => {
      writes.push(value);
      if (value === 'first') await first.promise;
    },
    () => undefined,
    () => assert.fail('Storage succeeds'),
  );
  const saved = queue.enqueue('first');
  await Promise.resolve();
  void queue.enqueue('intermediate');
  void queue.enqueue('latest');
  assert.deepEqual(writes, ['first']);
  first.resolve();
  await saved;
  assert.deepEqual(writes, ['first', 'latest']);
});

test('a failed write stops without a retry loop and a retry persists the newest state', async () => {
  const first = deferred();
  const writes: string[] = [];
  let errors = 0;
  let successes = 0;
  const queue = createPersistenceQueue(
    async (value) => {
      writes.push(value);
      if (writes.length === 1) await first.promise;
    },
    () => successes++,
    () => errors++,
  );
  const saved = queue.enqueue('first');
  await Promise.resolve();
  void queue.enqueue('newer');
  first.reject(new Error('Disk full'));
  await saved;
  assert.deepEqual(writes, ['first']);
  assert.equal(errors, 1);
  assert.equal(successes, 0);
  await queue.enqueue('newest');
  assert.deepEqual(writes, ['first', 'newest']);
  assert.equal(successes, 1);
});
