import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { LogOut, Menu, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { Logo } from "../components/logo";
import { Button } from "../components/ui";
import { useConnection } from "./connection";
import { useEvents } from "./events-store";
import { NAV, titleFor } from "./nav";
import { useHealth } from "./queries";

function ConnectionStatus() {
  const health = useHealth();
  const { status } = useEvents();
  const { config } = useConnection();
  const host = config.baseUrl ? config.baseUrl.replace(/^https?:\/\//, "") : "同源";

  const coreTone = health.isSuccess ? "ok" : health.isError ? "danger" : "neutral";
  const coreText = health.isSuccess ? `Core ${health.data.version}` : health.isError ? "Core 無回應" : "連線中…";
  const sseTone = status.state === "open" ? "ok" : status.state === "closed" ? "danger" : "warn";
  const sseText =
    status.state === "open"
      ? "事件串流已連線"
      : status.state === "retrying"
        ? `事件串流重連中(${Math.round(status.inMs / 1000)} 秒)`
        : status.state === "connecting"
          ? "事件串流連線中…"
          : `事件串流已關閉${status.error ? `:${status.error}` : ""}`;

  return (
    <div aria-live="polite" style={{ display: "grid", gap: "var(--s-1)" }}>
      <div className="conn" title={host}>
        <span className="dot" data-tone={coreTone} aria-hidden />
        <span className="conn__label">
          {coreText}
          <span className="faint"> · {host}</span>
        </span>
      </div>
      <div className="conn">
        <span className="dot" data-tone={sseTone} aria-hidden />
        <span className="conn__label" title={sseText}>
          {sseText}
        </span>
      </div>
    </div>
  );
}

export function Shell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { signOut } = useConnection();
  const [navOpen, setNavOpen] = useState(false);

  // Close the off-canvas nav after navigating, and on Escape.
  useEffect(() => setNavOpen(false), [pathname]);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setNavOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  useEffect(() => {
    document.title = `${titleFor(pathname)} · Miyoria`;
  }, [pathname]);

  return (
    <div className="shell" data-nav-open={navOpen}>
      <a href="#main" className="visually-hidden">
        跳到主要內容
      </a>
      <aside className="rail" id="rail" aria-label="主選單">
        <div className="rail__brand">
          <Logo className="rail__mark" />
          Miyoria
        </div>
        <nav className="rail__nav">
          {NAV.map((g) => (
            <div className="rail__group" key={g.title}>
              <p className="rail__group-title">{g.title}</p>
              {g.items.map((item) => (
                <Link key={item.to} to={item.to} className="rail__link" activeOptions={{ exact: item.to === "/" }}>
                  <item.icon aria-hidden />
                  {item.label}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="rail__foot">
          <ConnectionStatus />
          <div style={{ display: "flex", gap: "var(--s-1)", marginLeft: "calc(var(--s-2) * -1)" }}>
            <Link to="/settings" className="rail__link" style={{ flex: 1 }}>
              <Settings aria-hidden />
              設定
            </Link>
            <Button variant="ghost" iconOnly icon={LogOut} label="登出(清除 token)" onClick={signOut} />
          </div>
        </div>
      </aside>
      {navOpen && <div className="scrim" onClick={() => setNavOpen(false)} aria-hidden />}
      <div className="main">
        <header className="topbar">
          <Button
            variant="ghost"
            iconOnly
            icon={Menu}
            label="開啟選單"
            aria-expanded={navOpen}
            aria-controls="rail"
            onClick={() => setNavOpen((v) => !v)}
          />
          <span className="topbar__title">{titleFor(pathname)}</span>
        </header>
        <main id="main" tabIndex={-1} style={{ outline: "none" }}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
