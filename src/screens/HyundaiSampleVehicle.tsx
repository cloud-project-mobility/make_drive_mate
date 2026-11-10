import { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Button, Card, Chip, Notice, SectionTitle, shared } from '../components/ui';
import type { Powertrain } from '../domain/types';
import { BackendError, type BackendClient } from '../services/backend';
import {
  importHyundaiSample,
  readHyundaiSample,
  type HyundaiSample,
} from '../services/hyundaiSample';
import { useMounted } from '../services/useMounted';
import { useBackend } from '../state/BackendProvider';

const categories: { value: Powertrain; label: string }[] = [
  { value: 'ICE', label: '내연기관' },
  { value: 'HYB', label: '하이브리드' },
  { value: 'EV', label: '전기차' },
];

function SampleContent() {
  const { client, session, isCurrentClient } = useBackend();
  const isMounted = useMounted();
  const sequence = useRef(0);
  const pending = useRef<BackendClient | null>(null);
  const [category, setCategory] = useState<Powertrain | null>(null);
  const [result, setResult] = useState<{
    client: BackendClient;
    sample: HyundaiSample | null;
    busy: boolean;
    message: string;
    error: string;
  } | null>(null);
  const current = session && result?.client === client ? result : null;
  const busy = current?.busy ?? false;

  async function load(importing: boolean) {
    if (!session || !isCurrentClient(client) || pending.current === client) return;
    if (importing && !category) return;
    const request = ++sequence.current;
    pending.current = client;
    setResult({ client, sample: null, busy: true, message: '', error: '' });
    const valid = () => isMounted() && isCurrentClient(client) && request === sequence.current;
    try {
      const sample = importing
        ? await importHyundaiSample(client, category!)
        : await readHyundaiSample(client);
      if (!valid()) return;
      setResult({
        client,
        sample,
        busy: false,
        error: '',
        message: importing
          ? '내 계정에 샘플 차량과 누적거리를 저장했어요. 아래의 계정 차량 불러오기로 확인할 수 있어요.'
          : '내 계정에 저장된 샘플을 불러왔어요.',
      });
    } catch (cause) {
      if (!valid()) return;
      const code = cause instanceof BackendError ? cause.status : 0;
      setResult({
        client,
        sample: null,
        busy: false,
        message: code === 404 ? '아직 이 계정에 저장한 현대 샘플이 없어요.' : '',
        error:
          code === 404
            ? ''
            : code === 401
              ? '로그인이 만료됐어요. 설정에서 다시 로그인해 주세요.'
              : code === 503
                ? '현대 샘플 연결이 준비되지 않았어요. 서버 설정 또는 샘플 인증 상태를 확인해 주세요.'
                : code === 409
                  ? '계정에 등록된 차량이 3대인지 확인해 주세요. 샘플도 차량 한 대로 저장돼요.'
                  : '현대 샘플을 불러오지 못했어요. 연결 상태를 확인하고 다시 시도해 주세요.',
      });
    } finally {
      if (pending.current === client && request === sequence.current) pending.current = null;
    }
  }

  return (
    <Card style={shared.stack}>
      <SectionTitle title="현대 샘플 차량" />
      <Text style={shared.muted}>
        현대 Sample API의 누적거리를 내 계정에 저장해요. 실제 차량 연동이 아니며 차종·배터리·경고
        정보는 제공하지 않아요. 다시 가져오면 같은 샘플 차량의 저장 상태를 갱신해요.
      </Text>
      <Text style={shared.text}>앱에서 사용할 차량 분류 선택</Text>
      <Text style={shared.muted}>선택한 분류는 앱 체험용 설정이며 현대에서 조회한 정보가 아니에요.</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {categories.map(({ value, label }) => (
          <Chip
            key={value}
            label={label}
            selected={category === value}
            onPress={busy ? undefined : () => setCategory(value)}
          />
        ))}
      </View>
      <Button
        title="현대 샘플 가져와 계정에 저장"
        onPress={() => load(true)}
        disabled={!session || busy || !category}
        loading={busy}
      />
      <Button
        title="저장된 현대 샘플 조회"
        onPress={() => load(false)}
        disabled={!session || busy}
        variant="secondary"
      />
      {current?.error ? <Notice title={current.error} tone="error" /> : null}
      {current?.message ? <Notice title={current.message} /> : null}
      {current?.sample && (
        <View style={shared.stack}>
          <Chip label="현대 샘플 데이터 · 실제 차량 아님" />
          <Text style={shared.text}>{current.sample.vehicle.name}</Text>
          <Text style={shared.text}>
            샘플 누적거리 {current.sample.status.odometer_km.toLocaleString('ko-KR')} km
          </Text>
          <Text style={shared.muted}>
            서버 수신: {new Date(current.sample.status.received_at).toLocaleString('ko-KR')}
          </Text>
          <Text style={shared.muted}>
            {current.sample.status.observed_at
              ? `관측 시각: ${new Date(current.sample.status.observed_at).toLocaleString('ko-KR')}`
              : '원천 관측 시각의 시간대는 확인되지 않았어요. 현재 차량 상태를 뜻하지 않아요.'}
          </Text>
        </View>
      )}
    </Card>
  );
}

export default function HyundaiSampleVehicle() {
  const { url, session } = useBackend();
  if (!session) return null;
  return <SampleContent key={`${url}:${session.user.id}:${session.expires_at}`} />;
}
