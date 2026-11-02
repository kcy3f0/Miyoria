// Her inner life, read-only: `GET /api/self` (drives, boredom, policy, agenda, mood, feelings)
// and `GET /api/world` (what she perceives). Changes go through her own decisions (and, later,
// the action gate), not through these routes.

import { SocialKey } from "@miyoria/social";
import { PlatformSinksKey, SelfStateKey, WorldStateKey } from "@miyoria/types";
import { json, type Route } from "./route.js";
import type { ApiState } from "./state.js";
import type { FeelingView, SelfView, WorldView } from "./types.js";

function selfView(state: ApiState): SelfView {
  const self = state.service(SelfStateKey, "self module");
  const social = state.optional(SocialKey);
  const feelings: FeelingView[] = self.feelings().map((f) => ({
    ...f,
    display_name: social?.displayName(f.person) ?? null,
  }));
  return { ...self.snapshot(), feelings };
}

async function worldView(state: ApiState): Promise<WorldView> {
  const snapshot = state.service(WorldStateKey, "world module").snapshot();
  const sinks = state.optional(PlatformSinksKey);
  const channels = await Promise.all(
    snapshot.channels.map(async (c) => {
      let label: string | null = null;
      try {
        label = await state.labels.label(sinks, c.context);
      } catch {
        label = null;
      }
      return { ...c, label };
    }),
  );
  return { ...snapshot, channels };
}

export function innerRoutes(state: ApiState): Route[] {
  return [
    { method: "GET", path: "/api/self", handler: () => json(selfView(state)) },
    { method: "GET", path: "/api/world", handler: async () => json(await worldView(state)) },
  ];
}
