import {
  Activity,
  Clapperboard,
  Gauge,
  HeartPulse,
  type LucideIcon,
  Server,
  Settings,
  ShieldCheck,
  UserRound,
} from "lucide-react";

export type NavPath =
  | "/"
  | "/activity"
  | "/live"
  | "/character"
  | "/inner"
  | "/system"
  | "/access"
  | "/settings";

export interface NavItem {
  to: NavPath;
  label: string;
  icon: LucideIcon;
  /** Tabs of the page, for the command palette. */
  tabs?: { tab: string; label: string }[];
}

export const ACTIVITY_TABS = [
  { tab: "events", label: "事件" },
  { tab: "decisions", label: "決策" },
  { tab: "transcript", label: "轉錄" },
] as const;

export const CHARACTER_TABS = [
  { tab: "persona", label: "Persona" },
  { tab: "memory", label: "記憶" },
  { tab: "people", label: "人" },
] as const;

export const INNER_TABS = [
  { tab: "state", label: "狀態" },
  { tab: "feelings", label: "感情" },
  { tab: "world", label: "世界" },
] as const;

export const SYSTEM_TABS = [
  { tab: "modules", label: "子系統" },
  { tab: "extensions", label: "擴充套件" },
  { tab: "mcp", label: "MCP" },
] as const;

export type ActivityTab = (typeof ACTIVITY_TABS)[number]["tab"];
export type CharacterTab = (typeof CHARACTER_TABS)[number]["tab"];
export type SystemTab = (typeof SYSTEM_TABS)[number]["tab"];
export type InnerTab = (typeof INNER_TABS)[number]["tab"];

export const NAV: NavItem[] = [
  { to: "/", label: "總覽", icon: Gauge },
  { to: "/activity", label: "動態", icon: Activity, tabs: [...ACTIVITY_TABS] },
  { to: "/live", label: "直播", icon: Clapperboard },
  { to: "/character", label: "角色", icon: UserRound, tabs: [...CHARACTER_TABS] },
  { to: "/inner", label: "內心", icon: HeartPulse, tabs: [...INNER_TABS] },
  { to: "/system", label: "系統", icon: Server, tabs: [...SYSTEM_TABS] },
  { to: "/access", label: "權限", icon: ShieldCheck },
  { to: "/settings", label: "設定", icon: Settings },
];

export function titleFor(path: string): string {
  const item = NAV.find((i) => (i.to === "/" ? path === "/" : path === i.to || path.startsWith(`${i.to}/`)));
  return item?.label ?? "Miyoria";
}

/** Narrows a search param to one of `values`, else `undefined`. */
export function oneOf<T extends string>(values: readonly { tab: T }[], v: unknown): T | undefined {
  return values.some((x) => x.tab === v) ? (v as T) : undefined;
}
