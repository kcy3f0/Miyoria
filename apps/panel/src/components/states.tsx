import type { UseQueryResult } from "@tanstack/react-query";
import { CircleAlert, Construction, KeyRound, RefreshCw, WifiOff } from "lucide-react";
import type { ReactNode } from "react";
import { describeError, isApiError } from "../api/http";
import { Button, EmptyState, SkeletonRows } from "./ui";

/** The route exists in the panel's plan but not on this Core. */
export function NotProvided({ route, feature, compact }: { route: string; feature?: string; compact?: boolean }) {
  return (
    <EmptyState icon={Construction} title="尚未提供(core 版本較舊)" compact={compact}>
      <p>
        {feature ? `${feature}需要較新的 Core。` : "這個功能需要較新的 Core。"}
        升級 Core 後重新整理即可使用,版面會照著實際資料出現。
      </p>
      <p style={{ marginTop: "var(--s-2)" }}>
        <code className="state__route">{route}</code>
      </p>
    </EmptyState>
  );
}

export function ErrorState({ error, onRetry, compact }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  const kind = isApiError(error) ? error.kind : "http";
  const icon = kind === "network" ? WifiOff : kind === "unauthorized" ? KeyRound : CircleAlert;
  const title =
    kind === "network"
      ? "連不上 Core"
      : kind === "unauthorized"
        ? "Token 被拒絕"
        : kind === "unavailable"
          ? "服務未啟動"
          : "讀取失敗";
  return (
    <div role="alert">
      <EmptyState
        icon={icon}
        tone="danger"
        title={title}
        compact={compact}
        actions={
          onRetry && (
            <Button size="sm" icon={RefreshCw} onClick={onRetry}>
              重試
            </Button>
          )
        }
      >
        {describeError(error)}
      </EmptyState>
    </div>
  );
}

/**
 * Renders the four states of a query in one place: skeleton, not provided,
 * error with retry, empty, then the data.
 */
export function QueryView<T>({
  query,
  route,
  feature,
  isEmpty,
  empty,
  skeleton,
  compact,
  framed,
  children,
}: {
  query: UseQueryResult<T>;
  /** Draw the non-data states inside a panel (for pages whose data renders its own panels). */
  framed?: boolean;
  /** Shown in the "not provided" state. */
  route: string;
  feature?: string;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  skeleton?: ReactNode;
  compact?: boolean;
  children: (data: T) => ReactNode;
}) {
  const frame = (node: ReactNode) => (framed ? <div className="panel">{node}</div> : node);
  if (query.isPending) return <>{skeleton ?? frame(<SkeletonRows />)}</>;
  if (query.isError) {
    if (isApiError(query.error) && query.error.kind === "not_provided") {
      return frame(<NotProvided route={route} feature={feature} compact={compact} />);
    }
    return frame(<ErrorState error={query.error} onRetry={() => void query.refetch()} compact={compact} />);
  }
  if (isEmpty?.(query.data) && empty) return <>{empty}</>;
  return <>{children(query.data)}</>;
}
