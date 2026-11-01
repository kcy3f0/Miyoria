import { Activity, Eraser, Pause, Play } from "lucide-react";
import { useMemo, useState } from "react";
import type { Envelope } from "../api/types";
import { EVENT_BUFFER, useEventStore, useEvents } from "../app/events-store";
import { Drawer } from "../components/dialog";
import { EventFeed, useFreshIds } from "../components/EventFeed";
import { JsonView } from "../components/json";
import { Badge, Button, EmptyState, PageHeader, Panel } from "../components/ui";
import { matchesAny, parseTopics, summarize, topicOf } from "../lib/events";
import { fmtDateTime, fmtInt } from "../lib/format";

const PRESETS = ["platform.*", "agent.*", "voice.*", "action.*", "system.*", "llm.*"];

export function EventsPage() {
  const store = useEventStore();
  const { events, status, received } = useEvents();
  const [raw, setRaw] = useState("");
  const [paused, setPaused] = useState<{ events: Envelope[]; received: number } | null>(null);
  const [selected, setSelected] = useState<Envelope | null>(null);

  const topics = useMemo(() => parseTopics(raw), [raw]);
  const source = paused?.events ?? events;
  const visible = useMemo(() => source.filter((e) => matchesAny(topics, topicOf(e.event))), [source, topics]);
  const fresh = useFreshIds(visible);
  const missed = paused ? received - paused.received : 0;

  const togglePreset = (p: string) => {
    const set = new Set(topics);
    if (set.has(p)) set.delete(p);
    else set.add(p);
    setRaw([...set].join(", "));
  };

  return (
    <div className="page">
      <PageHeader
        title="即時事件"
        description={`匯流排上的每一個事件。保留最近 ${EVENT_BUFFER} 則,點一下看完整 JSON。`}
        actions={
          <>
            <Badge tone={status.state === "open" ? "ok" : status.state === "closed" ? "danger" : "warn"} dot pulse={status.state === "open" && !paused}>
              {status.state === "open" ? "已連線" : status.state === "closed" ? "已關閉" : "重連中"}
            </Badge>
            <Button
              icon={paused ? Play : Pause}
              variant={paused ? "primary" : "default"}
              aria-pressed={paused !== null}
              onClick={() => setPaused(paused ? null : { events, received })}
            >
              {paused ? "繼續" : "暫停"}
            </Button>
            <Button
              icon={Eraser}
              variant="ghost"
              onClick={() => {
                store.clear();
                if (paused) setPaused({ events: [], received });
              }}
            >
              清除
            </Button>
          </>
        }
      />

      <div className="toolbar">
        <input
          className="input mono"
          style={{ flex: "1 1 18rem", fontSize: "var(--fs-sm)" }}
          placeholder="主題篩選,例如 agent.*, voice.utterance"
          aria-label="主題篩選(逗號分隔,支援 .* 萬用字元)"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          spellCheck={false}
        />
        <div className="chips" role="group" aria-label="常用主題">
          {PRESETS.map((p) => (
            <Button key={p} size="sm" variant={topics.includes(p) ? "primary" : "default"} aria-pressed={topics.includes(p)} onClick={() => togglePreset(p)}>
              <span className="mono">{p}</span>
            </Button>
          ))}
        </div>
      </div>

      {paused && (
        <div className="notice" data-tone="accent" style={{ marginBottom: "var(--s-3)" }} role="status">
          <Pause aria-hidden />
          <span style={{ flex: 1 }}>
            已暫停。{missed > 0 ? `暫停期間收到 ${fmtInt(missed)} 則新事件。` : "目前沒有新事件。"}
          </span>
        </div>
      )}

      <Panel flush>
        <div style={{ minHeight: "24rem" }}>
          {visible.length === 0 ? (
            <EmptyState icon={Activity} title={events.length === 0 ? (status.state === "open" ? "等待事件中" : "尚未連線") : "沒有符合篩選的事件"}>
              {events.length === 0
                ? status.state === "closed" && status.error
                  ? status.error
                  : "事件串流開著;有動靜就會出現在這裡。"
                : `共 ${events.length} 則事件,沒有一則符合「${topics.join(", ")}」。`}
            </EmptyState>
          ) : (
            <EventFeed events={visible} onSelect={setSelected} freshIds={paused ? undefined : fresh} label="事件列表" />
          )}
        </div>
      </Panel>
      <p className="faint" style={{ fontSize: "var(--fs-xs)", marginTop: "var(--s-2)" }}>
        顯示 {fmtInt(visible.length)} / {fmtInt(source.length)} 則 · 開啟後共收到 {fmtInt(received)} 則
      </p>

      <Drawer open={selected !== null} title={selected ? <span className="mono">{topicOf(selected.event)}</span> : ""} onClose={() => setSelected(null)}>
        {selected && (
          <>
            <p>{summarize(selected).text || <span className="faint">(沒有摘要)</span>}</p>
            <dl className="dl">
              <dt>時間</dt>
              <dd>{fmtDateTime(selected.ts)}</dd>
              <dt>來源</dt>
              <dd className="mono">{selected.source}</dd>
              <dt>事件 id</dt>
              <dd className="mono">{selected.id}</dd>
              <dt>回合</dt>
              <dd className="mono">{selected.correlation ?? "—"}</dd>
              <dt>起因</dt>
              <dd className="mono">{selected.causation ?? "—"}</dd>
            </dl>
            <JsonView value={selected} label="Envelope" />
          </>
        )}
      </Drawer>
    </div>
  );
}
