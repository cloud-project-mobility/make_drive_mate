import { appReducer, parseStoredState } from './state';
import type { AppAction, AppState } from './types';

/** A delayed replacement may only commit against the exact state the user reviewed. */
export function applyStateTransaction(
  current: AppState,
  action: AppAction,
  expectedState?: AppState,
) {
  if (expectedState !== undefined && current !== expectedState)
    throw new Error(
      '대기 중 기기 데이터가 변경되어 교체를 멈췄어요. 최신 데이터를 확인하고 다시 시도해 주세요. 해제된 출발 알림은 다시 켜 주세요.',
    );
  const state = appReducer(current, action);
  const serialized = JSON.stringify(state);
  const parsed = parseStoredState(serialized);
  if (!parsed.ok) throw new Error(parsed.error);
  return { state, serialized };
}
