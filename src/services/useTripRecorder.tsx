import * as Location from 'expo-location';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState as NativeAppState, Platform } from 'react-native';
import { addGpsPoint, createGpsAccumulator } from '../domain/gps';
import { createId } from '../domain/helpers';
import { canFinishTripAt, createTripClock } from '../domain/tripClock';
import type { ActionResult, ActiveTrip, Trip } from '../domain/types';
import { useApp } from '../state/AppProvider';
import { watchForegroundPosition } from './locationWatcher';
import { attachCurrentSubscription } from './subscription';

type RecorderStatus = 'idle' | 'requesting' | 'recording' | 'paused' | 'error';
interface RecorderContextValue {
  status: RecorderStatus;
  activeTrip: ActiveTrip | null;
  distanceKm: number;
  durationSeconds: number;
  accuracy: number | null;
  position: { latitude: number; longitude: number } | null;
  error: string | null;
  start: (
    vehicleId: string,
    locations?: { origin?: string; destination?: string; planId?: string },
  ) => Promise<ActionResult>;
  pause: () => void;
  resume: () => Promise<ActionResult>;
  finish: () => ActionResult;
  cancel: () => void;
  /** Synchronous guard for delayed data replacement, including permission requests. */
  isBusy: () => boolean;
}

const RecorderContext = createContext<RecorderContextValue | null>(null);

/** Foreground only. No background permissions, automatic detection, or synthetic coordinates. */
export function TripRecorderProvider({ children }: { children: React.ReactNode }) {
  const { state, ready, dispatch } = useApp();
  const [status, setStatus] = useState<RecorderStatus>('idle');
  const [activeTrip, setActiveTrip] = useState<ActiveTrip | null>(null);
  const [distanceKm, setDistanceKm] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [position, setPosition] = useState<{ latitude: number; longitude: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const statusRef = useRef<RecorderStatus>('idle');
  const activeRef = useRef<ActiveTrip | null>(null);
  const watcherRef = useRef<Location.LocationSubscription | null>(null);
  const accumulatorRef = useRef(createGpsAccumulator());
  const clock = useRef(createTripClock());
  const requestSequence = useRef(0);
  const mounted = useRef(true);
  const isBusy = useCallback(
    () => activeRef.current !== null || statusRef.current === 'requesting',
    [],
  );

  const changeStatus = useCallback((next: RecorderStatus) => {
    statusRef.current = next;
    if (mounted.current) setStatus(next);
  }, []);

  const getElapsed = useCallback(() => clock.current.elapsed(), []);
  const snapshot = useCallback(
    (): ActiveTrip | null =>
      activeRef.current
        ? {
            ...activeRef.current,
            distanceKm: accumulatorRef.current.distanceMeters / 1_000,
            durationSeconds: getElapsed(),
          }
        : null,
    [getElapsed],
  );

  const checkpoint = useCallback(() => {
    const value = snapshot();
    if (!value) return;
    const result = dispatch({ type: 'UPDATE_ACTIVE_TRIP', trip: value });
    if (result.ok) {
      activeRef.current = value;
      if (mounted.current) setActiveTrip(value);
    } else if (mounted.current) setError(result.error);
  }, [dispatch, snapshot]);

  const removeWatcher = useCallback(() => {
    watcherRef.current?.remove();
    watcherRef.current = null;
  }, []);

  const pause = useCallback(() => {
    requestSequence.current += 1;
    removeWatcher();
    const elapsed = clock.current.pause();
    accumulatorRef.current = { ...accumulatorRef.current, lastPoint: null };
    if (activeRef.current) {
      checkpoint();
      changeStatus('paused');
      if (mounted.current) setDurationSeconds(elapsed);
    } else changeStatus('idle');
  }, [changeStatus, checkpoint, removeWatcher]);

  useEffect(() => {
    if (!ready) return;
    if (state.activeTrip?.id === activeRef.current?.id) return;
    removeWatcher();
    requestSequence.current += 1;
    const restored = state.activeTrip;
    activeRef.current = restored;
    setActiveTrip(restored);
    accumulatorRef.current = createGpsAccumulator((restored?.distanceKm ?? 0) * 1_000);
    clock.current.reset(restored?.durationSeconds ?? 0);
    setDistanceKm(restored?.distanceKm ?? 0);
    setDurationSeconds(restored?.durationSeconds ?? 0);
    setPosition(null);
    setAccuracy(null);
    changeStatus(restored ? 'paused' : 'idle');
  }, [state.activeTrip, ready, changeStatus, removeWatcher]);

  useEffect(() => {
    mounted.current = true;
    const subscription = NativeAppState.addEventListener('change', (next) => {
      // Native permission dialogs can briefly make the app inactive. Let that request finish;
      // the foreground check below prevents starting a watcher in the background.
      if (next !== 'active' && statusRef.current === 'recording') pause();
    });
    const visibility = () => {
      if (document.visibilityState === 'hidden') pause();
    };
    const pageHide = () => pause();
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', visibility);
      window.addEventListener('pagehide', pageHide);
    }
    return () => {
      pause();
      mounted.current = false;
      subscription.remove();
      if (Platform.OS === 'web' && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', visibility);
        window.removeEventListener('pagehide', pageHide);
      }
    };
  }, [pause]);

  useEffect(() => {
    if (status !== 'recording') return;
    let seconds = 0;
    const timer = setInterval(() => {
      setDurationSeconds(getElapsed());
      seconds += 1;
      if (seconds % 5 === 0) checkpoint();
    }, 1_000);
    return () => clearInterval(timer);
  }, [status, getElapsed, checkpoint]);

  const enableWatcher = useCallback(
    async (sequence: number): Promise<ActionResult> => {
      clock.current.reset(activeRef.current?.durationSeconds ?? 0);
      try {
        clock.current.resume();
      } catch (cause) {
        const message =
          cause instanceof Error ? cause.message : '기기의 경과 시간 측정을 확인해 주세요.';
        setError(message);
        changeStatus('paused');
        return { ok: false, error: message };
      }
      accumulatorRef.current = createGpsAccumulator((activeRef.current?.distanceKm ?? 0) * 1_000);
      changeStatus('recording');
      const failureMessage =
        '위치 기록을 시작하지 못했어요. 위치 권한·GPS와 보안 연결(HTTPS)을 확인해 주세요.';
      const result = await attachCurrentSubscription(
        () =>
          watchForegroundPosition(
            (location) => {
              if (
                !mounted.current ||
                statusRef.current !== 'recording' ||
                requestSequence.current !== sequence
              )
                return;
              setAccuracy(location.coords.accuracy);
              const result = addGpsPoint(accumulatorRef.current, {
                latitude: location.coords.latitude,
                longitude: location.coords.longitude,
                accuracy: location.coords.accuracy,
                timestamp: location.timestamp,
              });
              accumulatorRef.current = result.accumulator;
              if (result.accepted) {
                setPosition({
                  latitude: location.coords.latitude,
                  longitude: location.coords.longitude,
                });
                setDistanceKm(result.accumulator.distanceMeters / 1_000);
              }
            },
            () => {
              if (!mounted.current || requestSequence.current !== sequence) return;
              pause();
              setError(
                '위치 신호를 받을 수 없어 기록을 일시 정지했어요. 위치 권한과 GPS를 확인한 뒤 재개해 주세요.',
              );
              changeStatus('error');
            },
          ),
        () =>
          mounted.current &&
          requestSequence.current === sequence &&
          statusRef.current === 'recording',
        (subscription) => {
          watcherRef.current = subscription;
          setError(null);
        },
        () => {
          pause();
          setError(failureMessage);
          changeStatus('error');
        },
      );
      if (result === 'attached') return { ok: true };
      return {
        ok: false,
        error:
          result === 'cancelled'
            ? '위치 요청이 중단됐어요. 화면으로 돌아와 다시 시작해 주세요.'
            : failureMessage,
      };
    },
    [changeStatus, pause],
  );

  const requestPermission = useCallback(async (): Promise<ActionResult> => {
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted)
        return {
          ok: false,
          error:
            '위치 권한이 필요해요. 기기 설정에서 이 앱을 사용하는 동안의 위치 접근을 허용해 주세요.',
        };
      const enabled = await Location.hasServicesEnabledAsync();
      if (!enabled) return { ok: false, error: '기기의 위치 서비스를 켠 뒤 다시 시도해 주세요.' };
      if (
        (Platform.OS === 'web' &&
          typeof document !== 'undefined' &&
          document.visibilityState === 'hidden') ||
        (Platform.OS !== 'web' && NativeAppState.currentState !== 'active')
      )
        return { ok: false, error: '앱 화면으로 돌아온 뒤 기록을 시작해 주세요.' };
      return { ok: true };
    } catch {
      return {
        ok: false,
        error:
          '위치 권한을 확인할 수 없어요. 브라우저에서는 HTTPS 연결과 위치 설정을 확인해 주세요.',
      };
    }
  }, []);

  const start = useCallback(
    async (
      vehicleId: string,
      locations: { origin?: string; destination?: string; planId?: string } = {},
    ): Promise<ActionResult> => {
      if (activeRef.current || statusRef.current === 'requesting')
        return { ok: false, error: '진행 중인 주행을 먼저 저장하거나 취소해 주세요.' };
      const sequence = ++requestSequence.current;
      setError(null);
      changeStatus('requesting');
      const permission = await requestPermission();
      if (!mounted.current || requestSequence.current !== sequence)
        return { ok: false, error: '위치 요청이 중단됐어요. 다시 시작해 주세요.' };
      if (!permission.ok) {
        changeStatus('error');
        setError(permission.error);
        return permission;
      }
      const trip: ActiveTrip = {
        id: createId('trip'),
        vehicleId,
        startedAt: new Date().toISOString(),
        distanceKm: 0,
        durationSeconds: 0,
        ...locations,
      };
      const result = dispatch({ type: 'START_TRIP', trip });
      if (!result.ok) {
        changeStatus('error');
        setError(result.error);
        return result;
      }
      activeRef.current = trip;
      setActiveTrip(trip);
      setDistanceKm(0);
      setDurationSeconds(0);
      setPosition(null);
      setAccuracy(null);
      return enableWatcher(sequence);
    },
    [changeStatus, dispatch, enableWatcher, requestPermission],
  );

  const resume = useCallback(async (): Promise<ActionResult> => {
    if (!activeRef.current) return { ok: false, error: '재개할 주행이 없어요.' };
    if (statusRef.current === 'recording' || statusRef.current === 'requesting')
      return { ok: false, error: '이미 위치 기록을 진행하고 있어요.' };
    const sequence = ++requestSequence.current;
    changeStatus('requesting');
    setError(null);
    const permission = await requestPermission();
    if (!mounted.current || requestSequence.current !== sequence)
      return { ok: false, error: '위치 요청이 중단됐어요. 화면으로 돌아와 재개해 주세요.' };
    if (!permission.ok) {
      changeStatus('paused');
      setError(permission.error);
      return permission;
    }
    return enableWatcher(sequence);
  }, [changeStatus, enableWatcher, requestPermission]);

  const finish = useCallback((): ActionResult => {
    if (!activeRef.current) return { ok: false, error: '저장할 주행이 없어요.' };
    pause();
    const current = snapshot()!;
    const endedAt = new Date().toISOString();
    if (!canFinishTripAt(current.startedAt, current.durationSeconds, endedAt)) {
      const message =
        '기기 시간이 주행 시작보다 뒤로 바뀌었어요. 기록은 일시 정지 상태로 보존했으니 기기의 자동 날짜·시간 설정을 복구한 뒤 다시 저장해 주세요.';
      setError(message);
      return { ok: false, error: message };
    }
    const trip: Trip = { ...current, endedAt, source: 'gps' };
    const result = dispatch({ type: 'ADD_TRIP', trip });
    if (result.ok) {
      activeRef.current = null;
      setActiveTrip(null);
      setError(null);
      changeStatus('idle');
    } else setError(result.error);
    return result;
  }, [changeStatus, dispatch, pause, snapshot]);

  const cancel = useCallback(() => {
    pause();
    const result = dispatch({ type: 'DISCARD_ACTIVE_TRIP' });
    if (result.ok) {
      activeRef.current = null;
      setActiveTrip(null);
      setDistanceKm(0);
      setDurationSeconds(0);
      setPosition(null);
      setAccuracy(null);
      setError(null);
      changeStatus('idle');
    } else setError(result.error);
  }, [changeStatus, dispatch, pause]);

  return (
    <RecorderContext.Provider
      value={{
        status,
        activeTrip,
        distanceKm,
        durationSeconds,
        accuracy,
        position,
        error,
        start,
        pause,
        resume,
        finish,
        cancel,
        isBusy,
      }}
    >
      {children}
    </RecorderContext.Provider>
  );
}

export function useTripRecorder(): RecorderContextValue {
  const context = useContext(RecorderContext);
  if (!context) throw new Error('useTripRecorder must be used within TripRecorderProvider');
  return context;
}
