import type { ActionResult, TripPlan } from './types';

export type DepartureNotificationResult = ActionResult & { identifier?: string };

interface DepartureNotificationAdapter {
  schedule: (plan: TripPlan) => Promise<DepartureNotificationResult>;
  cancel: (planId: string) => Promise<void>;
  cancelAll: () => Promise<void>;
}

/** Keep native writes ordered even when a screen closes before its request finishes. */
export function createDepartureNotificationCoordinator(adapter: DepartureNotificationAdapter) {
  let pending: Promise<void> = Promise.resolve();
  let generation = 0;
  let cancellingAll = 0;
  const planGenerations = new Map<string, number>();
  const cancellingPlans = new Map<string, number>();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation);
    // One failed native operation must not prevent a later explicit retry.
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function cancelled(): DepartureNotificationResult {
    return { ok: false, error: '계획 삭제 또는 데이터 변경으로 출발 알림 예약을 취소했어요.' };
  }

  function schedule(plan: TripPlan): Promise<DepartureNotificationResult> {
    if (cancellingAll || cancellingPlans.has(plan.id)) return Promise.resolve(cancelled());
    const startedGeneration = generation;
    const startedPlanGeneration = planGenerations.get(plan.id) ?? 0;
    const current = () =>
      generation === startedGeneration &&
      (planGenerations.get(plan.id) ?? 0) === startedPlanGeneration;
    return enqueue(async () => {
      if (!current()) return cancelled();
      const result = await adapter.schedule(plan);
      // A cancellation queued during the native call runs next and removes its result.
      return current() ? result : cancelled();
    });
  }

  async function cancel(planId: string): Promise<void> {
    planGenerations.set(planId, (planGenerations.get(planId) ?? 0) + 1);
    cancellingPlans.set(planId, (cancellingPlans.get(planId) ?? 0) + 1);
    try {
      await enqueue(() => adapter.cancel(planId));
    } finally {
      const count = (cancellingPlans.get(planId) ?? 1) - 1;
      if (count) cancellingPlans.set(planId, count);
      else cancellingPlans.delete(planId);
    }
  }

  async function cancelAll(): Promise<void> {
    generation += 1;
    cancellingAll += 1;
    try {
      // Enumeration happens after pending schedules settle, so it includes requests
      // that did not yet exist in the operating system when cancellation began.
      await enqueue(() => adapter.cancelAll());
    } finally {
      cancellingAll -= 1;
    }
  }

  return { schedule, cancel, cancelAll };
}
