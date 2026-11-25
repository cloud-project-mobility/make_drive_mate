import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { createRoutePoller } from '../domain/routePolling';
import { BackendError, backendMessage, type BackendClient, type RouteEstimate } from './backend';

interface RouteReading {
  request: (signal: AbortSignal) => Promise<RouteEstimate>;
  apply?: (estimate: RouteEstimate) => void;
}

export function useRoutePolling(client: BackendClient, key: string, reading: RouteReading) {
  const callbacks = useRef(reading);
  useLayoutEffect(() => {
    callbacks.current = reading;
  });
  const scope = useMemo(() => ({ client, key }), [client, key]);
  type ReadingState = {
    value: RouteEstimate | null;
    error: string;
    loading: boolean;
  };
  const [view, setView] = useState<ReadingState & { scope: typeof scope }>();
  const control = useRef<ReturnType<typeof createRoutePoller> | null>(null);
  const visible = useRef(false);
  useLayoutEffect(() => {
    const start = { scope, value: null, error: '', loading: false };
    const update = (change: Partial<ReadingState>) =>
      setView((previous) => ({ ...(previous?.scope === scope ? previous : start), ...change }));
    const poller = createRoutePoller(
      async (signal) => {
        update({ loading: true, error: '' });
        signal.addEventListener('abort', () => update({ loading: false }), { once: true });
        const { request, apply } = callbacks.current;
        const next = await request(signal);
        if (signal.aborted) return;
        apply?.(next);
        update({ value: next, error: '', loading: false });
      },
      (cause, failures) => {
        const permanent =
          cause instanceof BackendError &&
          cause.status >= 400 &&
          cause.status < 500 &&
          cause.status !== 408;
        const paused = permanent || failures >= 2;
        const next = paused ? '자동 갱신을 멈췄어요.' : '5분 뒤에 한 번 더 확인해요.';
        update({ loading: false, error: `${backendMessage(cause)} ${next}` });
        return paused ? 'pause' : 'retry';
      },
    );
    control.current = poller;
    poller.setVisible(visible.current);
    return () => {
      poller.setVisible(false);
      control.current = null;
    };
  }, [scope]);
  const request = useCallback(() => control.current?.request(), []);
  useFocusEffect(
    useCallback(() => {
      const setVisible = (active: boolean) => {
        visible.current = active;
        control.current?.setVisible(active);
      };
      const sync = () => {
        const active =
          Platform.OS === 'web'
            ? typeof document !== 'undefined' && document.visibilityState !== 'hidden'
            : AppState.currentState === 'active';
        setVisible(active);
      };
      const hide = () => setVisible(false);
      sync();
      const subscription = AppState.addEventListener('change', sync);
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        document.addEventListener('visibilitychange', sync);
        window.addEventListener('pagehide', hide);
        window.addEventListener('pageshow', sync);
      }
      return () => {
        hide();
        subscription.remove();
        if (Platform.OS === 'web' && typeof window !== 'undefined') {
          document.removeEventListener('visibilitychange', sync);
          window.removeEventListener('pagehide', hide);
          window.removeEventListener('pageshow', sync);
        }
      };
    }, []),
  );
  return {
    value: view?.scope === scope ? view.value : null,
    error: view?.scope === scope ? view.error : '',
    loading: view?.scope === scope && view.loading,
    request,
  };
}
