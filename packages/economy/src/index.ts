// Coins (docs/design/economy.md): the `economy` module and the shapes the panel, the overlay and
// the Discord commands share.

export { DEFAULT_FRAMES, type EconomyConfig, EconomyConfigSchema, type Frame } from "./config.js";
export { DealDesk, DealRefusal } from "./deals.js";
export {
  ALREADY_CHECKED_IN,
  EconomyService,
  feedLabel,
  HUNGER_OF,
  hungerWord,
  MAX_FEED_COUNT,
  MAX_LETTER_CHARS,
  STRANGER,
  WALLET_NODE,
} from "./economy.js";
export { EconomyModule } from "./module.js";
export {
  type CheckinResult,
  type DealView,
  type EarnLine,
  type EarnReason,
  type Economy,
  EconomyError,
  EconomyKey,
  FEED_ITEMS,
  type FeedItem,
  type FeedResult,
  type FramesResult,
  GIFT_EXPRESSIONS,
  GIFT_TOPIC,
  type GiftEvent,
  type GiftExpression,
  type GiftItem,
  type Hunger,
  type LedgerLine,
  type ShopItem,
  type SpendResult,
  type WalletExport,
  type WalletView,
} from "./types.js";
