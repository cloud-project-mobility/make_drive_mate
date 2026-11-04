import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { Button, Card, Chip, Field, Notice, SectionTitle, shared } from '../components/ui';
import {
  BackendClient,
  BackendError,
  backendMessage,
  type BackendHealth,
  type ServerSnapshot,
} from '../services/backend';
import { useBackend } from '../state/BackendProvider';
import { useApp } from '../state/AppProvider';
import { parseStoredState } from '../domain/state';
import type { Settings } from '../domain/types';
import { cancelAllDepartures } from '../services/notifications';
import { replaceAfterPreparation } from '../services/stateReplacement';
import { useMounted } from '../services/useMounted';
import { useTripRecorder } from '../services/useTripRecorder';
import BackendIntegrations from './BackendIntegrations';

function AccountPasswordChange({ onChanged }: { onChanged: () => Promise<void> }) {
  const { client, isCurrentClient } = useBackend();
  const isMounted = useMounted();
  const [opened, setOpened] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const isCurrent = () => isMounted() && isCurrentClient(client);
  function clear() {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmation('');
    setError('');
  }
  async function change() {
    if (busy || !isCurrent()) return;
    setError('');
    if (!currentPassword || newPassword.length < 10 || newPassword.length > 128) {
      setError('현재 비밀번호와 10~128자의 새 비밀번호를 입력해 주세요.');
      return;
    }
    if (newPassword !== confirmation) {
      setError('새 비밀번호와 확인 입력이 일치하지 않아요.');
      return;
    }
    if (currentPassword === newPassword) {
      setError('현재 비밀번호와 다른 새 비밀번호를 입력해 주세요.');
      return;
    }
    setBusy(true);
    try {
      await client.changePassword(currentPassword, newPassword);
      if (!isCurrent()) return;
      clear();
      await onChanged();
    } catch (cause) {
      if (isCurrent()) setError(backendMessage(cause));
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }
  return (
    <View style={shared.stack}>
      <Button
        title={opened ? '비밀번호 변경 취소' : '비밀번호 변경'}
        variant="secondary"
        disabled={busy}
        onPress={() => { clear(); setOpened(!opened); }}
      />
      {opened && (
        <>
          <Text style={shared.muted}>
            변경하면 모든 기기에서 로그아웃돼요. 새 비밀번호로 다시 로그인해 주세요.
          </Text>
          <Field label="현재 비밀번호" value={currentPassword} onChangeText={setCurrentPassword}
            secureTextEntry autoComplete="off" maxLength={128} editable={!busy} />
          <Field label="새 비밀번호" value={newPassword} onChangeText={setNewPassword}
            secureTextEntry autoComplete="off" maxLength={128} editable={!busy} />
          <Field label="새 비밀번호 확인" value={confirmation} onChangeText={setConfirmation}
            secureTextEntry autoComplete="off" maxLength={128} editable={!busy} />
          {error ? <Notice title={error} tone="error" /> : null}
          <Button title="비밀번호 변경 확정" onPress={change} loading={busy} />
        </>
      )}
    </View>
  );
}

function ServerBackup({ onRestored }: { onRestored: (settings: Settings) => void }) {
  const { client, isCurrentClient } = useBackend();
  const { state, dispatch } = useApp();
  const recorder = useTripRecorder();
  const isMounted = useMounted();
  const isCurrent = () => isMounted() && isCurrentClient(client);
  const [snapshot, setSnapshot] = useState<ServerSnapshot | null>(null);
  const [confirm, setConfirm] = useState<'upload' | 'restore' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const blocked = !!state.activeTrip || recorder.status === 'requesting';
  async function inspect() {
    setBusy(true);
    setError('');
    setMessage('');
    setConfirm(null);
    setSnapshot(null);
    try {
      const next = await client.snapshot();
      if (!isCurrent()) return;
      if (!Number.isInteger(next.revision) || next.revision < 0)
        throw new Error('서버 백업 버전이 올바르지 않아요.');
      if (next.state !== null) {
        const parsed = parseStoredState(JSON.stringify(next.state));
        if (!parsed.ok) throw new Error(parsed.error);
        if (!parsed.state.onboarded || parsed.state.activeTrip)
          throw new Error('완료된 기기 데이터만 복원할 수 있어요.');
      }
      setSnapshot(next);
      if (!next.state) setMessage('이 계정에는 아직 서버 백업이 없어요.');
    } catch (cause) {
      if (isCurrent()) setError(backendMessage(cause));
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }
  async function transfer() {
    if (!snapshot || !confirm || busy || blocked || !isCurrent()) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (confirm === 'upload') {
        const next = await client.upload(state, snapshot.revision);
        if (!isCurrent()) return;
        setSnapshot(next);
        setMessage(`서버 백업 버전 ${next.revision}에 저장했어요.`);
      } else if (snapshot.state) {
        const restored = snapshot.state;
        const result = await replaceAfterPreparation(
          cancelAllDepartures,
          () => isCurrent() && !recorder.isBusy(),
          () => dispatch({ type: 'IMPORT_DATA', state: restored }, { expectedState: state }),
        );
        if (!isCurrent()) return;
        if (!result.ok) throw new Error(result.error);
        onRestored(snapshot.state.settings);
        setMessage('서버 백업을 기기에 복원했어요. 필요한 출발 알림을 다시 켜 주세요.');
      }
    } catch (cause) {
      if (isCurrent()) {
        setError(backendMessage(cause));
        setSnapshot(null);
      }
    } finally {
      if (isCurrent()) {
        setBusy(false);
        setConfirm(null);
      }
    }
  }
  return (
    <View style={shared.stack}>
      <SectionTitle title="계정별 서버 백업" />
      <Text style={shared.muted}>
        자동 동기화는 하지 않아요. 계정을 바꿔도 기기 기록은 유지되므로 업로드 전에 내용을 확인해
        주세요. 현재 기기의 차량·일정·주행·점검 기록을 이 서버에 함께 보관합니다.
      </Text>
      {error ? <Notice title={error} tone="error" /> : null}
      {message ? <Notice title={message} /> : null}
      <Button
        title="서버 백업 확인"
        onPress={inspect}
        loading={busy && !confirm}
        disabled={busy}
        variant="secondary"
      />
      {snapshot && (
        <>
          <Text style={shared.muted}>
            서버 버전 {snapshot.revision} ·{' '}
            {snapshot.state
              ? `차량 ${snapshot.state.vehicles.length}대 · 계획 ${snapshot.state.plans.length}개 · 주행 ${snapshot.state.trips.length}개`
              : '저장 데이터 없음'}
          </Text>
          {snapshot.updated_at && (
            <Text style={shared.muted}>
              저장 시각: {new Date(snapshot.updated_at).toLocaleString('ko-KR')}
            </Text>
          )}
          {confirm ? (
            <>
              <Notice
                title={
                  confirm === 'upload'
                    ? '현재 기기 데이터로 서버 백업을 바꿀까요?'
                    : '서버 백업으로 현재 기기 데이터를 바꿀까요?'
                }
                body={
                  confirm === 'upload'
                    ? '다른 기기가 먼저 저장했다면 덮어쓰지 않고 다시 확인하도록 안내해요.'
                    : '현재 기기의 차량과 기록을 교체하고 출발 알림을 해제해요. 필요한 데이터는 먼저 파일로 백업해 주세요.'
                }
                tone="warning"
              />
              <Button
                title={confirm === 'upload' ? '서버에 저장 확정' : '기기에 복원 확정'}
                onPress={transfer}
                disabled={blocked}
                loading={busy}
              />
              <Button
                title="서버 백업 작업 취소"
                onPress={() => setConfirm(null)}
                disabled={busy}
                variant="ghost"
              />
            </>
          ) : (
            <>
              <Button
                title="현재 기기 데이터를 서버에 저장"
                onPress={() => setConfirm('upload')}
                disabled={blocked || busy}
                variant="secondary"
              />
              {snapshot.state && (
                <Button
                  title="서버 백업을 기기에 복원"
                  onPress={() => setConfirm('restore')}
                  disabled={blocked || busy}
                  variant="secondary"
                />
              )}
            </>
          )}
        </>
      )}
      {blocked && (
        <Text style={shared.muted}>
          주행 기록과 위치 권한 요청을 마친 뒤 서버 백업을 저장하거나 복원해 주세요.
        </Text>
      )}
    </View>
  );
}

export default function BackendSettings({
  onRestored,
}: {
  onRestored: (settings: Settings) => void;
}) {
  const backend = useBackend();
  // The Android build also uses the hosted HTTPS service account.
  const serviceWebsite = backend.url.startsWith('https://');
  const [showServerSettings, setShowServerSettings] = useState(!serviceWebsite);
  const [draftUrl, setUrl] = useState<string | null>(null);
  const url = draftUrl ?? backend.url;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [health, setHealth] = useState<BackendHealth | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  async function connect() {
    setBusy(true);
    setError('');
    setMessage('');
    setHealth(null);
    try {
      if (url !== backend.url) {
        await backend.configure(url);
        setUrl(null);
      }
      const next = await new BackendClient(url).health();
      if (next.status !== 'ok' || !['mock', 'disconnected', 'live'].includes(next.provider_mode))
        throw new Error('DriveMate 서버의 상태 응답을 확인할 수 없어요.');
      setHealth(next);
      setMessage(
        serviceWebsite
          ? '서비스에 연결했어요. DriveMate 계정으로 로그인해 주세요.'
          : '서버 응답을 확인했어요. 아래에서 로컬 서버 계정을 사용할 수 있어요.',
      );
    } catch (cause) {
      setError(backendMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function authenticate(mode: 'register' | 'login') {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (url !== backend.url) throw new Error('변경한 서버 주소를 먼저 연결 확인해 주세요.');
      if (!email.trim() || !password)
        throw new Error(
          serviceWebsite
            ? 'DriveMate 계정 이메일과 비밀번호를 입력해 주세요.'
            : '테스트 계정 이메일과 비밀번호를 입력해 주세요.',
        );
      await backend.authenticate(mode, email, password);
      setPassword('');
      setMessage(
        serviceWebsite
          ? mode === 'register'
            ? 'DriveMate 회원가입을 마치고 로그인했어요.'
            : 'DriveMate에 로그인했어요.'
          : '로컬 서버 계정에 로그인했어요. Google·현대 계정 연결과는 별개예요.',
      );
    } catch (cause) {
      const accountErrors: Record<string, string> = {
        invalid_credentials:
          'DriveMate에 가입한 이메일과 비밀번호를 확인해 주세요. 로컬 PC 계정은 자동으로 연결되지 않아요.',
        email_exists: '이미 가입한 이메일이에요. 로그인을 선택해 주세요.',
        email_reserved:
          '이 이메일은 별도 계정 설정이 필요해요. 운영자에게 최초 로그인 안내를 요청해 주세요.',
      };
      setError(
        serviceWebsite && cause instanceof BackendError
          ? accountErrors[cause.code] ?? backendMessage(cause)
          : backendMessage(cause),
      );
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    setBusy(true);
    setError('');
    setMessage('');
    setPassword('');
    try {
      await backend.logout();
      setMessage('로그아웃했어요. 기기 데이터는 유지돼요.');
    } catch (cause) {
      setError(
        `${backendMessage(cause)} 기기에서는 로그아웃했지만 서버 세션 해제는 확인하지 못했어요.`,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card style={shared.stack}>
      <SectionTitle title={serviceWebsite ? 'DriveMate 계정' : '로컬 백엔드 연결'} />
      <Notice
        title={serviceWebsite ? 'DriveMate에서 만든 계정으로 로그인해요' : 'API 키 없는 통합 테스트'}
        body={
          serviceWebsite
            ? 'DriveMate 전용 이메일·비밀번호를 사용해요. Google·AWS·현대 계정 로그인과는 별개예요.'
            : '계정과 백업은 직접 실행한 DriveMate 서버에서 처리해요. Google·Kakao·현대 API 키는 이 화면에 입력하지 않아요.'
        }
      />
      {serviceWebsite && (
        <>
          <Text style={shared.muted}>로그인할 서비스: {new URL(backend.url).host}</Text>
          <Button
            title={showServerSettings ? '서버 설정 접기' : '서버 설정 펼치기'}
            onPress={() => setShowServerSettings(!showServerSettings)}
            disabled={busy}
            variant="ghost"
          />
        </>
      )}
      {showServerSettings && (
        <>
          <Field
            label="백엔드 서버 주소"
            value={url}
            onChangeText={(value) => {
              setUrl(value);
              setHealth(null);
            }}
            editable={!backend.session && !busy}
            keyboardType="url"
            autoCorrect={false}
            hint={
              serviceWebsite
                ? '주소가 바뀌면 사용하는 계정과 데이터도 달라져요. 안내받은 경우에만 변경해 주세요.'
                : 'PC 브라우저: http://127.0.0.1:18085 · 휴대폰: 실행 중인 PC의 같은 네트워크 주소'
            }
          />
          <Button
            title="서버 연결 확인"
            onPress={connect}
            loading={busy && !backend.session}
            disabled={busy}
            variant="secondary"
          />
        </>
      )}
      {health && (
        <Chip
          label={
            health.provider_mode === 'mock'
              ? '서버 연결됨 · 외부 데이터는 예시'
              : health.provider_mode === 'disconnected'
                ? '서버 연결됨 · 외부 연동 꺼짐'
                : '서버 연결됨 · 외부 연동 모드'
          }
        />
      )}
      {error ? <Notice title={error} tone="error" /> : null}
      {message ? <Notice title={message} /> : null}
      {backend.sessionNotice ? <Notice title={backend.sessionNotice} tone="warning" /> : null}
      {backend.session ? (
        <>
          <Text style={shared.heading}>{backend.session.user.email}</Text>
          <Text style={shared.muted}>
            {serviceWebsite ? 'DriveMate 계정' : '로컬 서버 계정'} · 세션 만료{' '}
            {new Date(backend.session.expires_at).toLocaleString('ko-KR')} · 앱을 다시 열면 로그인해
            주세요.
          </Text>
          <Button
            title={serviceWebsite ? '로그아웃' : '로컬 서버 로그아웃'}
            onPress={logout}
            disabled={busy}
            variant="ghost"
          />
          <AccountPasswordChange
            key={`password:${backend.url}:${backend.session.user.id}`}
            onChanged={async () => {
              setPassword('');
              setError('');
              setMessage('비밀번호를 변경했어요. 모든 기기에서 로그아웃되었으니 새 비밀번호로 로그인해 주세요.');
              // The password endpoint already revoked every session. Logout also clears local state.
              await backend.logout();
            }}
          />
          <BackendIntegrations key={`integrations:${backend.url}:${backend.session.user.id}`} />
          <ServerBackup key={`${backend.url}:${backend.session.user.id}`} onRestored={onRestored} />
        </>
      ) : (
        <>
          <Text style={shared.muted}>
            {serviceWebsite
              ? '처음 이용한다면 회원가입을 선택해 주세요. 로컬 PC에서 만든 계정과 이 서비스의 계정은 별도예요.'
              : '과제 테스트용 이메일과 별도 비밀번호를 사용해 주세요.'}{' '}
            비밀번호와 로그인 토큰은 기기에 저장하지 않아요.
          </Text>
          <Field
            label={serviceWebsite ? 'DriveMate 계정 이메일' : '테스트 계정 이메일'}
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoComplete="off"
            maxLength={254}
          />
          <Field
            label={serviceWebsite ? 'DriveMate 계정 비밀번호' : '테스트 계정 비밀번호'}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="off"
            maxLength={128}
            hint="새 계정은 10자 이상의 비밀번호를 사용해 주세요."
          />
          <Button
            title={serviceWebsite ? '로그인' : '로컬 서버 로그인'}
            onPress={() => authenticate('login')}
            disabled={busy}
          />
          <Button
            title={serviceWebsite ? '회원가입' : '로컬 테스트 계정 만들기'}
            onPress={() => authenticate('register')}
            disabled={busy}
            variant="secondary"
          />
          {serviceWebsite && (
            <Text style={shared.muted}>
              비밀번호를 모르거나 계정 안내를 받지 못했다면 서비스 운영자에게 문의해 주세요.
            </Text>
          )}
        </>
      )}
    </Card>
  );
}
