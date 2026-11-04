/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { appReducer, createDemoState, createInitialState } from './state';
import { applyStateTransaction } from './stateTransaction';
import { replaceAfterPreparation } from '../services/stateReplacement';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

test('restore/reset cannot erase changes saved while notification cleanup was pending', async () => {
  for (const action of [
    { type: 'RESET_DATA' as const },
    { type: 'IMPORT_DATA' as const, state: createDemoState() },
  ]) {
    let current = createDemoState();
    const reviewed = current;
    const cleanup = deferred();
    const replacement = replaceAfterPreparation(
      () => cleanup.promise,
      () => true,
      () => {
        current = applyStateTransaction(current, action, reviewed).state;
        return { ok: true };
      },
    );
    current = appReducer(current, { type: 'UPDATE_SETTINGS', settings: { walkMinutes: 17 } });
    cleanup.resolve();
    await assert.rejects(replacement, /기기 데이터가 변경/);
    assert.equal(current.settings.walkMinutes, 17);
    assert.equal(current.onboarded, true);
  }
});

test('unmount, logout, server change, and permission request prevent a late restore commit', async () => {
  for (const reason of ['unmount', 'logout', 'server change', 'permission request']) {
    let allowed = true;
    let commits = 0;
    const cleanup = deferred();
    const result = replaceAfterPreparation(
      () => cleanup.promise,
      () => allowed,
      () => {
        commits++;
        return { ok: true };
      },
    );
    allowed = false;
    cleanup.resolve();
    assert.equal((await result).ok, false, reason);
    assert.equal(commits, 0, reason);
  }
});

test('a stale operation does not cancel notifications or write; cancellation failure preserves data', async () => {
  let prepared = 0;
  let committed = 0;
  const commit = () => {
    committed++;
    return { ok: true as const };
  };
  assert.equal(
    (
      await replaceAfterPreparation(
        async () => {
          prepared++;
        },
        () => false,
        commit,
      )
    ).ok,
    false,
  );
  assert.equal(prepared, 0);
  await assert.rejects(
    replaceAfterPreparation(
      async () => {
        throw new Error('Native cancellation failed');
      },
      () => true,
      commit,
    ),
    /Native cancellation failed/,
  );
  assert.equal(committed, 0);
});

test('an unchanged reviewed state is replaceable and its saved result remains reloadable', async () => {
  let current = createDemoState();
  const reviewed = current;
  const result = await replaceAfterPreparation(
    async () => undefined,
    () => true,
    () => {
      const changed = applyStateTransaction(current, { type: 'RESET_DATA' }, reviewed);
      assert.deepEqual(JSON.parse(changed.serialized), createInitialState());
      current = changed.state;
      return { ok: true };
    },
  );
  assert.equal(result.ok, true);
  assert.equal(current.onboarded, false);
});
