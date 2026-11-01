import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { isApiError } from "../api/http";
import { ToastProvider } from "../components/toast";
import { TokenGate } from "../pages/TokenGate";
import { ConnectionProvider, useConnection } from "./connection";
import { EventStreamProvider } from "./events-store";
import { createQueryClient } from "./queries";
import { type AppRouter, createAppRouter } from "./router";

function Authenticated({ router }: { router: AppRouter }) {
  const { config } = useConnection();
  const [rejected, setRejected] = useState(false);
  const onUnauthorized = useRef(() => setRejected(true));

  // Any 401 means the token changed on the Core: ask for a new one.
  const [queryClient] = useState(() =>
    createQueryClient((error) => {
      if (isApiError(error) && error.kind === "unauthorized") onUnauthorized.current();
    }),
  );

  // A new URL or token invalidates everything cached for the old one.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    queryClient.clear();
    setRejected(false);
  }, [config.baseUrl, config.token, queryClient]);

  if (!config.token || rejected) return <TokenGate rejected={rejected} onSaved={() => setRejected(false)} />;

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <EventStreamProvider>
          <RouterProvider router={router} />
        </EventStreamProvider>
      </ToastProvider>
    </QueryClientProvider>
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
