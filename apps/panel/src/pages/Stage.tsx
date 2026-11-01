import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Clapperboard, MessageSquareText, Smile } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { describeError } from "../api/http";
import type { StageLink, StageState } from "../api/planned-types";
import { useApi } from "../app/connection";
import { queryKeys, useStage } from "../app/queries";
import { QueryView } from "../components/states";
import { useToast } from "../components/toast";
import { Badge, Button, EmptyState, Field, PageHeader, Panel, SkeletonRows } from "../components/ui";

const EMOTIONS = ["neutral", "happy", "angry", "sad", "surprised", "embarrassed"];

function LinkStatus({ name, link }: { name: string; link: StageLink }) {
  return (
    <div className="row">
      <div className="row__main">
        <div className="row__title">{name}</div>
        {link.error && <div className="row__meta" style={{ color: "var(--c-danger)" }}>{link.error}</div>}
      </div>
      <Badge tone={link.connected ? "ok" : "danger"} dot>
        {link.connected ? "已連線" : "未連線"}
      </Badge>
    </div>
  );
}

function SayForm({ disabled }: { disabled: boolean }) {
  const api = useApi();
  const toast = useToast();
  const id = useId();
  const [text, setText] = useState("");
  const [emotion, setEmotion] = useState("neutral");
  const say = useMutation({
    mutationFn: () => api.stageSay({ text: text.trim(), emotion: emotion === "neutral" ? undefined : emotion }),
    onSuccess: () => {
      toast("ok", "已送出,她馬上開口");
      setText("");
    },
    onError: (e) => toast("danger", describeError(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim()) say.mutate();
  };
  return (
    <form className="form-grid" style={{ maxWidth: "none" }} onSubmit={submit}>
      <Field label="台詞" htmlFor={`${id}-t`} hint="直接走 TTS 與嘴型,不經過 LLM。">
        <textarea id={`${id}-t`} className="textarea" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="哼,才不是特地為你唱的。" />
      </Field>
      <Field label="情緒" htmlFor={`${id}-e`}>
        <select id={`${id}-e`} className="select" value={emotion} onChange={(e) => setEmotion(e.target.value)}>
          {EMOTIONS.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      </Field>
      <Button writes type="submit" variant="primary" icon={MessageSquareText} disabled={disabled || !text.trim()} busy={say.isPending}>
        說這句話
      </Button>
    </form>
  );
}

function StageBody({ s }: { s: StageState }) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const set = (st: StageState) => qc.setQueryData(queryKeys.stage, st);
  const scene = useMutation({ mutationFn: (name: string) => api.stageScene(name), onSuccess: set, onError: (e) => toast("danger", describeError(e)) });
  const expr = useMutation({ mutationFn: (name: string) => api.stageExpression(name), onSuccess: set, onError: (e) => toast("danger", describeError(e)) });

  return (
    <div className="grid-main-side">
      <div className="stack">
        <Panel title="場景" titleId="stage-scenes" actions={s.speaking && <Badge tone="accent" dot pulse>說話中</Badge>}>
          {s.scenes.length === 0 ? (
            <p className="faint">OBS 沒有回報任何場景。</p>
          ) : (
            <div className="chips" role="group" aria-label="切換場景">
              {s.scenes.map((name) => (
                <Button
                  writes
                  key={name}
                  size="sm"
                  variant={name === s.scene ? "primary" : "default"}
                  aria-pressed={name === s.scene}
                  disabled={!s.obs.connected}
                  busy={scene.isPending && scene.variables === name}
                  onClick={() => scene.mutate(name)}
                >
                  {name}
                </Button>
              ))}
            </div>
          )}
        </Panel>
        <Panel title={<><Smile aria-hidden size={16} />表情測試</>} titleId="stage-expr">
          {s.expressions.length === 0 ? (
            <p className="faint">VTube Studio 沒有回報任何表情。</p>
          ) : (
            <div className="chips" role="group" aria-label="觸發表情">
              {s.expressions.map((name) => (
                <Button
                  writes
                  key={name}
                  size="sm"
                  variant={name === s.expression ? "primary" : "default"}
                  aria-pressed={name === s.expression}
                  disabled={!s.vts.connected}
                  busy={expr.isPending && expr.variables === name}
                  onClick={() => expr.mutate(name)}
                >
                  {name}
                </Button>
              ))}
            </div>
          )}
        </Panel>
        <Panel title="Overlay 預覽" titleId="stage-overlay">
          {s.overlay_url ? (
            <iframe className="overlay-frame" src={s.overlay_url} title="Overlay 預覽" sandbox="allow-scripts allow-same-origin" />
          ) : (
            <p className="faint">Stage 沒有提供 overlay 網址。</p>
          )}
        </Panel>
      </div>
      <div className="stack">
        <Panel title="連線" titleId="stage-links" flush>
          <ul className="rows">
            <li><LinkStatus name="VTube Studio" link={s.vts} /></li>
            <li><LinkStatus name="OBS" link={s.obs} /></li>
          </ul>
        </Panel>
        <Panel title="說這句話" titleId="stage-say">
          <SayForm disabled={false} />
        </Panel>
      </div>
    </div>
  );
}

export function StagePage() {
  const stage = useStage();
  return (
    <div className="page">
      <PageHeader title="直播控制" description="切換 OBS 場景、測試 VTube Studio 表情,或讓她直接說一句話。" />
      <QueryView
        query={stage}
        route="GET /api/stage"
        feature="直播控制"
        framed
        skeleton={<Panel><SkeletonRows count={3} /></Panel>}
        empty={<EmptyState icon={Clapperboard} title="Stage 節點沒有在執行" />}
      >
        {(s) => <StageBody s={s} />}
      </QueryView>
    </div>
  );
}
