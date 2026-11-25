/** One foreground route calculation per confirmed set of inputs. GPS updates never enter this clock. */
export const ROUTE_REFRESH_MS = 5 * 60_000;

export function createRoutePoller(
  load: (signal: AbortSignal) => Promise<void>,
  onFailure: (error: unknown, consecutiveFailures: number) => 'pause' | 'retry',
) {
  let dueAt: number | null = null;
  let visible = false;
  let failures = 0;
  let paused = false;
  let inFlight: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function schedule() {
    clearTimeout(timer);
    if (!visible || paused || inFlight || dueAt === null) return;
    timer = setTimeout(() => void refresh(), Math.max(0, dueAt - Date.now()));
  }

  async function refresh() {
    if (!visible || paused || inFlight || (dueAt !== null && Date.now() < dueAt)) return;
    clearTimeout(timer);
    const request = new AbortController();
    inFlight = request;
    dueAt = Date.now() + ROUTE_REFRESH_MS;
    try {
      await load(request.signal);
      if (!request.signal.aborted) failures = 0;
    } catch (error) {
      if (!request.signal.aborted) {
        failures++;
        paused = onFailure(error, failures) === 'pause' || failures >= 2;
      }
    } finally {
      if (inFlight === request) {
        inFlight = undefined;
        schedule();
      }
    }
  }

  return {
    setVisible(next: boolean) {
      visible = next;
      if (!visible) {
        clearTimeout(timer);
        inFlight?.abort();
        inFlight = undefined;
      } else {
        schedule();
      }
    },
    request() {
      if (!visible || inFlight || (dueAt !== null && Date.now() < dueAt)) return;
      paused = false;
      failures = 0;
      void refresh();
    },
  };
}
