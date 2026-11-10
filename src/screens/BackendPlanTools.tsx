import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import { Button, Chip, Notice, shared } from '../components/ui';
import { useBackend } from '../state/BackendProvider';
import GoogleCalendar from './GoogleCalendar';
import {
  backendMessage,
  type Place,
  type ProviderSource,
  type RouteEstimate,
} from '../services/backend';

function BackendRouteSearchContent({
  origin,
  destination,
  arrivalAt,
  walkMinutes,
  bufferMinutes,
  onOrigin,
  onDestination,
  selectionRevision,
  onSelectionChanged,
  onEstimate,
}: {
  origin: string;
  destination: string;
  arrivalAt: string | null;
  walkMinutes: number | null;
  bufferMinutes: number | null;
  onOrigin: (name: string) => void;
  onDestination: (name: string) => void;
  selectionRevision: number;
  onSelectionChanged: (
    kind: 'origin' | 'destination',
    place: Place,
    source: ProviderSource,
  ) => void;
  onEstimate: (estimate: RouteEstimate, origin: Place, destination: Place) => void;
}) {
  const { session, client } = useBackend();
  const [originPlace, setOriginPlace] = useState<Place | null>(null);
  const [destinationPlace, setDestinationPlace] = useState<Place | null>(null);
  const [results, setResults] = useState<{
    kind: 'origin' | 'destination';
    query: string;
    source: ProviderSource;
    places: Place[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [estimate, setEstimate] = useState<RouteEstimate | null>(null);
  const currentInputs = useRef('');
  const inputKey = JSON.stringify([
    origin,
    destination,
    arrivalAt,
    walkMinutes,
    bufferMinutes,
    selectionRevision,
    originPlace && [originPlace.id, originPlace.longitude, originPlace.latitude],
    destinationPlace && [
      destinationPlace.id,
      destinationPlace.longitude,
      destinationPlace.latitude,
    ],
  ]);
  useEffect(() => {
    currentInputs.current = inputKey;
    return () => {
      currentInputs.current = '';
    };
  }, [inputKey]);
  const selectedOrigin = originPlace?.name === origin ? originPlace : null;
  const selectedDestination = destinationPlace?.name === destination ? destinationPlace : null;
  const [estimatedInputs, setEstimatedInputs] = useState('');
  const freshEstimate = estimatedInputs === inputKey ? estimate : null;
  async function search(kind: 'origin' | 'destination') {
    const query = kind === 'origin' ? origin : destination;
    if (query.trim().length < 2) {
      setError('검색할 장소를 2자 이상 입력해 주세요.');
      return;
    }
    setBusy(true);
    setError('');
    setResults(null);
    try {
      const found = await client.places(query);
      setResults({ kind, query, ...found });
    } catch (cause) {
      setError(backendMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function calculate() {
    if (
      !selectedOrigin ||
      !selectedDestination ||
      !arrivalAt ||
      walkMinutes === null ||
      bufferMinutes === null
    ) {
      setError('장소 검색 결과에서 출발지·도착지를 선택하고 도착 시간을 입력해 주세요.');
      return;
    }
    setBusy(true);
    setError('');
    setEstimate(null);
    const startedInputs = inputKey;
    try {
      const next = await client.route(
        selectedOrigin,
        selectedDestination,
        arrivalAt,
        walkMinutes,
        bufferMinutes,
      );
      if (currentInputs.current !== startedInputs)
        throw new Error('검색 중 계획이 변경됐어요. 현재 정보로 다시 계산해 주세요.');
      if (
        !Number.isFinite(next.duration_s) ||
        next.duration_s <= 0 ||
        next.duration_s > 86400 ||
        !Number.isFinite(next.distance_m) ||
        next.distance_m < 0 ||
        next.distance_m > 10_000_000 ||
        !['mock', 'live'].includes(next.source)
      )
        throw new Error('경로 응답의 거리와 시간을 확인할 수 없어요.');
      setEstimate(next);
      setEstimatedInputs(startedInputs);
      onEstimate(next, selectedOrigin, selectedDestination);
    } catch (cause) {
      setError(backendMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={shared.stack}>
      <Text style={shared.text}>서버 장소 검색 · 경로 계산</Text>
      <Text style={shared.muted}>
        예시 모드에서는 서울역·서울시청·강남역의 준비된 구간을 사용해요. 실제 교통은 반영하지
        않아요.
      </Text>
      {!session ? (
        <Button
          title="설정에서 로컬 서버 연결"
          onPress={() => router.push('/(tabs)/settings')}
          variant="secondary"
        />
      ) : (
        <>
          <Button
            title="출발지 검색"
            onPress={() => search('origin')}
            disabled={busy}
            variant="secondary"
          />
          <Button
            title="도착지 검색"
            onPress={() => search('destination')}
            disabled={busy}
            variant="secondary"
          />
          {results && results.query === (results.kind === 'origin' ? origin : destination) && (
            <>
              <Chip label={results.source === 'mock' ? '예시 장소 검색 결과' : '장소 검색 결과'} />
              {!results.places.length && (
                <Text style={shared.muted}>검색 결과가 없어요. 장소 이름을 확인해 주세요.</Text>
              )}
              {results.places.map((place) => (
                <View key={place.id} style={shared.stack}>
                  <Text style={shared.muted}>{place.address}</Text>
                  <Button
                    title={`${results.kind === 'origin' ? '출발지' : '도착지'}로 ${place.name} 선택`}
                    onPress={() => {
                      if (results.kind === 'origin') {
                        setOriginPlace(place);
                        onOrigin(place.name);
                      } else {
                        setDestinationPlace(place);
                        onDestination(place.name);
                      }
                      onSelectionChanged(results.kind, place, results.source);
                      setResults(null);
                      setEstimate(null);
                    }}
                    variant="secondary"
                  />
                </View>
              ))}
            </>
          )}
          {selectedOrigin && <Text style={shared.muted}>선택한 출발지: {selectedOrigin.name}</Text>}
          {selectedDestination && (
            <Text style={shared.muted}>선택한 도착지: {selectedDestination.name}</Text>
          )}
          <Button
            title="서버 경로 시간 적용"
            onPress={calculate}
            loading={busy}
            disabled={!selectedOrigin || !selectedDestination || busy}
            icon="map"
            variant="secondary"
          />
        </>
      )}
      {error ? <Notice title={error} tone="error" /> : null}
      {freshEstimate && (
        <Notice
          title={`${freshEstimate.source === 'mock' ? '예시 경로' : '경로 조회'} · ${(freshEstimate.distance_m / 1000).toFixed(1)} km · ${Math.ceil(freshEstimate.duration_s / 60)}분`}
          body={`운전 시간에 적용했어요. ${new Date(freshEstimate.computed_at).toLocaleTimeString('ko-KR')} 계산 · 갱신이 필요하면 다시 계산해 주세요.`}
        />
      )}
    </View>
  );
}

/** Account-scoped result lists and pending requests cannot survive logout or server changes. */
export function CalendarImport(props: React.ComponentProps<typeof GoogleCalendar>) {
  return <GoogleCalendar {...props} />;
}
export function BackendRouteSearch(props: React.ComponentProps<typeof BackendRouteSearchContent>) {
  const { url, session } = useBackend();
  return (
    <BackendRouteSearchContent
      key={`${url}:${session?.user.id ?? 'anonymous'}:${session?.expires_at ?? ''}`}
      {...props}
    />
  );
}
