import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router";
import { DecisionsPage } from "../pages/Decisions";
import { EventsPage } from "../pages/Events";
import { ExtensionsPage } from "../pages/Extensions";
import { McpPage } from "../pages/Mcp";
import { MemoryPage } from "../pages/Memory";
import { ModulesPage } from "../pages/Modules";
import { NotFoundPage } from "../pages/NotFound";
import { OverviewPage } from "../pages/Overview";
import { PeoplePage } from "../pages/People";
import { PersonPage } from "../pages/Person";
import { PersonaPage } from "../pages/Persona";
import { QueuePage } from "../pages/Queue";
import { RolesPage } from "../pages/Roles";
import { SettingsPage } from "../pages/Settings";
import { StagePage } from "../pages/Stage";
import { VoicePage } from "../pages/Voice";
import { Shell } from "./Shell";

const rootRoute = createRootRoute({ component: Shell, notFoundComponent: NotFoundPage });

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: OverviewPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/events", component: EventsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/decisions", component: DecisionsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/voice", component: VoicePage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/persona", component: PersonaPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/memory", component: MemoryPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/people", component: PeoplePage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/people/$personId", component: PersonPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/queue", component: QueuePage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/stage", component: StagePage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/modules", component: ModulesPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/extensions", component: ExtensionsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/mcp", component: McpPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/roles", component: RolesPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage }),
]);

/**
 * Hash history: the Core serves `dist/` as static files, and `#/decisions`
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
