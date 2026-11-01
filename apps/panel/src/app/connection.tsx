import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { type Api, createApi } from "../api/endpoints";
import { ApiClient, type ApiConfig } from "../api/http";
import { readStorage, writeStorage } from "../lib/storage";

export const STORAGE_TOKEN = "miyoria.panel.token";
export const STORAGE_BASE_URL = "miyoria.panel.baseUrl";

export function loadConfig(): ApiConfig {
  return {
    baseUrl: readStorage(STORAGE_BASE_URL) ?? "",
    token: readStorage(STORAGE_TOKEN) ?? "",
  };
}

interface ConnectionValue {
  config: ApiConfig;
  client: ApiClient;
  api: Api;
  setConfig: (next: ApiConfig) => void;
  signOut: () => void;
}

const ConnectionContext = createContext<ConnectionValue | null>(null);

export function ConnectionProvider({ children, initial }: { children: ReactNode; initial?: ApiConfig }) {
  const [config, setState] = useState<ApiConfig>(() => initial ?? loadConfig());

  const setConfig = useCallback((next: ApiConfig) => {
    const clean = { baseUrl: next.baseUrl.trim().replace(/\/+$/, ""), token: next.token.trim() };
    writeStorage(STORAGE_BASE_URL, clean.baseUrl || null);
    writeStorage(STORAGE_TOKEN, clean.token || null);
    setState(clean);
  }, []);

  const signOut = useCallback(() => {
    writeStorage(STORAGE_TOKEN, null);
    setState((c) => ({ ...c, token: "" }));
  }, []);

  const value = useMemo<ConnectionValue>(() => {
    const client = new ApiClient(config);
    return { config, client, api: createApi(client), setConfig, signOut };
  }, [config, setConfig, signOut]);

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection(): ConnectionValue {
  const v = useContext(ConnectionContext);
  if (!v) throw new Error("useConnection outside ConnectionProvider");
  return v;
}

export const useApi = (): Api => useConnection().api;
