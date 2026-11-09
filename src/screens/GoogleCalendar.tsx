import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, Platform, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Button, Chip, Notice, SectionTitle, shared } from '../components/ui';
import { useBackend } from '../state/BackendProvider';
import {
  backendMessage,
  type CalendarEvent,
  type IntegrationStatus,
  type ProviderSource,
} from '../services/backend';

type Props = { onSelect?: (event: CalendarEvent, source: ProviderSource) => void };
type CalendarStatus = IntegrationStatus['providers']['google_calendar'];
type Events = { source: ProviderSource; events: CalendarEvent[] };

function CalendarContent({ onSelect }: Props) {
  const { session, client, isCurrentClient } = useBackend();
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [events, setEvents] = useState<Events | null>(null);
  const [authorizationUrl, setAuthorizationUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const request = useRef(0);
  const mounted = useRef(false);
  const current = useCallback(
    (id: number) => mounted.current && request.current === id && isCurrentClient(client),
    [client, isCurrentClient],
  );

  const refresh = useCallback(async () => {
    if (!session) return;
    const id = ++request.current;
    setBusy(true);
    setError('');
    // A return from consent/disconnect must not leave an old account's event list visible.
    setEvents(null);
    try {
      const result = await client.integrations();
      if (!current(id)) return;
      setStatus(result.providers.google_calendar);
      if (result.providers.google_calendar.connected) setAuthorizationUrl('');
    } catch (cause) {
      if (current(id)) {
        setStatus(null);
        setError(backendMessage(cause));
      }
    } finally {
      if (current(id)) setBusy(false);
    }
  }, [session, client, current]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refresh();
    });
    const returned = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    if (Platform.OS === 'web') window.addEventListener('focus', returned);
    return () => {
      mounted.current = false;
      request.current++;
      subscription.remove();
      if (Platform.OS === 'web') window.removeEventListener('focus', returned);
    };
  }, [refresh]);

  async function authorize() {
    const id = ++request.current;
    setBusy(true);
    setError('');
    setMessage('');
    setAuthorizationUrl('');
    setEvents(null);
    try {
      const result = await client.authorizeGoogle();
      if (current(id)) setAuthorizationUrl(result.authorization_url);
    } catch (cause) {
      if (current(id)) setError(backendMessage(cause));
    } finally {
      if (current(id)) setBusy(false);
    }
  }

  async function openAuthorization() {
    const id = ++request.current;
    setError('');
    try {
      // Separate user gesture avoids opening a popup after an asynchronous network request.
      await Linking.openURL(authorizationUrl);
      if (current(id)) {
        setAuthorizationUrl('');
        setMessage(
          'Google 동의를 마친 뒤 이 화면으로 돌아와 주세요. 연결 상태를 다시 확인할 수 있어요.',
        );
      }
    } catch {
      if (current(id)) setError('Google 인증 화면을 열지 못했어요. 다시 시도해 주세요.');
    }
  }

  async function load() {
    const id = ++request.current;
    setBusy(true);
    setError('');
    setMessage('');
    setEvents(null);
    try {
      const result = await client.calendar();
      if (current(id)) setEvents(result);
    } catch (cause) {
      if (!current(id)) return;
      setError(backendMessage(cause));
      // Refresh may have discarded a revoked grant; show a reconnect action immediately.
      try {
        const result = await client.integrations();
        if (current(id)) setStatus(result.providers.google_calendar);
      } catch {
        /* Retain the original actionable query error. */
      }
    } finally {
      if (current(id)) setBusy(false);
    }
  }

  async function disconnect() {
    const id = ++request.current;
    setBusy(true);
    setError('');
    setEvents(null);
    setAuthorizationUrl('');
    try {
      const result = await client.disconnectGoogle();
      if (!current(id)) return;
      setStatus((old) => (old ? { ...old, connected: false, live_verified: false } : null));
      setMessage(
        result.provider_revoked === false
          ? 'DriveMate 연결은 해제됐어요. Google 권한 철회는 확인하지 못했으니 Google 계정에서도 확인해 주세요.'
          : 'Google 캘린더 연결을 해제했어요. 저장한 이동 계획은 유지해요.',
      );
    } catch (cause) {
      if (current(id)) setError(backendMessage(cause));
    } finally {
      if (current(id)) {
        setBusy(false);
        setConfirmDisconnect(false);
      }
    }
  }

  const mock = status?.mode === 'mock';
  const ready = mock || (status?.mode === 'live' && status.configured && status.connected);
  return (
    <View style={shared.stack}>
      <SectionTitle title="Google 캘린더" />
      <Text style={shared.muted}>
        일정 읽기 전용이에요. 선택한 일정을 이동 계획에 복사하며, Google 원본 변경은 자동 반영되지
        않아요.
      </Text>
      {!session ? (
        <>
          <Notice
            title="DriveMate 로그인 후 캘린더를 연결할 수 있어요"
            body="설정에서 DriveMate 계정으로 로그인한 뒤 돌아와 주세요. Google 연결은 별도의 동의가 필요해요."
          />
          <Button
            title="로그인 설정으로 이동"
            onPress={() => router.push('/settings')}
            variant="secondary"
          />
        </>
      ) : (
        <>
          <Button
            title="캘린더 연결 상태 확인"
            onPress={refresh}
            loading={busy}
            variant="secondary"
          />
          {status && (
            <Chip
              label={
                mock
                  ? '예시 모드 · 실제 Google 계정 연결 안 됨'
                  : status.mode === 'disconnected'
                    ? '캘린더 연결 사용 안 함'
                    : !status.configured
                      ? '캘린더 연결 준비 중'
                      : status.connected
                        ? 'Google 계정 연결됨'
                        : 'Google 계정 연결 필요'
              }
            />
          )}
          {status?.mode === 'live' && !status.configured && (
            <Notice
              title="아직 캘린더 연결을 사용할 수 없어요"
              body="운영자의 연결 설정이 필요해요. 지금은 이동 계획을 직접 입력할 수 있어요."
            />
          )}
          {status?.mode === 'live' && status.configured && !status.connected && (
            <>
              <Button
                title={authorizationUrl ? '연결 요청 다시 준비' : 'Google 캘린더 연결 준비'}
                onPress={authorize}
                disabled={busy}
              />
              {authorizationUrl && (
                <>
                  <Text style={shared.muted}>
                    다음 버튼으로 Google 인증 화면을 열어 읽기 권한을 승인해 주세요. 연결 요청은
                    10분 후 만료돼요.
                  </Text>
                  <Button
                    title="Google 인증 화면 열기"
                    onPress={openAuthorization}
                    disabled={busy}
                  />
                </>
              )}
            </>
          )}
          {onSelect && ready && (
            <>
              <Text style={shared.muted}>지금부터 30일 동안의 기본 캘린더 일정을 불러와요.</Text>
              <Button
                title={mock ? '예시 캘린더 일정 불러오기' : 'Google 캘린더 일정 불러오기'}
                onPress={load}
                disabled={busy}
                variant="secondary"
                icon="calendar"
              />
            </>
          )}
          {status?.mode === 'live' && status.connected && (
            <>
              {confirmDisconnect ? (
                <>
                  <Notice
                    title="Google 캘린더 연결을 해제할까요?"
                    body="서버의 Google 연결 정보를 삭제해요. 이미 저장한 이동 계획은 유지해요."
                    tone="warning"
                  />
                  <Button
                    title="Google 연결 해제 확정"
                    onPress={disconnect}
                    disabled={busy}
                    variant="danger"
                  />
                  <Button
                    title="Google 연결 해제 취소"
                    onPress={() => setConfirmDisconnect(false)}
                    disabled={busy}
                    variant="ghost"
                  />
                </>
              ) : (
                <Button
                  title="Google 캘린더 연결 해제"
                  onPress={() => setConfirmDisconnect(true)}
                  disabled={busy}
                  variant="ghost"
                />
              )}
            </>
          )}
        </>
      )}
      {error ? <Notice title={error} tone="error" /> : null}
      {message ? <Notice title={message} /> : null}
      {events && onSelect && (
        <>
          <Chip
            label={
              events.source === 'mock'
                ? '서버 예시 일정 · Google 연결 안 됨'
                : '연결된 Google 캘린더에서 조회한 일정'
            }
          />
          {!events.events.length && (
            <Notice
              title="앞으로 30일 동안 가져올 일정이 없어요"
              body="기본 캘린더를 확인하거나 이동 계획을 직접 입력해 주세요."
            />
          )}
          {events.events.map((event) => (
            <View key={event.id} style={shared.stack}>
              <Text style={shared.text}>
                {event.title} ·{' '}
                {event.all_day
                  ? `${event.start_date} 종일`
                  : event.start_at
                    ? new Date(event.start_at).toLocaleString('ko-KR')
                    : '시간 미정'}
              </Text>
              <Text style={shared.muted}>
                {event.location || '장소 없음 · 도착지를 직접 입력해 주세요.'}
              </Text>
              {event.all_day && (
                <Text style={shared.muted}>선택한 뒤 도착 시간을 직접 입력해 주세요.</Text>
              )}
              <Button
                title={`${event.title} 일정 선택`}
                onPress={() => onSelect(event, events.source)}
                disabled={busy}
                variant="secondary"
              />
            </View>
          ))}
        </>
      )}
    </View>
  );
}

/** Remount on account/server changes so no Google URL or private event list crosses identities. */
export default function GoogleCalendar(props: Props) {
  const { url, session } = useBackend();
  return (
    <CalendarContent
      key={`${url}:${session?.user.id ?? 'anonymous'}:${session?.expires_at ?? ''}`}
      {...props}
    />
  );
}
