// Whether a party game is being played somewhere (docs/design/v4-plan.md §9.1, §7.2): the Floor
// counts a running game as her performing, the same as a song or a game played live, so hosting
// does not run out of her talk budget halfway through a round. A typed key, so the arbiter does
// not depend on the party package.

import type { ContextKey } from "./platform.js";
import { serviceKey } from "./service-key.js";

/** Optional, from the `party` module. */
export interface PartyStatus {
  /** A game runs in `context` (a voice channel, or the text chat of one). */
  playing(context: ContextKey): boolean;
}

export const PartyStatusKey = serviceKey<PartyStatus>("PartyStatus");
