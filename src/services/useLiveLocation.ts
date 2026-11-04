import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useBackend } from '../state/BackendProvider';
import { BackendError } from './backend';
import { watchForegroundPosition } from './locationWatcher';
import {
  LOCATION_TTL_MS,
  locationErrorMessage,
  locationSocketUrl,
  locationTicket,
  parseLocationMessage,
  type LivePosition,
} from './liveLocation';

type Status = 'disconnected' | 'connecting' | 'connected' | 'offline';

export function useLiveLocation() {
  const { client, session, isCurrentClient } = useBackend();
  const [status, setStatus] = useState<Status>('disconnected');
  const [sharing, setSharing] = useState(false);
  const [ownPosition, setOwnPosition] = useState<LivePosition | null>(null);
  const [peerPositions, setPeerPositions] = useState<LivePosition[]>([]);
  const [notice, setNotice] = useState('');
  const socket = useRef<WebSocket | null>(null);
  const watcher = useRef<{ remove: () => void } | null>(null);
  const generation = useRef(0);
  const watchGeneration = useRef(0);
  const lastSent = useRef(0);
  const sharingRef = useRef(false);
  const sourceId = useRef('');
  const ready = useRef(false);
  const mounted = useRef(true);
  const readyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopSharing = useCallback((message = '') => {
    watchGeneration.current += 1;
    watcher.current?.remove();
    watcher.current = null;
    const wasSharing = sharingRef.current;
    sharingRef.current = false;
    lastSent.current = 0;
    if (wasSharing && ready.current && socket.current?.readyState === 1) {
      try {
        socket.current.send(JSON.stringify({ type: 'stop' }));
      } catch {
        socket.current.close();
      }
    }
    if (mounted.current) {
      setSharing(false);
      setOwnPosition(null);
      if (message) setNotice(message);
    }
  }, []);

  const disconnect = useCallback(
    (message = '') => {
      generation.current += 1;
      stopSharing();
      ready.current = false;
      sourceId.current = '';
      if (readyTimer.current) clearTimeout(readyTimer.current);
      readyTimer.current = null;
      const previous = socket.current;
      socket.current = null;
      previous?.close();
      if (mounted.current) {
        setPeerPositions([]);
        setStatus('disconnected');
        setNotice(message);
      }
    },
    [stopSharing],
  );

  useEffect(() => {
    // Tear down the old account's socket and watch before its next effect subscribes.
    return () => disconnect();
  }, [client, session?.access_token, disconnect]);

  useFocusEffect(
    useCallback(
      () => () => disconnect('다른 화면으로 이동해 위치 연결을 멈췄어요. 다시 연결해 주세요.'),
      [disconnect],
    ),
  );

  useEffect(() => {
    mounted.current = true;
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const offline = () => {
      disconnect('인터넷 연결이 끊겨 위치 전송을 멈췄어요. 다시 연결한 뒤 직접 시작해 주세요.');
      setStatus('offline');
    };
    const online = () => {
      setStatus('disconnected');
      setNotice('인터넷에 다시 연결됐어요. 위치 연결과 전송은 직접 다시 시작해 주세요.');
    };
    const hide = () => {
      if (document.visibilityState === 'hidden')
        disconnect('화면이 가려져 위치 연결을 멈췄어요. 돌아온 뒤 다시 연결해 주세요.');
    };
    const pageHide = () => disconnect();
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    window.addEventListener('pagehide', pageHide);
    document.addEventListener('visibilitychange', hide);
    if (!navigator.onLine) offline();
    const expiry = setInterval(() => {
      const now = Date.now();
      setPeerPositions((previous) =>
        previous.filter((point) => now - Date.parse(point.received_at) < LOCATION_TTL_MS),
      );
      setOwnPosition((previous) =>
        previous && now - Date.parse(previous.received_at) < LOCATION_TTL_MS ? previous : null,
      );
    }, 1_000);
    return () => {
      mounted.current = false;
      disconnect();
      clearInterval(expiry);
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
      window.removeEventListener('pagehide', pageHide);
      document.removeEventListener('visibilitychange', hide);
    };
  }, [disconnect]);

  const connect = useCallback(async () => {
    if (!session || !isCurrentClient(client)) {
      setNotice('서버에 로그인한 뒤 같은 계정의 기기를 연결해 주세요.');
      return;
    }
    if (
      Platform.OS !== 'web' ||
      typeof window === 'undefined' ||
      typeof WebSocket === 'undefined'
    ) {
      setNotice('실시간 기기 위치는 현재 웹 버전에서 사용할 수 있어요.');
      return;
    }
    if (!navigator.onLine) {
      setStatus('offline');
      return;
    }
    disconnect();
    const current = generation.current;
    setStatus('connecting');
    try {
      const url = locationSocketUrl(client.url, window.location.origin);
      const ticket = await locationTicket(client);
      if (!mounted.current || generation.current !== current || !isCurrentClient(client)) return;
      const connection = new WebSocket(url, ['drivemate.location.v1', `ticket.${ticket}`]);
      socket.current = connection;
      const valid = () =>
        mounted.current && generation.current === current && isCurrentClient(client);
      readyTimer.current = setTimeout(() => {
        if (valid() && !ready.current)
          disconnect('위치 서버 연결 시간이 초과됐어요. 다시 연결해 주세요.');
      }, 12_000);
      connection.onmessage = (event) => {
        if (!valid()) {
          connection.close();
          return;
        }
        const message = parseLocationMessage(event.data);
        if (!message) {
          disconnect('위치 서버 응답을 확인할 수 없어 연결을 종료했어요.');
          return;
        }
        if (message.type === 'ready') {
          if (readyTimer.current) clearTimeout(readyTimer.current);
          ready.current = true;
          sourceId.current = message.source_id;
          setStatus('connected');
          setNotice(
            '같은 계정의 연결된 기기만 위치를 볼 수 있어요. 내 위치는 전송 시작을 눌러야 보내요.',
          );
        } else if (message.type === 'stopped') {
          setPeerPositions((previous) =>
            previous.filter((point) => point.source_id !== message.source_id),
          );
        } else if (ready.current && message.source_id !== sourceId.current) {
          setPeerPositions((previous) =>
            [...previous.filter((point) => point.source_id !== message.source_id), message].slice(
              -2,
            ),
          );
        }
      };
      connection.onclose = (event) => {
        if (valid())
          disconnect(
            event.code === 4401
              ? '로그인 세션이 종료되어 위치 연결을 멈췄어요. 다시 로그인해 주세요.'
              : event.code === 1013
                ? '같은 계정의 연결 가능한 기기 수를 초과했어요. 다른 기기 연결을 끊고 다시 시도해 주세요.'
                : '위치 연결이 종료됐어요. 세션과 네트워크를 확인한 뒤 다시 연결해 주세요.',
          );
      };
      connection.onerror = () => {
        if (valid())
          disconnect('위치 서버에 연결하지 못했어요. 서버와 HTTPS 연결을 확인해 주세요.');
      };
    } catch (error) {
      if (mounted.current && generation.current === current)
        disconnect(
          error instanceof BackendError && error.status === 401
            ? '로그인 세션을 확인한 뒤 다시 연결해 주세요.'
            : error instanceof BackendError && error.status === 403
              ? '이 웹 주소에서는 위치 연결이 허용되지 않아요. 배포된 앱 주소를 확인해 주세요.'
              : '위치 연결을 시작하지 못했어요. 로그인·같은 웹 주소·서버 설정을 확인해 주세요.',
        );
    }
  }, [client, session, isCurrentClient, disconnect]);

  const startSharing = useCallback(async () => {
    if (
      !ready.current ||
      socket.current?.readyState !== 1 ||
      !isCurrentClient(client) ||
      sharingRef.current
    )
      return;
    if (document.visibilityState !== 'visible' || !navigator.onLine) return;
    const current = ++watchGeneration.current;
    sharingRef.current = true;
    setSharing(true);
    setNotice('브라우저의 위치 권한 요청을 확인해 주세요. 첫 위치를 기다리고 있어요.');
    try {
      const subscription = await watchForegroundPosition(
        (location) => {
          if (
            !mounted.current ||
            current !== watchGeneration.current ||
            !sharingRef.current ||
            !isCurrentClient(client)
          )
            return;
          const now = Date.now();
          if (now - lastSent.current < 1_000 || !ready.current || socket.current?.readyState !== 1)
            return;
          if (
            !Number.isFinite(location.timestamp) ||
            location.timestamp < now - 120_000 ||
            location.timestamp > now + 30_000
          ) {
            setNotice('측정 시각이 오래됐거나 올바르지 않아 위치를 전송하지 않았어요.');
            return;
          }
          const point = {
            type: 'position' as const,
            source_id: sourceId.current,
            latitude: location.coords.latitude,
            longitude: location.coords.longitude,
            accuracy_m: location.coords.accuracy,
            observed_at: new Date(location.timestamp).toISOString(),
            received_at: new Date(now).toISOString(),
          };
          if (!parseLocationMessage(JSON.stringify(point), now)) {
            setNotice('새 위치의 정확도나 시각을 확인할 수 없어 전송하지 않았어요.');
            return;
          }
          const outgoing = {
            type: 'position',
            latitude: point.latitude,
            longitude: point.longitude,
            accuracy_m: point.accuracy_m,
            observed_at: point.observed_at,
          };
          try {
            if (socket.current.bufferedAmount > 4096) {
              stopSharing('연결이 느려 위치 전송을 멈췄어요. 다시 연결해 주세요.');
              return;
            }
            socket.current.send(JSON.stringify(outgoing));
            lastSent.current = now;
            setOwnPosition(point as LivePosition);
            setNotice('현재 기기 위치를 같은 계정에 전송하고 있어요.');
          } catch {
            disconnect('위치 전송이 중단됐어요. 다시 연결해 주세요.');
          }
        },
        (reason) => {
          if (current === watchGeneration.current) stopSharing(locationErrorMessage(reason));
        },
      );
      if (!mounted.current || current !== watchGeneration.current || !sharingRef.current)
        subscription.remove();
      else watcher.current = subscription;
    } catch (error) {
      if (current === watchGeneration.current)
        stopSharing(
          locationErrorMessage(error instanceof Error ? error.message : 'position_unavailable'),
        );
    }
  }, [client, isCurrentClient, disconnect, stopSharing]);

  return {
    status,
    sharing,
    ownPosition,
    peerPositions,
    notice,
    connect,
    disconnect,
    startSharing,
    stopSharing,
    loggedIn: !!session,
  };
}
