import type { ActionResult } from '../domain/types';

/** Recheck the owning screen/session/recorder after asynchronous notification cleanup. */
export async function replaceAfterPreparation(
  prepare: () => Promise<void>,
  isCurrent: () => boolean,
  commit: () => ActionResult,
): Promise<ActionResult> {
  const cancelled: ActionResult = {
    ok: false,
    error:
      '화면·계정 또는 주행 상태가 바뀌어 데이터 교체를 멈췄어요. 다시 확인해 주세요. 해제된 출발 알림은 다시 켜 주세요.',
  };
  if (!isCurrent()) return cancelled;
  await prepare();
  if (!isCurrent()) return cancelled;
  return commit();
}
