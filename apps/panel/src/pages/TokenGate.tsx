import { Eye, EyeOff, LogIn } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { createApi } from "../api/endpoints";
import { ApiClient, type ApiConfig, describeError, isApiError } from "../api/http";
import { useConnection } from "../app/connection";
import { Logo } from "../components/logo";
import { Button, Field } from "../components/ui";

/** Checks the base URL answers and the token is accepted, before saving. */
export async function verifyConnection(config: ApiConfig): Promise<{ ok: true; version: string } | { ok: false; field: "url" | "token"; message: string }> {
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
  className = "login__form",
}: {
  initial: ApiConfig;
  submitLabel: string;
  onSaved?: (version: string) => void;
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
    <form className={className} onSubmit={(e) => void submit(e)} noValidate>
      <Field
        label="API 位址"
        htmlFor={`${id}-url`}
        hint="面板由 Core 提供時留空。要連到別台 Core 才填,例如 http://127.0.0.1:7878。"
        error={error?.field === "url" ? error.message : undefined}
      >
        <input
          id={`${id}-url`}
          className="input"
          type="url"
          inputMode="url"
          autoComplete="url"
          placeholder="同源(留空即可)"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          aria-invalid={error?.field === "url" || undefined}
          aria-describedby={error?.field === "url" ? `${id}-url-error` : `${id}-url-hint`}
        />
      </Field>
      <Field
        label="Admin token"
        htmlFor={`${id}-token`}
        hint="即 miyoria.toml 的 [modules.api] token(通常來自 MIYORIA_API_TOKEN)。"
        error={error?.field === "token" ? error.message : undefined}
      >
        <div style={{ display: "flex", gap: "var(--s-2)" }}>
          <input
            id={`${id}-token`}
            className="input mono"
            type={show ? "text" : "password"}
            autoComplete="current-password"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            aria-invalid={error?.field === "token" || undefined}
            aria-describedby={error?.field === "token" ? `${id}-token-error` : `${id}-token-hint`}
          />
          <Button iconOnly icon={show ? EyeOff : Eye} label={show ? "隱藏 token" : "顯示 token"} onClick={() => setShow((v) => !v)} />
        </div>
      </Field>
      <Button type="submit" variant="primary" icon={LogIn} busy={busy}>
        {busy ? "驗證中…" : submitLabel}
      </Button>
    </form>
  );
}

export function TokenGate({ rejected, onSaved }: { rejected?: boolean; onSaved?: () => void }) {
  const { config } = useConnection();
  return (
    <div className="login">
      <div className="login__box">
        <div className="login__brand">
          <Logo />
          <div>
            <h1 className="login__title">Miyoria 管理面板</h1>
            <p className="muted" style={{ fontSize: "var(--fs-sm)" }}>
              {rejected ? "Token 已失效,請重新輸入。" : "連到正在執行的 Core。"}
            </p>
          </div>
        </div>
        <TokenForm initial={{ baseUrl: config.baseUrl, token: rejected ? "" : config.token }} submitLabel="連線" onSaved={onSaved} />
        <p className="faint" style={{ fontSize: "var(--fs-xs)" }}>
          Token 只存在這個瀏覽器的 localStorage。
        </p>
      </div>
    </div>
  );
}
