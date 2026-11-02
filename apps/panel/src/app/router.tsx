import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  type RouterHistory,
} from "@tanstack/react-router";
import { AccessPage } from "@/pages/access/AccessPage";
import { ActivityPage } from "@/pages/activity/ActivityPage";
import { CharacterPage } from "@/pages/character/CharacterPage";
import { DataPage } from "@/pages/data/DataPage";
import { InnerPage } from "@/pages/inner/InnerPage";
import { LivePage } from "@/pages/live/LivePage";
import { NotFoundPage } from "@/pages/NotFound";
import { OverviewPage } from "@/pages/overview/OverviewPage";
import { SettingsPage } from "@/pages/settings/SettingsPage";
import { SystemPage } from "@/pages/system/SystemPage";
import {
  ACTIVITY_TABS,
  type ActivityTab,
  CHARACTER_TABS,
  type CharacterTab,
  INNER_TABS,
  type InnerTab,
  oneOf,
  SYSTEM_TABS,
  type SystemTab,
} from "./nav";
import { Shell } from "./Shell";

const rootRoute = createRootRoute({ component: Shell, notFoundComponent: NotFoundPage });

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);

export const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/activity",
  validateSearch: (s: Record<string, unknown>): { tab?: ActivityTab } => ({ tab: oneOf(ACTIVITY_TABS, s.tab) }),
  component: ActivityPage,
});

export const characterRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/character",
  validateSearch: (s: Record<string, unknown>): { tab?: CharacterTab; person?: string } => ({
    tab: oneOf(CHARACTER_TABS, s.tab),
    person: str(s.person),
  }),
  component: CharacterPage,
});

export const innerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inner",
  validateSearch: (s: Record<string, unknown>): { tab?: InnerTab } => ({ tab: oneOf(INNER_TABS, s.tab) }),
  component: InnerPage,
});

export const systemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/system",
  validateSearch: (s: Record<string, unknown>): { tab?: SystemTab; q?: string } => ({
    tab: oneOf(SYSTEM_TABS, s.tab),
    q: str(s.q),
  }),
  component: SystemPage,
});

/** Old bookmarks (one page per feature) land on the merged pages. */
const moved = (path: string, to: string, search: Record<string, string> = {}) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path,
    beforeLoad: () => {
      throw redirect({ to, search } as never);
    },
  });

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: OverviewPage }),
  activityRoute,
  createRoute({ getParentRoute: () => rootRoute, path: "/live", component: LivePage }),
  characterRoute,
  innerRoute,
  systemRoute,
  createRoute({ getParentRoute: () => rootRoute, path: "/access", component: AccessPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/data", component: DataPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage }),
  moved("/events", "/activity", { tab: "events" }),
  moved("/decisions", "/activity", { tab: "decisions" }),
  moved("/voice", "/activity", { tab: "transcript" }),
  moved("/persona", "/character", { tab: "persona" }),
  moved("/memory", "/character", { tab: "memory" }),
  moved("/people", "/character", { tab: "people" }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/people/$personId",
    beforeLoad: ({ params }) => {
      throw redirect({ to: "/character", search: { tab: "people", person: params.personId } });
    },
  }),
  moved("/queue", "/live"),
  moved("/stage", "/live"),
  moved("/modules", "/system", { tab: "modules" }),
  moved("/extensions", "/system", { tab: "extensions" }),
  moved("/mcp", "/system", { tab: "mcp" }),
  moved("/roles", "/access"),
]);

/**
 * Hash history: the Core serves `dist/` as static files, and `#/activity`
 * needs no server-side SPA fallback.
 */
export function createAppRouter(history: RouterHistory = createHashHistory()) {
  return createRouter({ routeTree, history, defaultPreload: false, scrollRestoration: true });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
