import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isApiError } from "../api/http";
import type { AuthMethods, SessionInfo } from "../api/types";
import { ToastProvider } from "../components/toast";
import { TokenGate } from "../pages/TokenGate";
import { ConnectionProvider, useConnection } from "./connection";
import { EventStreamProvider } from "./events-store";
import { createQueryClient } from "./queries";
import { type AppRouter, createAppRouter } from "./router";
import { SessionProvider, type SessionValue, TOKEN_SESSION, takeLoginError } from "./session";

type AuthState =
  | { status: "checking" }
  /** `rejected`: the saved token stopped working; `expired`: the Discord session ended. */
  | { status: "signed_out"; reason?: "rejected" | "expired" }
  | { status: "signed_in"; session: SessionInfo };

function Authenticated({ router }: { router: AppRouter }) {
  const { config, api, signOut } = useConnection();
  const [auth, setAuth] = useState<AuthState>({ status: "checking" });
  const [methods, setMethods] = useState<AuthMethods | null>(null);
  const [loginError, setLoginError] = useState<string | null>(() => takeLoginError());
  const [recheck, setRecheck] = useState(0);
  const authRef = useRef(auth);
  authRef.current = auth;

  // Any 401 means the token changed or the session ended: back to the login screen.
  const [queryClient] = useState(() =>
    createQueryClient((error) => {
      if (!isApiError(error) || error.kind !== "unauthorized") return;
      const current = authRef.current;
      if (current.status !== "signed_in") return;
      setAuth({ status: "signed_out", reason: current.session.method === "discord" ? "expired" : "rejected" });
    }),
  );

  // Who are we? Asked on load and whenever the URL or token changes.
  useEffect(() => {
    const ctl = new AbortController();
    const { signal } = ctl;
    setAuth({ status: "checking" });
    void (async () => {
      const [m, s] = await Promise.allSettled([api.authMethods({ signal }), api.session({ signal })]);
      if (signal.aborted) return;
      setMethods(m.status === "fulfilled" ? m.value : null);
      if (s.status === "fulfilled") {
        setAuth({ status: "signed_in", session: s.value });
        return;
      }
      const e: unknown = s.reason;
      const unauthorized = isApiError(e) && e.kind === "unauthorized";
      // A saved token on an older or unreachable Core: carry on as before
      // (the shell shows the Core as unreachable).
      if (config.token && !unauthorized) setAuth({ status: "signed_in", session: TOKEN_SESSION });
      else setAuth({ status: "signed_out", reason: config.token ? "rejected" : undefined });
    })();
    return () => ctl.abort();
  }, [api, config.token, recheck]);

  // A new URL or token invalidates everything cached for the old one.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    queryClient.clear();
  }, [config.baseUrl, config.token, queryClient]);

  const logout = useCallback(() => {
    const method = authRef.current.status === "signed_in" ? authRef.current.session.method : "token";
    queryClient.clear();
    if (method === "discord") {
      void api
        .logout()
        .catch(() => undefined)
        .finally(() => setAuth({ status: "signed_out" }));
    } else {
      signOut();
    }
  }, [api, queryClient, signOut]);

  const sessionValue = useMemo<SessionValue | null>(
    () => (auth.status === "signed_in" ? { session: auth.session, logout } : null),
    [auth, logout],
  );

  if (auth.status === "checking") {
    return <div className="login" aria-busy="true" aria-label="確認登入狀態中" />;
  }

  if (auth.status === "signed_out" || !sessionValue) {
    return (
      <TokenGate
        rejected={auth.status === "signed_out" && auth.reason === "rejected"}
        expired={auth.status === "signed_out" && auth.reason === "expired"}
        discord={methods?.discord ?? false}
        error={loginError}
        onSaved={() => {
          setLoginError(null);
          setRecheck((n) => n + 1);
        }}
      />
    );
  }

  return (
    <SessionProvider value={sessionValue}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <EventStreamProvider>
            <RouterProvider router={router} />
          </EventStreamProvider>
        </ToastProvider>
      </QueryClientProvider>
    </SessionProvider>
  );
}

export function App({ router }: { router?: AppRouter }) {
  const [r] = useState(() => router ?? createAppRouter());
  return (
    <ConnectionProvider>
      <Authenticated router={r} />
    </ConnectionProvider>
  );
}
