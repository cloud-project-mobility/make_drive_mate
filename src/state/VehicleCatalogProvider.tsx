import React, { createContext, useContext, useEffect, useState } from 'react';
import { bundledCatalog, type VehicleCatalogEntry } from '../domain/vehicleCatalog';
import type { BackendClient } from '../services/backend';
import { fetchVehicleCatalog } from '../services/vehicleCatalog';
import { useBackend } from './BackendProvider';

interface VehicleCatalogContextValue {
  entries: VehicleCatalogEntry[];
  source: 'bundled' | 'server';
  loading: boolean;
  error: string;
  backendUrl: string;
}

interface CatalogResult {
  client: BackendClient;
  entries: VehicleCatalogEntry[];
  source: 'bundled' | 'server';
  loading: boolean;
  error: string;
}

const Context = createContext<VehicleCatalogContextValue | null>(null);

export function VehicleCatalogProvider({ children }: { children: React.ReactNode }) {
  const { client, url } = useBackend();
  const [result, setResult] = useState<CatalogResult | null>(null);

  useEffect(() => {
    let active = true;
    void fetchVehicleCatalog(client).then(
      (entries) => {
        if (active) setResult({ client, entries, source: 'server', loading: false, error: '' });
      },
      () => {
        if (active)
          setResult({
            client,
            entries: bundledCatalog,
            source: 'bundled',
            loading: false,
            error:
              '서버 차량 목록을 불러오지 못했어요. 기본 목록을 표시해요. 서버 연결을 확인해 주세요.',
          });
      },
    );
    return () => {
      active = false;
    };
  }, [client]);

  // Server changes immediately hide the previous server's entries, before effects run.
  const current = result?.client === client ? result : null;
  return (
    <Context.Provider
      value={{
        entries: current?.entries ?? bundledCatalog,
        source: current?.source ?? 'bundled',
        loading: current?.loading ?? true,
        error: current?.error ?? '',
        backendUrl: url,
      }}
    >
      {children}
    </Context.Provider>
  );
}

export function useVehicleCatalog() {
  const value = useContext(Context);
  if (!value) throw new Error('useVehicleCatalog must be used within VehicleCatalogProvider');
  return value;
}
