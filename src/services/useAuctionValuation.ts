import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Vehicle } from '../domain/types';
import { useApp } from '../state/AppProvider';
import { useBackend } from '../state/BackendProvider';
import { backendMessage } from './backend';
import { requestAuction, type AuctionResult } from './onbidValuation';
import {
  auctionVehicleKey,
  readAuctionCache,
  subscribeAuctionCache,
  writeAuctionCache,
  type AuctionAnalysisInput,
} from './auctionCache';
export type { AuctionAnalysisInput, AuctionCacheEntry } from './auctionCache';

export function useAuctionValuation(vehicle?: Vehicle) {
  const { state } = useApp();
  const { client, session, isCurrentClient } = useBackend();
  const key = auctionVehicleKey(vehicle, state.demoMode);
  const current = useRef({ key, client, pending: false });
  const generation = useRef(0);
  const [requestState, setRequestState] = useState({ key, client, busy: false, error: '' });
  const sameScope = requestState.key === key && requestState.client === client;
  const busy = sameScope && requestState.busy;
  const error = sameScope ? requestState.error : '';
  useLayoutEffect(() => {
    current.current = { key, client, pending: false };
    generation.current += 1;
    return () => {
      generation.current += 1;
    };
  }, [key, client]);
  const cached = useSyncExternalStore(
    subscribeAuctionCache,
    useCallback(() => (session ? readAuctionCache(client, key) : null), [client, key, session]),
    () => null,
  );
  const remember = useCallback(
    (result: AuctionResult, input: AuctionAnalysisInput) => {
      if (
        !vehicle ||
        !isCurrentClient(client) ||
        current.current.key !== key ||
        current.current.client !== client
      )
        return;
      writeAuctionCache(client, key, {
        result,
        input,
        createdAt: new Date().toISOString(),
        demoInput: state.demoMode,
      });
    },
    [client, isCurrentClient, key, state.demoMode, vehicle],
  );
  async function analyze(input: AuctionAnalysisInput, useLlm = false) {
    if (!session || !vehicle || current.current.pending) return null;
    current.current.pending = true;
    const sequence = ++generation.current;
    setRequestState({ key, client, busy: true, error: '' });
    try {
      const result = await requestAuction(client, { ...input, use_llm: useLlm });
      if (sequence !== generation.current || !isCurrentClient(client)) return null;
      remember(result, input);
      return result;
    } catch (cause) {
      if (sequence === generation.current && isCurrentClient(client))
        setRequestState({ key, client, busy: false, error: backendMessage(cause) });
      return null;
    } finally {
      if (sequence === generation.current) {
        current.current.pending = false;
        setRequestState((previous) => ({ ...previous, busy: false }));
      }
    }
  }
  return {
    cached,
    busy,
    error,
    analyze,
    remember,
    clearError: () => setRequestState((previous) => ({ ...previous, error: '' })),
  };
}
