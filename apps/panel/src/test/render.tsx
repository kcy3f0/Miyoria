import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { ConnectionProvider } from "../app/connection";
import { EventStore, EventStoreContext } from "../app/events-store";
import { createQueryClient } from "../app/queries";
import { ToastProvider } from "../components/toast";

export type Handler = (method: string, url: URL, body: unknown) => { status?: number; body?: unknown; text?: string } | undefined;

/** Stubs `fetch` with a router-like handler; unknown routes answer like the Core's fallback. */
export function mockFetch(handler: Handler) {
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://panel.test");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const res = handler(init?.method ?? "GET", url, body) ?? { status: 404, body: { error: "no such endpoint" } };
    const text = res.text ?? (res.body === undefined ? "" : JSON.stringify(res.body));
    const status = res.status ?? 200;
    return new Response(status === 204 ? null : text, { status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Renders `ui` inside every provider a page needs, at a memory route. */
export function renderPage(ui: ReactNode, opts: { store?: EventStore } = {}) {
  const store = opts.store ?? new EventStore(0);
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, refetchInterval: false, staleTime: Infinity } });
  const root = createRootRoute({ component: () => <Outlet /> });
  const route = createRoute({ getParentRoute: () => root, path: "/", component: () => <>{ui}</> });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  const utils = render(
    <ConnectionProvider initial={{ baseUrl: "", token: "t0ken" }}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <EventStoreContext.Provider value={store}>
            <RouterProvider router={router as never} />
          </EventStoreContext.Provider>
        </ToastProvider>
      </QueryClientProvider>
    </ConnectionProvider>,
  );
  return { ...utils, store, queryClient };
}
