import { memo, useEffect, useMemo, useRef } from "react";
import type { Envelope } from "../api/types";
import { summarize, topicGroup, topicOf } from "../lib/events";
import { fmtTime } from "../lib/format";

const GROUP_TONE: Record<string, string> = {
  agent: "accent",
  voice: "ok",
  system: "warn",
  action: "neutral",
  platform: "neutral",
  llm: "warn",
};

const Row = memo(function Row({
  env,
  fresh,
  onSelect,
}: {
  env: Envelope;
  fresh: boolean;
  onSelect?: (env: Envelope) => void;
}) {
  const topic = topicOf(env.event);
  const { text, tone } = summarize(env);
  const content = (
    <>
      <time className="feed__time" dateTime={env.ts}>
        {fmtTime(env.ts)}
      </time>
      <span className="feed__topic">
        <span className="dot" data-tone={GROUP_TONE[topicGroup(topic)] ?? "neutral"} aria-hidden />
        {topic}
      </span>
      <span className="feed__text" data-tone={tone}>
        {text || <span className="faint">{env.source}</span>}
      </span>
    </>
  );
  const cls = `feed__item${fresh ? " feed__new" : ""}`;
  if (!onSelect) return <li className={cls}>{content}</li>;
  return (
    <li>
      <button type="button" className={`${cls} feed__item--button`} onClick={() => onSelect(env)}>
        {content}
      </button>
    </li>
  );
});

export function EventFeed({
  events,
  compact,
  onSelect,
  freshIds,
  label,
}: {
  events: Envelope[];
  compact?: boolean;
  onSelect?: (env: Envelope) => void;
  /** Ids rendered with the arrival highlight. */
  freshIds?: Set<string>;
  label: string;
}) {
  return (
    <ul className={compact ? "feed feed--compact" : "feed"} aria-label={label}>
      {events.map((env) => (
        <Row key={env.id} env={env} fresh={freshIds?.has(env.id) ?? false} onSelect={onSelect} />
      ))}
    </ul>
  );
}

/** Ids that arrived since the previous render, for the arrival highlight. */
export function useFreshIds(events: Envelope[]): Set<string> {
  const prevTop = useRef<string | undefined>(undefined);
  const fresh = useMemo(() => {
    const set = new Set<string>();
    if (prevTop.current === undefined) return set;
    for (const e of events) {
      if (e.id === prevTop.current) break;
      set.add(e.id);
    }
    return set;
  }, [events]);
  useEffect(() => {
    prevTop.current = events[0]?.id ?? prevTop.current ?? "";
  }, [events]);
  return fresh;
}
