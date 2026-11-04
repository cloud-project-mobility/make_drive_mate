const MAX_SECONDS = 604_800;

function monotonicNow(): number {
  if (typeof performance === 'undefined' || typeof performance.now !== 'function')
    throw new Error(
      '이 기기에서 경과 시간을 측정할 수 없어요. 기록을 보존했으니 앱을 다시 시작해 주세요.',
    );
  return performance.now();
}

/** Only foreground segments count; wall-clock changes never alter measured duration. */
export function createTripClock(readTime: () => number = monotonicNow) {
  let accumulated = 0;
  let lastElapsed = 0;
  let started: number | null = null;
  const elapsed = () => {
    if (started !== null) {
      const now = readTime();
      if (Number.isFinite(now))
        lastElapsed = Math.min(
          MAX_SECONDS,
          Math.max(lastElapsed, accumulated + Math.floor(Math.max(0, now - started) / 1_000)),
        );
    }
    return lastElapsed;
  };
  return {
    elapsed,
    reset(seconds: number) {
      accumulated = lastElapsed = Math.min(MAX_SECONDS, Math.max(0, seconds));
      started = null;
    },
    resume() {
      const now = readTime();
      if (!Number.isFinite(now))
        throw new Error('기기의 경과 시간 측정을 확인할 수 없어요. 앱을 다시 시작해 주세요.');
      started = now;
    },
    pause() {
      accumulated = elapsed();
      started = null;
      return accumulated;
    },
  };
}

/** Keep the real timestamp; a backwards device clock must not create an invalid trip. */
export function canFinishTripAt(startedAt: string, durationSeconds: number, endedAt: string) {
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  return (
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end >= start &&
    durationSeconds <= (end - start) / 1_000 + 2
  );
}
