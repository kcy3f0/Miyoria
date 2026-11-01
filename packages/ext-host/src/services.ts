import { type ProfileId, type ServiceKey, serviceKey } from "@miyoria/types";

// The active profile id (Rust `services().get::<ProfileId>()`), provided by the app. It has no
// key in `@miyoria/types` yet; until it moves there, every package that needs it shares one key
// object through this global slot (keys are matched by identity).
const SLOT = Symbol.for("miyoria.service-key.ProfileId");
const globals = globalThis as { [SLOT]?: ServiceKey<ProfileId> };

if (!globals[SLOT]) globals[SLOT] = serviceKey<ProfileId>("ProfileId");

/** Service: the active profile id (`"default"` where a fallback makes sense). */
export const ProfileIdKey: ServiceKey<ProfileId> = globals[SLOT];
