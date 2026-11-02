// What runs before her stream ends, so the audience sees the ending scene instead of a cut.

import { serviceKey } from "./service-key.js";

/**
 * Provided by `stage.link` (its scene director). `stream.stop` (Go Live) and `stage.stream`
 * (OBS) call `close` before they stop the stream: it switches OBS to the `ending` scene and
 * resolves after the hold time (at once when there is no ending scene). It never throws.
 */
export interface StreamCurtain {
  close(signal?: AbortSignal): Promise<void>;
}

export const StreamCurtainKey = serviceKey<StreamCurtain>("StreamCurtain");
