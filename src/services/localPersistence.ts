/** Serializes writes while coalescing pending snapshots to the latest local state. */
export function createPersistenceQueue(
  write: (snapshot: string) => Promise<void>,
  onSaved: () => void,
  onFailed: () => void,
) {
  let pending: string | null = null;
  let working = false;
  let completion = Promise.resolve();

  async function drain() {
    try {
      while (pending !== null) {
        const snapshot = pending;
        pending = null;
        try {
          await write(snapshot);
          onSaved();
        } catch {
          // A later change takes precedence over the failed older snapshot.
          if (pending === null) pending = snapshot;
          onFailed();
          return;
        }
      }
    } finally {
      // Release ownership before the promise settles. A completion microtask may enqueue
      // a new state; it must start a new drain instead of joining an already finished one.
      working = false;
    }
  }

  return {
    enqueue(snapshot: string): Promise<void> {
      pending = snapshot;
      if (!working) {
        working = true;
        completion = Promise.resolve().then(drain);
      }
      return completion;
    },
  };
}
