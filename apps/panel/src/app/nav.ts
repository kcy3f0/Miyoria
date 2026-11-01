import {
  Activity,
  AudioLines,
  Boxes,
  Brain,
  Clapperboard,
  Gauge,
  ListOrdered,
  type LucideIcon,
  Plug,
  Puzzle,
  ScrollText,
  ShieldCheck,
  Split,
  Users,
} from "lucide-react";

export type NavPath =
  | "/"
  | "/events"
  | "/decisions"
  | "/voice"
  | "/persona"
  | "/memory"
  | "/people"
  | "/queue"
  | "/stage"
  | "/modules"
  | "/extensions"
  | "/mcp"
  | "/roles";

export interface NavItem {
  to: NavPath;
  label: string;
  icon: LucideIcon;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    title: "監控",
    items: [
      { to: "/", label: "總覽", icon: Gauge },
      { to: "/events", label: "即時事件", icon: Activity },
      { to: "/decisions", label: "決策追蹤", icon: Split },
      { to: "/voice", label: "語音監控", icon: AudioLines },
    ],
  },
  {
    title: "角色",
    items: [
      { to: "/persona", label: "Persona", icon: ScrollText },
      { to: "/memory", label: "記憶", icon: Brain },
      { to: "/people", label: "人與關係", icon: Users },
    ],
  },
  {
    title: "直播",
    items: [
      { to: "/queue", label: "請求佇列", icon: ListOrdered },
      { to: "/stage", label: "直播控制", icon: Clapperboard },
    ],
  },
  {
    title: "系統",
    items: [
      { to: "/modules", label: "子系統", icon: Boxes },
      { to: "/extensions", label: "擴充套件", icon: Puzzle },
      { to: "/mcp", label: "MCP 伺服器", icon: Plug },
      { to: "/roles", label: "權限", icon: ShieldCheck },
    ],
  },
];

export function titleFor(path: string): string {
  for (const g of NAV) {
    for (const i of g.items) {
      if (i.to === "/" ? path === "/" : path === i.to || path.startsWith(`${i.to}/`)) return i.label;
    }
  }
  if (path.startsWith("/settings")) return "設定";
  return "Miyoria";
}
