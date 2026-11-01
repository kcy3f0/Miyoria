import { Check, Copy } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { Button } from "./ui";

const TOKEN = /("(?:\.|[^"\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/** Splits pretty JSON into tinted spans (keys, strings, numbers, literals). */
export function highlightJson(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const [whole, str, colon, lit, num] = m;
    if (str !== undefined) {
      out.push(
        <span key={i++} className={colon ? "k" : "s"}>
          {str}
        </span>,
      );
      if (colon) out.push(colon);
    } else if (lit !== undefined) {
      out.push(<span key={i++} className="b">{lit}</span>);
    } else if (num !== undefined) {
      out.push(<span key={i++} className="n">{num}</span>);
    }
    last = at + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function JsonView({ value, label = "JSON" }: { value: unknown; label?: string }) {
  const text = useMemo(() => JSON.stringify(value, null, 2) ?? "undefined", [value]);
  const nodes = useMemo(() => highlightJson(text), [text]);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: nothing to do */
    }
  };
  return (
    <div style={{ display: "grid", gap: "var(--s-2)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span className="field__label">{label}</span>
        <Button size="sm" variant="ghost" icon={copied ? Check : Copy} onClick={() => void copy()}>
          {copied ? "已複製" : "複製"}
        </Button>
      </div>
      <pre className="json" tabIndex={0} aria-label={label}>
        {nodes}
      </pre>
    </div>
  );
}
