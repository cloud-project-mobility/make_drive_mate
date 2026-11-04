import React, { useState } from 'react';
import { Modal, Platform, StyleSheet, Text, View } from 'react-native';
import { Button, C, Card, Field, Notice, SectionTitle, shared } from '../components/ui';
import { useApp } from '../state/AppProvider';
import type { AppState, Settings } from '../domain/types';
import { useTripRecorder } from '../services/useTripRecorder';
import { exportBackup, parseBackup } from '../services/backup';
import { cancelAllDepartures } from '../services/notifications';
import { replaceAfterPreparation } from '../services/stateReplacement';
import { useMounted } from '../services/useMounted';

/** A pasted backup is validated and reviewed before any current data changes. */
export default function BackupSettings({
  onRestored,
}: {
  onRestored?: (settings: Settings) => void;
}) {
  const { state, dispatch } = useApp();
  const recorder = useTripRecorder();
  const isMounted = useMounted();
  const pendingLocation = recorder.status === 'requesting';
  const [inputOpen, setInputOpen] = useState(false);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<AppState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  async function backup() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await exportBackup(state);
      if (!result.ok) setError(result.error);
      else
        setMessage(
          Platform.OS === 'web'
            ? '백업 파일 다운로드를 요청했어요. 브라우저의 다운로드 목록을 확인해 주세요.'
            : '백업 공유를 요청했어요. 선택한 앱에 백업 내용을 저장해 주세요.',
        );
    } catch {
      setError('백업을 내보내지 못했어요. 기기의 공유 또는 다운로드 설정을 확인해 주세요.');
    } finally {
      setBusy(false);
    }
  }
  function validate() {
    setMessage(null);
    setError(null);
    if (pendingLocation) {
      setError('위치 권한 요청이 끝난 뒤 복원해 주세요.');
      return;
    }
    if (state.activeTrip) {
      setError('진행 중인 주행을 먼저 저장하거나 취소해 주세요.');
      return;
    }
    const result = parseBackup(text);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (result.state.activeTrip) {
      setError(
        '진행 중인 주행이 포함된 백업은 복원할 수 없어요. 원래 기기에서 주행을 저장한 뒤 다시 백업해 주세요.',
      );
      return;
    }
    if (!result.state.onboarded) {
      setError('사용을 시작하기 전의 빈 데이터예요. 차량과 기록이 있는 백업을 확인해 주세요.');
      return;
    }
    setPreview(result.state);
  }
  async function restore() {
    if (!preview || busy) return;
    if (pendingLocation) {
      setError('위치 권한 요청이 끝난 뒤 복원해 주세요.');
      return;
    }
    if (state.activeTrip) {
      setError('진행 중인 주행을 먼저 저장하거나 취소해 주세요.');
      setPreview(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await replaceAfterPreparation(
        cancelAllDepartures,
        () => isMounted() && !recorder.isBusy(),
        () => dispatch({ type: 'IMPORT_DATA', state: preview }, { expectedState: state }),
      );
      if (!isMounted()) return;
      if (!result.ok) {
        setError(result.error);
        setPreview(null);
        return;
      }
      onRestored?.(preview.settings);
      setPreview(null);
      setText('');
      setInputOpen(false);
      setMessage('백업을 복원했어요. 기기 출발 알림은 필요한 일정에서 다시 켜 주세요.');
    } catch {
      setError('기존 출발 알림을 해제하지 못해 복원을 멈췄어요. 다시 시도해 주세요.');
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card style={shared.stack}>
      <SectionTitle title="백업과 복원" />
      <Text style={shared.muted}>
        다른 기기로 옮기거나 앱을 삭제하기 전에 차량과 기록을 백업해 주세요. 백업에는 장소와 주행
        기록이 포함되니 믿을 수 있는 곳에 보관해 주세요.
      </Text>
      <Button
        title="내 데이터 백업 내보내기"
        icon="download"
        variant="secondary"
        onPress={backup}
        loading={busy && !preview}
        disabled={!!state.activeTrip || pendingLocation}
        testID="export-backup"
      />
      {state.activeTrip && (
        <Text style={shared.muted}>진행 중인 주행을 저장하거나 취소한 뒤 백업할 수 있어요.</Text>
      )}
      <Text style={s.caption}>
        {Platform.OS === 'web'
          ? 'JSON 파일로 내려받아요.'
          : '백업 내용을 텍스트로 공유해요. 파일이나 메모에 저장해 두세요.'}
      </Text>
      {message && <Notice title="백업 상태" body={message} />}
      {error && <Notice title="백업을 확인해 주세요" body={error} tone="error" />}
      {inputOpen ? (
        <View style={shared.stack}>
          <Field
            label="백업 내용 붙여넣기"
            placeholder="백업 파일을 열어 전체 내용을 붙여넣어 주세요."
            multiline
            numberOfLines={6}
            value={text}
            onChangeText={setText}
            style={s.backupInput}
            autoCorrect={false}
            maxLength={5_000_001}
            testID="backup-input"
          />
          <Button
            title="백업 확인하기"
            variant="secondary"
            icon="check-circle"
            onPress={validate}
            disabled={busy || !text.trim() || !!state.activeTrip || pendingLocation}
            testID="validate-backup"
          />
          <Button
            title="복원 취소"
            variant="ghost"
            onPress={() => {
              setInputOpen(false);
              setText('');
              setError(null);
            }}
            disabled={busy}
          />
        </View>
      ) : (
        <Button
          title="백업에서 복원하기"
          variant="ghost"
          icon="upload"
          onPress={() => {
            setInputOpen(true);
            setMessage(null);
          }}
          disabled={busy || !!state.activeTrip || pendingLocation}
        />
      )}
      <Modal
        visible={preview !== null}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!busy) setPreview(null);
        }}
      >
        <View style={s.backdrop}>
          <Card style={s.dialog}>
            <Text accessibilityRole="header" style={shared.heading}>
              이 백업으로 바꿀까요?
            </Text>
            {preview && (
              <>
                <Text style={shared.text}>
                  가져올 데이터: 차량 {preview.vehicles.length}대 · 이동 계획 {preview.plans.length}
                  개 · 주행 기록 {preview.trips.length}개 · 정비 기록 {preview.maintenance.length}개
                </Text>
                <Text style={shared.muted}>
                  현재 데이터: 차량 {state.vehicles.length}대 · 이동 계획 {state.plans.length}개 ·
                  주행 기록 {state.trips.length}개
                </Text>
              </>
            )}
            <Notice
              title="현재 데이터 전체를 교체해요"
              body="기존 데이터와 예약한 출발 알림을 지우고 백업 내용을 적용해요. 현재 기록이 필요하면 먼저 백업을 내보내 주세요."
              tone="warning"
            />
            <Button
              title="현재 데이터를 백업으로 교체"
              variant="danger"
              onPress={restore}
              loading={busy}
              testID="confirm-restore"
            />
            <Button
              title="돌아가기"
              variant="ghost"
              onPress={() => setPreview(null)}
              disabled={busy}
            />
          </Card>
        </View>
      </Modal>
    </Card>
  );
}
const s = StyleSheet.create({
  caption: { color: C.muted, fontSize: 11, lineHeight: 18 },
  backupInput: { minHeight: 150, textAlignVertical: 'top', fontSize: 12, lineHeight: 18 },
  backdrop: {
    flex: 1,
    backgroundColor: '#17343299',
    padding: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dialog: { width: '100%', maxWidth: 460, gap: 18 },
});
