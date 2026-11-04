import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createInitialState, parseStoredState } from '../domain/state';
import { applyStateTransaction } from '../domain/stateTransaction';
import type { ActionResult, AppAction, AppState, StorageError } from '../domain/types';
import { initializeDepartureNotifications } from '../services/notifications';
import { createPersistenceQueue } from '../services/localPersistence';

export const STORAGE_KEY = '@drivemate/state:v1';

interface AppContextValue {
  state: AppState;
  ready: boolean;
  error: StorageError | null;
  /** Original unreadable bytes, available for an explicit backup/export. */
  recoveryData: string | null;
  dispatch: (action: AppAction, options?: { expectedState: AppState }) => ActionResult;
  retryStorage: () => Promise<void>;
  /** Backs up corrupt bytes before starting over; a failed backup blocks reset. */
  discardCorruptData: () => Promise<ActionResult>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState(createInitialState);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<StorageError | null>(null);
  const [recoveryData, setRecoveryData] = useState<string | null>(null);
  const stateRef = useRef(state);
  const readyRef = useRef(false);
  const errorRef = useRef<StorageError | null>(null);
  const recoveryRef = useRef<string | null>(null);
  const mounted = useRef(true);
  const loadSequence = useRef(0);

  const reportError = useCallback((value: StorageError | null) => {
    errorRef.current = value;
    if (mounted.current) setError(value);
  }, []);

  const persistence = useRef<ReturnType<typeof createPersistenceQueue> | null>(null);
  const persist = useCallback(
    (snapshot: string) => {
      persistence.current ??= createPersistenceQueue(
        (value) => AsyncStorage.setItem(STORAGE_KEY, value),
        () => {
          if (errorRef.current?.kind === 'save') reportError(null);
        },
        () =>
          reportError({
            kind: 'save',
            message:
              '기기에 저장하지 못했어요. 지금 보이는 변경사항은 메모리에만 있어요. 저장을 다시 시도하기 전 앱을 닫으면 사라질 수 있어요.',
          }),
      );
      return persistence.current.enqueue(snapshot);
    },
    [reportError],
  );

  const queueSave = useCallback(
    (snapshot: AppState) => {
      void persist(JSON.stringify(snapshot));
    },
    [persist],
  );

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    readyRef.current = false;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (!mounted.current || sequence !== loadSequence.current) return;
      if (raw === null) {
        const initial = createInitialState();
        stateRef.current = initial;
        setState(initial);
        recoveryRef.current = null;
        setRecoveryData(null);
        reportError(null);
      } else {
        const result = parseStoredState(raw);
        if (result.ok) {
          stateRef.current = result.state;
          setState(result.state);
          recoveryRef.current = null;
          setRecoveryData(null);
          reportError(null);
          if (result.migrated) queueSave(result.state);
        } else {
          recoveryRef.current = raw;
          setRecoveryData(raw);
          reportError({ kind: 'corrupt', message: result.error });
        }
      }
    } catch {
      if (sequence === loadSequence.current)
        reportError({
          kind: 'load',
          message:
            '기기의 저장소를 열지 못했어요. 기존 데이터를 보호하기 위해 변경을 잠시 멈췄어요. 다시 불러와 주세요.',
        });
    } finally {
      if (mounted.current && sequence === loadSequence.current) {
        readyRef.current = true;
        setReady(true);
      }
    }
  }, [queueSave, reportError]);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    // Start storage hydration after mount; React Strict Mode's discarded mount cannot apply it.
    void Promise.resolve().then(() => {
      if (!cancelled) return load();
    });
    return () => {
      cancelled = true;
      mounted.current = false;
      loadSequence.current += 1;
    };
  }, [load]);

  useEffect(() => {
    // Registers foreground presentation only; never asks for permission during startup.
    void initializeDepartureNotifications().catch(() => undefined);
  }, []);

  const dispatch = useCallback(
    (action: AppAction, options?: { expectedState: AppState }): ActionResult => {
      if (!readyRef.current) return { ok: false, error: '저장된 데이터를 불러오는 중이에요.' };
      if (errorRef.current?.kind === 'load' || errorRef.current?.kind === 'corrupt')
        return { ok: false, error: '기존 데이터를 먼저 복구하거나 백업 후 초기화해 주세요.' };
      try {
        const next = applyStateTransaction(stateRef.current, action, options?.expectedState);
        stateRef.current = next.state;
        setState(next.state);
        void persist(next.serialized);
        return { ok: true };
      } catch (cause) {
        return {
          ok: false,
          error: cause instanceof Error ? cause.message : '변경사항을 적용하지 못했어요.',
        };
      }
    },
    [persist],
  );

  const retryStorage = useCallback(async () => {
    if (errorRef.current?.kind === 'save') {
      await persist(JSON.stringify(stateRef.current));
    } else {
      setReady(false);
      await load();
    }
  }, [persist, load]);

  const discardCorruptData = useCallback(async (): Promise<ActionResult> => {
    const original = recoveryRef.current;
    if (errorRef.current?.kind !== 'corrupt' || original === null)
      return { ok: false, error: '초기화할 손상 데이터가 없어요. 저장소를 다시 불러와 주세요.' };
    readyRef.current = false;
    setReady(false);
    try {
      await AsyncStorage.setItem(`${STORAGE_KEY}:recovery:${Date.now()}`, original);
      const initial = createInitialState();
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
      stateRef.current = initial;
      setState(initial);
      recoveryRef.current = null;
      setRecoveryData(null);
      reportError(null);
      return { ok: true };
    } catch {
      const message =
        '원본 데이터의 백업 또는 초기화에 실패했어요. 기존 데이터는 보호하고 있어요. 다시 시도해 주세요.';
      reportError({ kind: 'corrupt', message });
      return { ok: false, error: message };
    } finally {
      readyRef.current = true;
      setReady(true);
    }
  }, [reportError]);

  return (
    <AppContext.Provider
      value={{ state, ready, error, recoveryData, dispatch, retryStorage, discardCorruptData }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used within AppProvider');
  return value;
}
