import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Page title and actions. No subtitle: the title and the data carry the page. */
export function PageHeader({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-3">
      <h1 className="min-w-0 text-2xl font-semibold tracking-tight">{title}</h1>
      {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Page({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-8 sm:py-8", className)}>
      {children}
    </div>
  );
}

/** Search, filters and toggles above a table. */
export function Toolbar({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("flex flex-wrap items-center gap-2", className)}>{children}</div>;
}
