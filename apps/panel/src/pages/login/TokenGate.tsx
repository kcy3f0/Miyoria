import { CircleAlert, Eye, EyeOff, LogIn } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { createApi } from "@/api/endpoints";
import { ApiClient, type ApiConfig, describeError, isApiError } from "@/api/http";
import { useConnection } from "@/app/connection";
import { isSameOrigin, loginErrorMessage, loginNext } from "@/app/session";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** Checks the base URL answers and the token is accepted, before saving. */
export async function verifyConnection(
  config: ApiConfig,
): Promise<{ ok: true; version: string } | { ok: false; field: "url" | "token"; message: string }> {
  const api = createApi(new ApiClient(config));
  let version: string;
  try {
    version = (await api.health()).version;
  } catch (e) {
    return { ok: false, field: "url", message: describeError(e) };
  }
  try {
    await api.modules();
  } catch (e) {
    if (isApiError(e) && e.kind === "unauthorized") return { ok: false, field: "token", message: "Core 拒絕了這個 token。" };
    return { ok: false, field: "url", message: describeError(e) };
  }
  return { ok: true, version };
}

export function TokenForm({
  initial,
  submitLabel,
  onSaved,
  secondary = false,
  className,
}: {
  initial: ApiConfig;
  submitLabel: string;
  onSaved?: (version: string) => void;
  /** Another login method is the primary action; this submit button steps back. */
  secondary?: boolean;
  className?: string;
}) {
  const { setConfig } = useConnection();
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [token, setToken] = useState(initial.token);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field: "url" | "token"; message: string } | null>(null);
  const id = useId();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token.trim()) {
      setError({ field: "token", message: "請輸入 token。" });
      return;
    }
    setBusy(true);
    setError(null);
    const next = { baseUrl: baseUrl.trim().replace(/\/+$/, ""), token: token.trim() };
    const res = await verifyConnection(next);
    setBusy(false);
    if (!res.ok) {
      setError({ field: res.field, message: res.message });
      return;
    }
    setConfig(next);
    onSaved?.(res.version);
  };

  return (
    <form className={cn("grid gap-4", className)} onSubmit={(e) => void submit(e)} noValidate>
      <Field label="API 位址" htmlFor={`${id}-url`} error={error?.field === "url" ? error.message : undefined}>
        <Input
          id={`${id}-url`}
          type="url"
          inputMode="url"
          autoComplete="url"
          placeholder="同源"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          aria-invalid={error?.field === "url" || undefined}
          aria-describedby={error?.field === "url" ? `${id}-url-error` : undefined}
        />
      </Field>
      <Field label="Admin token" htmlFor={`${id}-token`} error={error?.field === "token" ? error.message : undefined}>
        <div className="relative">
          <Input
            id={`${id}-token`}
            className="pr-10 font-mono"
            type={show ? "text" : "password"}
            autoComplete="current-password"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            aria-invalid={error?.field === "token" || undefined}
            aria-describedby={error?.field === "token" ? `${id}-token-error` : undefined}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute top-0.5 right-0.5 text-muted-foreground"
            aria-label={show ? "隱藏 token" : "顯示 token"}
            onClick={() => setShow((v) => !v)}
          >
            {show ? <EyeOff /> : <Eye />}
          </Button>
        </div>
      </Field>
      <Button type="submit" variant={secondary ? "outline" : "default"} busy={busy}>
        {busy ? "驗證中…" : submitLabel}
      </Button>
    </form>
  );
}

/** Login screen: Discord (when the Core offers it) above the token form. */
export function TokenGate({
  rejected,
  expired,
  discord = false,
  error,
  onSaved,
}: {
  /** The saved token stopped working. */
  rejected?: boolean;
  /** The Discord session ended (logged out elsewhere, expired or revoked). */
  expired?: boolean;
  /** `GET /api/auth/methods` said Discord login is configured. */
  discord?: boolean;
  /** `?error=` code from a failed Discord login. */
  error?: string | null;
  onSaved?: () => void;
}) {
  const { config, api } = useConnection();
  // The session cookie only reaches a Core on the panel's own origin.
  const showDiscord = discord && isSameOrigin(config.baseUrl);
  const notice = error
    ? loginErrorMessage(error)
    : rejected
      ? "Token 已失效,請重新輸入。"
      : expired
        ? "登入已過期或權限已變更,請重新登入。"
        : null;
  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-4 py-12">
      <div className="grid w-full max-w-sm gap-6">
        <div className="flex items-center gap-3">
          <Logo className="size-7 text-brand" />
          <h1 className="text-xl font-semibold tracking-tight">Miyoria</h1>
        </div>
        {notice && (
          <div
            role="alert"
            className="flex gap-2.5 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm"
          >
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-[oklch(0.74_0.16_25)]" />
            <span>{notice}</span>
          </div>
        )}
        <div className="grid gap-5 rounded-xl border bg-card p-6">
          {showDiscord && (
            <>
              <Button asChild>
                <a href={api.discordLoginUrl(loginNext())}>
                  <LogIn aria-hidden />
                  使用 Discord 登入
                </a>
              </Button>
              <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden>
                <span className="h-px flex-1 bg-border" />
                或
                <span className="h-px flex-1 bg-border" />
              </div>
            </>
          )}
          <TokenForm
            initial={{ baseUrl: config.baseUrl, token: rejected ? "" : config.token }}
            submitLabel={showDiscord ? "用 token 連線" : "連線"}
            secondary={showDiscord}
            onSaved={onSaved}
          />
        </div>
      </div>
    </div>
  );
}
