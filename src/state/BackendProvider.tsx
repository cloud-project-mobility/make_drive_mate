import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  BackendClient,
  BackendError,
  normalizeBackendUrl,
  type BackendSession,
} from '../services/backend';

const URL_KEY = '@drivemate/backend-url:v1';
interface BackendContextValue {
  url: string;
  session: BackendSession | null;
  sessionNotice: string;
  client: BackendClient;
  isCurrentClient: (client: BackendClient) => boolean;
  configure: (url: string) => Promise<void>;
  authenticate: (mode: 'register' | 'login', email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}
const Context = createContext<BackendContextValue | null>(null);
export function BackendProvider({ children }: { children: React.ReactNode }) {
  const [url, setUrl] = useState(() => {
    const fallback =
      Platform.OS === 'web' &&
      typeof window !== 'undefined' &&
      window.location.protocol === 'https:'
        ? window.location.origin
        : 'http://127.0.0.1:18085';
    try {
      return normalizeBackendUrl(process.env.EXPO_PUBLIC_API_BASE_URL || fallback);
    } catch {
      return fallback;
    }
  });
  const [sessionData, setSessionData] = useState<{ value: BackendSession | null; notice: string }>({
    value: null,
    notice: '',
  });
  const session = sessionData.value;
  const sessionNotice = sessionData.notice;
  const generation = useRef(0);
  // These refs change synchronously, before React renders the next account/server scope.
  const sessionRef = useRef<BackendSession | null>(null);
  const urlRef = useRef(url);
  const configuring = useRef(false);
  useEffect(() => {
    const started = generation.current;
    let cancelled = false;
    void AsyncStorage.getItem(URL_KEY)
      .then((saved) => {
        if (saved && !cancelled && generation.current === started) {
          const next = normalizeBackendUrl(saved);
          urlRef.current = next;
          setUrl(next);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!session) return;
    const remaining = Date.parse(session.expires_at) - Date.now();
    const timer = setTimeout(
      () => {
        if (sessionRef.current?.access_token !== session.access_token) return;
        generation.current += 1;
        sessionRef.current = null;
        setSessionData({ value: null, notice: '서버 세션이 만료됐어요. 다시 로그인해 주세요.' });
      },
      Math.max(0, Math.min(remaining, 2_147_483_647)),
    );
    return () => clearTimeout(timer);
  }, [session]);
  const onUnauthorized = useCallback(() => {
    if (!session || sessionRef.current?.access_token !== session.access_token) return;
    generation.current += 1;
    sessionRef.current = null;
    setSessionData({
      value: null,
      notice: '서버 세션이 만료되거나 해제됐어요. 기기 기록은 유지돼요. 다시 로그인해 주세요.',
    });
  }, [session]);
  const client = useMemo(() => new BackendClient(url, session?.access_token), [url, session]);
  const clientScope = useRef({ client, token: session?.access_token });
  useLayoutEffect(() => {
    clientScope.current = { client, token: session?.access_token };
    client.setUnauthorizedHandler(onUnauthorized);
    return () => client.setUnauthorizedHandler(undefined);
  }, [client, session, onUnauthorized]);
  const isCurrentClient = useCallback(
    (candidate: BackendClient) =>
      !!sessionRef.current &&
      candidate === clientScope.current.client &&
      sessionRef.current.access_token === clientScope.current.token &&
      candidate.url === urlRef.current,
    [],
  );
  const configure = useCallback(async (input: string) => {
    if (sessionRef.current) throw new BackendError('로그아웃한 뒤 서버 주소를 변경해 주세요.');
    if (configuring.current)
      throw new BackendError('서버 주소를 저장하는 중이에요. 잠시 뒤 다시 시도해 주세요.');
    const next = normalizeBackendUrl(input);
    generation.current += 1;
    configuring.current = true;
    try {
      await AsyncStorage.setItem(URL_KEY, next);
      urlRef.current = next;
      setUrl(next);
    } finally {
      configuring.current = false;
    }
  }, []);
  const authenticate = useCallback(
    async (mode: 'register' | 'login', email: string, password: string) => {
      if (configuring.current)
        throw new BackendError('서버 주소를 저장하는 중이에요. 잠시 뒤 로그인해 주세요.');
      const current = ++generation.current;
      const startedUrl = urlRef.current;
      const next = await new BackendClient(startedUrl).authenticate(mode, email, password);
      if (
        !next.access_token ||
        !next.user?.id ||
        !next.user.email ||
        !Number.isFinite(Date.parse(next.expires_at)) ||
        Date.parse(next.expires_at) <= Date.now()
      )
        throw new BackendError('로그인 응답 형식을 확인할 수 없어요.');
      if (generation.current !== current) {
        // A superseded login must not leave its newly issued session active on the server.
        void new BackendClient(startedUrl, next.access_token).logout().catch(() => undefined);
        throw new BackendError('서버 설정이 변경됐어요. 다시 로그인해 주세요.');
      }
      sessionRef.current = next;
      setSessionData({ value: next, notice: '' });
    },
    [],
  );
  const logout = useCallback(async () => {
    const current = sessionRef.current;
    generation.current += 1;
    sessionRef.current = null;
    setSessionData({ value: null, notice: '' });
    if (current) await new BackendClient(urlRef.current, current.access_token).logout();
  }, []);
  return (
    <Context.Provider
      value={{
        url,
        session,
        sessionNotice,
        client,
        isCurrentClient,
        configure,
        authenticate,
        logout,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useBackend() {
  const value = useContext(Context);
  if (!value) throw new Error('useBackend must be used within BackendProvider');
  return value;
}
