import { Platform, Share } from 'react-native';
import { isAppState, parseStoredState } from '../domain/state';
import type { ActionResult, AppState } from '../domain/types';

export type BackupParseResult = { ok: true; state: AppState } | { ok: false; error: string };

/** Parsing is read-only; the UI must confirm replacement before dispatching IMPORT_DATA. */
export function parseBackup(raw: string): BackupParseResult {
  const parsed = parseStoredState(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (!parsed.state.onboarded)
    return {
      ok: false,
      error: '아직 시작을 완료하지 않은 데이터예요. 차량을 등록한 기기의 백업을 확인해 주세요.',
    };
  if (parsed.state.activeTrip)
    return {
      ok: false,
      error:
        '진행 중인 주행이 들어 있는 백업이에요. 원래 기기에서 주행을 마친 뒤 다시 백업해 주세요.',
    };
  return { ok: true, state: parsed.state };
}

/** Export is a local file or an explicit OS share sheet; it does not upload to a server. */
export async function exportBackup(state: AppState): Promise<ActionResult> {
  if (!isAppState(state) || !state.onboarded)
    return { ok: false, error: '아직 백업할 데이터가 없어요.' };
  if (state.activeTrip)
    return { ok: false, error: '진행 중인 주행을 저장하거나 취소한 뒤 백업해 주세요.' };
  // Use the same compact representation as persistence so a valid near-limit state can export.
  const json = JSON.stringify(state);
  const valid = parseStoredState(json);
  if (!valid.ok) return { ok: false, error: valid.error };
  return exportRawBackup(json, 'drivemate-backup');
}

/** Also usable by the recovery screen to let the user retain unmodified corrupt bytes. */
export async function exportRawBackup(
  raw: string,
  prefix = 'drivemate-recovery',
): Promise<ActionResult> {
  const filename = `${prefix}-${new Date().toISOString().slice(0, 10)}.json`;
  try {
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const url = URL.createObjectURL(new Blob([raw], { type: 'application/json;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
      return { ok: true };
    }
    const result = await Share.share(
      { title: filename, message: raw },
      { dialogTitle: 'DriveMate 기기 데이터 백업' },
    );
    if (result.action === Share.dismissedAction)
      return { ok: false, error: '백업 공유를 취소했어요. 기기 데이터는 그대로예요.' };
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: '백업을 내보내지 못했어요. 저장 공간이나 공유 가능한 앱을 확인해 주세요.',
    };
  }
}
