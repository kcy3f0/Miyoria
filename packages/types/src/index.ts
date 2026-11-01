// @miyoria/types: shared domain types and the contracts modules use to talk to each other.
//
// Modules never depend on each other's implementations. They exchange the data types defined
// here over the event bus, or call the service interfaces defined here through the kernel's
// service registry (each interface has a `...Key` constant).
//
// Every data type mirrors the legacy Rust serde JSON exactly: snake_case field names,
// `Option<T>` as `T | null` (key always present), timestamps as RFC 3339 strings.

export {
  type Action,
  type ActionPayload,
  type ActionSink,
  ActionSinkKey,
  AVATAR_LANE,
  actionPlatform,
  comparePriority,
  DEFAULT_ACTION_TTL_MS,
  isActionExpired,
  type LaneKey,
  type NewActionOptions,
  newAction,
  PRIORITY_RANK,
  type Priority,
  textLane,
  voiceLane,
} from "./action.js";
export {
  type Authorizer,
  AuthorizerKey,
  accountSubject,
  BaseAuthorizer,
  type Subject,
} from "./auth.js";
export {
  customEvent,
  type DecisionTrace,
  type Envelope,
  type EnvelopeOptions,
  EVENT_TOPICS,
  type Event,
  type EventData,
  type EventOf,
  type EventType,
  envelopeTopic,
  eventTopic,
  isEvent,
  KERNEL_MODULE,
  type ModuleStateKind,
  newEnvelope,
} from "./event.js";
export {
  type ActionId,
  type EventId,
  isUlid,
  type ModuleId,
  newId,
  type PersonId,
  type PlatformId,
  type ProfileId,
  ProfileIdKey,
  type TurnId,
} from "./ids.js";
export { isJsonObject, type JsonObject, type JsonPrimitive, type JsonValue } from "./json.js";
export {
  type AccountRef,
  type Attachment,
  type Author,
  accountRefString,
  type ContextKey,
  type ContextKind,
  contextKeyEquals,
  contextKeyString,
  type IncomingMessage,
  type MessageRef,
  type OutgoingMessage,
  type PlatformSink,
  PlatformSinks,
  PlatformSinksKey,
  sameAccount,
} from "./platform.js";
export {
  type Participant,
  type PromptContributor,
  PromptContributors,
  PromptContributorsKey,
  type PromptRequest,
  type PromptSection,
} from "./prompt.js";
export { ServiceKey, serviceKey } from "./service-key.js";
export {
  type Attitude,
  type Followup,
  type FollowupSource,
  FollowupSourceKey,
  type Mood,
  type MoodSignals,
  MoodSignalsKey,
  type SocialSignals,
  SocialSignalsKey,
} from "./social.js";
export { type Clock, systemClock, type Timestamp, timestampMs, toTimestamp } from "./time.js";
export {
  type PlaybackState,
  type SpeakOutcome,
  type VoiceParticipant,
  type VoiceSink,
  VoiceSinkKey,
  type VoiceUtterance,
} from "./voice.js";
