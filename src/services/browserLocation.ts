/** One browser watch shared by explicit foreground consumers, never a saved location. */
export function createBrowserLocationHub() {
  const listeners = new Set<{
    position: PositionCallback;
    error: (reason: string) => void;
  }>();
  let watchId: number | null = null;
  let browser: Geolocation | null = null;
  let generation = 0;
  return {
    subscribe(
      geolocation: Geolocation,
      position: PositionCallback,
      error: (reason: string) => void,
    ) {
      const listener = { position, error };
      listeners.add(listener);
      const remove = () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          generation += 1;
          if (watchId !== null) browser?.clearWatch(watchId);
          watchId = null;
          browser = null;
        }
      };
      if (watchId === null) {
        browser = geolocation;
        const current = ++generation;
        try {
          const created = geolocation.watchPosition(
            (value) => {
              if (current === generation) [...listeners].forEach((item) => item.position(value));
            },
            (failure) => {
              if (current !== generation) return;
              const reason =
                failure.code === 1
                  ? 'permission_denied'
                  : failure.code === 3
                    ? 'timeout'
                    : 'position_unavailable';
              [...listeners].forEach((item) => item.error(reason));
            },
            { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 },
          );
          if (current !== generation || listeners.size === 0) geolocation.clearWatch(created);
          else watchId = created;
        } catch (failure) {
          remove();
          throw failure;
        }
      }
      return { remove };
    },
  };
}
