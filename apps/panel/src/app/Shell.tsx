import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { LogOut, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { CommandPalette } from "@/app/CommandPalette";
import { Logo } from "@/components/logo";
import { Dot, type Tone } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/misc";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useConnection } from "./connection";
import { useEvents } from "./events-store";
import { NAV, titleFor } from "./nav";
import { useHealth, useMind, useStage, useWorld } from "./queries";
import { READ_ONLY_HINT, useSession } from "./session";

const MOD_KEY = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";

/** One dot for Core + event stream; the tooltip has the details. */
function ConnectionDot() {
  const health = useHealth();
  const { status } = useEvents();
  const { config } = useConnection();
  const { state } = useSidebar();
  const host = config.baseUrl ? config.baseUrl.replace(/^https?:\/\//, "") : window.location.host || "同源";

  const sse =
    status.state === "open"
      ? "事件串流已連線"
      : status.state === "retrying"
        ? `事件串流重連中(${Math.round(status.inMs / 1000)} 秒)`
        : status.state === "connecting"
          ? "事件串流連線中"
          : `事件串流已關閉${status.error ? `:${status.error}` : ""}`;
  const core = health.isSuccess ? `Core ${health.data.version}` : health.isError ? "Core 無回應" : "Core 連線中";

  let tone: Tone = "warning";
  if (health.isError || status.state === "closed") tone = "danger";
  else if (health.isSuccess && status.state === "open") tone = "success";
  const label = tone === "success" ? "已連線" : tone === "danger" ? "連線中斷" : "連線中";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`${label}:${core},${sse}`}
          className="flex h-8 min-w-0 items-center gap-2.5 rounded-md px-2 text-sm text-muted-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <span className="flex size-4 shrink-0 items-center justify-center">
            <Dot tone={tone} pulse={tone === "warning"} />
          </span>
          {state === "expanded" && <span className="truncate">{label}</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" align="end">
        <div className="grid gap-0.5">
          <span>{core}</span>
          <span className="text-muted-foreground">{sse}</span>
          <span className="font-mono text-muted-foreground">{host}</span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function SessionFooter() {
  const value = useSession();
  const { signOut } = useConnection();
  const { state } = useSidebar();
  const user = value?.session.method === "discord" ? value.session.user : null;
  const readOnly = value ? !value.session.permissions.write : false;
  const logout = value?.logout ?? signOut;
  const expanded = state === "expanded";
  return (
    <div className="flex items-center gap-1">
      {user && expanded && (
        <div className="flex min-w-0 flex-1 items-center gap-2 px-2">
          {user.avatar_url ? (
            <img
              src={user.avatar_url}
              alt=""
              width={20}
              height={20}
              referrerPolicy="no-referrer"
              className="size-5 shrink-0 rounded-full"
            />
          ) : (
            <span aria-hidden className="size-5 shrink-0 rounded-full bg-muted" />
          )}
          <span className="truncate text-sm" title={`Discord · ${user.name}`}>
            {user.name}
          </span>
          {readOnly && (
            <Badge variant="outline" title={READ_ONLY_HINT}>
              唯讀
            </Badge>
          )}
        </div>
      )}
      {!user && expanded && <span className="flex-1 truncate px-2 text-sm text-muted-foreground">Admin token</span>}
      <Button
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground"
        aria-label={user ? "登出" : "登出(清除 token)"}
        title={user ? "登出" : "登出(清除 token)"}
        onClick={logout}
      >
        <LogOut />
      </Button>
    </div>
  );
}

/** State worth seeing from anywhere: live on 直播, approvals waiting on 內心. */
function NavHint({ to }: { to: string }) {
  const stage = useStage();
  const world = useWorld();
  const mind = useMind();
  if (to === "/live" && (stage.data?.streaming || world.data?.her.golive === "live")) {
    return (
      <span className="ml-auto flex items-center group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:top-1 group-data-[collapsible=icon]:right-1" title="直播中">
        <Dot tone="danger" pulse className="size-1.5 [&>span]:size-1.5" />
        <span className="sr-only">直播中</span>
      </span>
    );
  }
  const n = mind.data?.pending_approvals ?? 0;
  if (to === "/inner" && n > 0) {
    return (
      <span className="ml-auto rounded-full bg-warning/15 px-1.5 text-[11px] font-medium text-warning tabular-nums group-data-[collapsible=icon]:hidden" title={`${n} 件等待確認`}>
        {n}
      </span>
    );
  }
  return null;
}

/** Shown in the header on every page while her autonomy is stopped. */
function PausedPill() {
  const mind = useMind();
  if (!mind.data?.paused) return null;
  return (
    <Link
      to="/inner"
      search={{ tab: "thoughts" }}
      className="flex h-7 items-center gap-2 rounded-full border border-warning/30 bg-warning/10 px-2.5 text-xs font-medium text-warning outline-none hover:bg-warning/15 focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <Dot tone="warning" />
      自主行動已暫停
    </Link>
  );
}

function AppSidebar({ pathname }: { pathname: string }) {
  const { setOpenMobile } = useSidebar();
  return (
    <Sidebar aria-label="主選單">
      <SidebarHeader>
        <Link
          to="/"
          className="flex h-10 items-center gap-2.5 rounded-md px-2 font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          onClick={() => setOpenMobile(false)}
        >
          <Logo className="size-5 shrink-0 text-brand" />
          <span className="truncate group-data-[collapsible=icon]:hidden">Miyoria</span>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <nav aria-label="頁面">
            <SidebarMenu>
              {NAV.map((item) => {
                const active = item.to === "/" ? pathname === "/" : pathname === item.to || pathname.startsWith(`${item.to}/`);
                return (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild tooltip={item.label}>
                      <Link
                        to={item.to}
                        aria-current={active ? "page" : undefined}
                        onClick={() => setOpenMobile(false)}
                      >
                        <item.icon aria-hidden />
                        <span>{item.label}</span>
                        <NavHint to={item.to} />
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </nav>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border">
        <ConnectionDot />
        <SessionFooter />
      </SidebarFooter>
    </Sidebar>
  );
}

export function Shell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    document.title = `${titleFor(pathname)} · Miyoria`;
  }, [pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <SidebarProvider>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-popover focus:px-3 focus:py-2"
      >
        跳到主要內容
      </a>
      <AppSidebar pathname={pathname} />
      <SidebarInset>
        <header className="sticky top-0 z-10 flex h-12 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/70 sm:px-4">
          <SidebarTrigger />
          <PausedPill />
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="ml-auto flex h-8 w-9 items-center justify-center gap-2 rounded-md border border-input bg-input/20 text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:w-60 sm:justify-start sm:px-2.5"
            aria-label="搜尋與跳轉"
          >
            <Search className="size-4 shrink-0" />
            <span className="hidden sm:inline">搜尋…</span>
            <Kbd className="ml-auto hidden sm:inline-flex">{MOD_KEY} K</Kbd>
          </button>
        </header>
        <main id="main" tabIndex={-1} className="flex-1 outline-none">
          <Outlet />
        </main>
      </SidebarInset>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </SidebarProvider>
  );
}
