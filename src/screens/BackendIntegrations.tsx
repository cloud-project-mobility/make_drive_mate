import { useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { Button, Chip, Notice, SectionTitle, shared } from '../components/ui';
import { useBackend } from '../state/BackendProvider';
import { backendMessage, type IntegrationStatus } from '../services/backend';

export default function BackendIntegrations() {
  const { client } = useBackend();
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [authorizationUrl, setAuthorizationUrl] = useState('');
  const [disconnect, setDisconnect] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  async function refresh() {
    setBusy(true);
    setError('');
    setMessage('');
    setAuthorizationUrl('');
    setDisconnect(false);
    try {
      setStatus(await client.integrations());
    } catch (cause) {
      setError(backendMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function authorize() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await client.authorizeGoogle();
      setAuthorizationUrl(result.authorization_url);
    } catch (cause) {
      setError(backendMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function openAuthorization() {
    setError('');
    try {
      await Linking.openURL(authorizationUrl);
      setAuthorizationUrl('');
      setMessage('Google 인증을 마치면 앱으로 돌아와 연결 상태를 다시 확인해 주세요.');
    } catch {
      setError('인증 화면을 열지 못했어요. 브라우저 설정을 확인해 주세요.');
    }
  }
  async function remove() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await client.disconnectGoogle();
      setStatus(await client.integrations());
      setMessage(
        result.provider_revoked === false
          ? '이 서버에서 연결을 해제했어요. Google의 권한 철회는 확인하지 못했으니 Google 계정에서도 확인해 주세요.'
          : '이 서버의 Google 캘린더 연결을 해제했어요.',
      );
    } catch (cause) {
      setError(backendMessage(cause));
    } finally {
      setBusy(false);
      setDisconnect(false);
    }
  }
  return (
    <View style={shared.stack}>
      <SectionTitle title="외부 연동 준비 상태" />
      <Button
        title="외부 연동 준비 상태 확인"
        onPress={refresh}
        loading={busy}
        variant="secondary"
      />
      {error ? <Notice title={error} tone="error" /> : null}
      {message ? <Notice title={message} /> : null}
      {status && (
        <>
          {(['kakao', 'google_calendar', 'hyundai'] as const).map((name) => {
            const provider = status.providers[name];
            const title = {
              kakao: 'Kakao 경로',
              google_calendar: 'Google 캘린더',
              hyundai: '현대 차량',
            }[name];
            return (
              <View key={name} style={shared.stack}>
                <Text style={shared.text}>{title}</Text>
                <Chip
                  label={
                    provider.mode === 'mock'
                      ? '예시 데이터 · 실제 계정 연결 안 됨'
                      : provider.connected
                        ? '계정 연결됨 · 실제 조회는 별도 확인'
                        : provider.configured
                          ? '서버 설정 준비됨 · 계정 연결 전'
                          : '연동 설정 필요'
                  }
                />
              </View>
            );
          })}
          <Text style={shared.muted}>
            API 키와 OAuth 비밀값은 서버에서만 설정해요. 예시 응답은 실제 서비스 연결 검증을 뜻하지
            않아요.
          </Text>
          {status.providers.google_calendar.mode === 'live' &&
            status.providers.google_calendar.configured &&
            !status.providers.google_calendar.connected && (
              <>
                <Button
                  title="Google 캘린더 연결 준비"
                  onPress={authorize}
                  disabled={busy}
                  variant="secondary"
                />
                {authorizationUrl ? (
                  <Button title="Google 인증 화면 열기" onPress={openAuthorization} />
                ) : null}
              </>
            )}
          {status.providers.google_calendar.connected &&
            status.providers.google_calendar.mode !== 'mock' && (
              <>
                {disconnect ? (
                  <>
                    <Notice
                      title="Google 캘린더 연결을 해제할까요?"
                      body="서버에 저장한 Google 토큰을 지워요. 기기에 저장한 이동 계획은 유지해요."
                      tone="warning"
                    />
                    <Button
                      title="Google 연결 해제 확정"
                      onPress={remove}
                      disabled={busy}
                      variant="danger"
                    />
                    <Button
                      title="Google 연결 해제 취소"
                      onPress={() => setDisconnect(false)}
                      disabled={busy}
                      variant="ghost"
                    />
                  </>
                ) : (
                  <Button
                    title="Google 캘린더 연결 해제"
                    onPress={() => setDisconnect(true)}
                    disabled={busy}
                    variant="ghost"
                  />
                )}
              </>
            )}
        </>
      )}
    </View>
  );
}
