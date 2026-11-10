import { useState } from 'react';
import { Text, View } from 'react-native';
import { Button, Chip, Notice, SectionTitle, shared } from '../components/ui';
import { useBackend } from '../state/BackendProvider';
import GoogleCalendar from './GoogleCalendar';
import { backendMessage, type IntegrationStatus } from '../services/backend';

export default function BackendIntegrations() {
  const { client } = useBackend();
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function refresh() {
    setBusy(true);
    setError('');
    try {
      setStatus(await client.integrations());
    } catch (cause) {
      setError(backendMessage(cause));
    } finally {
      setBusy(false);
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
      {status && (
        <>
          {(['kakao', 'hyundai'] as const).map((name) => {
            const provider = status.providers[name];
            const title = {
              kakao: 'Kakao 경로',
              hyundai: '현대 차량',
            }[name];
            return (
              <View key={name} style={shared.stack}>
                <Text style={shared.text}>{title}</Text>
                <Chip
                  label={
                    provider.mode === 'mock'
                      ? '예시 데이터 · 실제 계정 연결 안 됨'
                      : provider.mode === 'disconnected'
                        ? '외부 연동 꺼짐'
                        : name === 'kakao'
                          ? provider.live_verified
                            ? '서비스 키 연결 · 실제 조회 이력 있음'
                            : provider.configured
                              ? '서비스 키 설정됨 · 실제 조회 확인 전'
                              : '서비스 키 설정 필요'
                          : name === 'hyundai' && provider.reason === 'implementation_pending'
                            ? '실차 연동 준비 중 · 아직 연결 안 됨'
                            : provider.connected
                              ? '계정 연결됨 · 실제 조회는 별도 확인'
                              : provider.configured
                                ? '서버 설정 준비됨 · 계정 연결 전'
                                : '연동 설정 필요'
                  }
                />
                {name === 'kakao' && provider.mode === 'live' && (
                  <>
                    <Text style={shared.muted}>
                      서비스에서 카카오를 연결해요. 개인 카카오 계정 로그인은 필요하지 않아요.
                    </Text>
                    {provider.capabilities &&
                      (['places', 'routes'] as const).map((capability) => {
                        const item = provider.capabilities![capability];
                        return (
                          <Text key={capability} style={shared.muted}>
                            {capability === 'places' ? '장소 검색' : '길찾기'}:{' '}
                            {!item.configured
                              ? '설정 필요'
                              : item.live_verified
                                ? '실제 조회 확인됨'
                                : '준비됨 · 실제 조회 확인 전'}
                            {item.live_verified && item.last_verified_at
                              ? ` · ${new Date(item.last_verified_at).toLocaleString('ko-KR')}`
                              : ''}
                          </Text>
                        );
                      })}
                  </>
                )}
                {name === 'hyundai' && provider.reason === 'implementation_pending' && (
                  <Text style={shared.muted}>
                    현재는 실제 차량 인증과 상태 조회를 지원하지 않아요. API 설정만으로 차량이
                    연결되지는 않아요.
                  </Text>
                )}
              </View>
            );
          })}
          <Text style={shared.muted}>
            API 키와 OAuth 비밀값은 서버에서만 설정해요. 예시 응답은 실제 서비스 연결 검증을 뜻하지
            않아요.
          </Text>
        </>
      )}
      <GoogleCalendar />
    </View>
  );
}
