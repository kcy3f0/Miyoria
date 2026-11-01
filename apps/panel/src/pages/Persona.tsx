import { History, RotateCcw, Save, ScrollText, Undo2 } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { describeError } from "../api/http";
import type { PersonaOverride, PersonaSectionInfo } from "../api/types";
import { usePersona, usePersonaHistory, useSetPersona } from "../app/queries";
import { Modal } from "../components/dialog";
import { DiffView } from "../components/DiffView";
import { QueryView } from "../components/states";
import { useToast } from "../components/toast";
import { Badge, Button, EmptyState, PageHeader, Panel, SkeletonRows } from "../components/ui";
import { fmtDateTime, fmtRelative } from "../lib/format";

export const EDITED_BY = "panel";

function HistoryList({
  sectionKey,
  current,
  onRestore,
}: {
  sectionKey: string;
  current: string;
  onRestore: (v: PersonaOverride) => void;
}) {
  const history = usePersonaHistory(sectionKey);
  const [openVersion, setOpenVersion] = useState<number | null>(null);
  return (
    <Panel title={<><History aria-hidden size={16} />版本紀錄</>} titleId="persona-history" flush>
      <QueryView
        query={history}
        route={`GET /api/persona/${sectionKey}/history`}
        compact
        skeleton={<SkeletonRows count={3} />}
        isEmpty={(d) => d.length === 0}
        empty={
          <EmptyState compact title="還沒有修改過">
            目前內容來自 persona 檔案。第一次在這裡儲存後就會開始記錄版本。
          </EmptyState>
        }
      >
        {(list) => {
          const sorted = [...list].sort((a, b) => b.version - a.version);
          const latest = sorted[0]?.version;
          return (
            <ul className="rows">
              {sorted.map((v) => {
                const open = openVersion === v.version;
                const isCurrent = v.version === latest && v.body === current;
                return (
                  <li key={v.version} style={{ borderBottom: "1px solid var(--c-line)" }}>
                    <div className="row" style={{ borderBottom: 0 }}>
                      <div className="row__main">
                        <div className="row__title">
                          <span className="num">v{v.version}</span>
                          {isCurrent && <Badge tone="accent">目前</Badge>}
                        </div>
                        <div className="row__meta">
                          <span title={fmtDateTime(v.edited_at)}>{fmtRelative(v.edited_at)}</span> · {v.edited_by}
                        </div>
                      </div>
                      <div className="inline-actions">
                        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpenVersion(open ? null : v.version)}>
                          {open ? "收起" : "比較"}
                        </Button>
                        {!isCurrent && (
                          <Button size="sm" icon={RotateCcw} onClick={() => onRestore(v)}>
                            還原
                          </Button>
                        )}
                      </div>
                    </div>
                    {open && (
                      <div style={{ padding: "0 var(--s-4) var(--s-4)" }}>
                        <DiffView before={current} after={v.body} label={`目前 → v${v.version}`} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          );
        }}
      </QueryView>
    </Panel>
  );
}

function SectionEditor({
  section,
  draft,
  setDraft,
}: {
  section: PersonaSectionInfo;
  draft: string;
  setDraft: (s: string) => void;
}) {
  const save = useSetPersona();
  const toast = useToast();
  const [reviewing, setReviewing] = useState(false);
  const id = useId();
  const next = draft.trim(); // the server trims before storing
  const dirty = next !== section.body.trim();

  const doSave = () => {
    save.mutate(
      { key: section.key, req: { body: next, edited_by: EDITED_BY } },
      {
        onSuccess: (r) => {
          toast("ok", `已儲存「${r.key}」v${r.version},立即生效。`);
          setReviewing(false);
        },
        onError: (e) => toast("danger", `儲存失敗:${describeError(e)}`),
      },
    );
  };

  return (
    <div className="stack">
      <Panel
        title={<code>{section.key}</code>}
        titleId="persona-editor"
        actions={
          <div className="inline-actions">
            {dirty && <Badge tone="warn">未儲存</Badge>}
            <Button size="sm" variant="ghost" icon={Undo2} disabled={!dirty} onClick={() => setDraft(section.body)}>
              捨棄
            </Button>
            <Button size="sm" variant="primary" icon={Save} disabled={!dirty || !next} onClick={() => setReviewing(true)}>
              檢視變更
            </Button>
          </div>
        }
      >
        <label htmlFor={id} className="visually-hidden">
          {section.key} 內容
        </label>
        <textarea
          id={id}
          className="textarea"
          rows={18}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "s") {
              e.preventDefault();
              if (dirty && next) setReviewing(true);
            }
          }}
          spellCheck={false}
          style={{ minHeight: "22rem" }}
        />
        <p className="field__hint" style={{ marginTop: "var(--s-2)" }}>
          <span className="kbd">Ctrl</span> + <span className="kbd">S</span> 檢視變更。儲存後下一個回合就會用新內容。
        </p>
      </Panel>

      <Modal
        open={reviewing}
        wide
        title={`儲存「${section.key}」?`}
        onClose={() => !save.isPending && setReviewing(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setReviewing(false)} disabled={save.isPending}>
              繼續編輯
            </Button>
            <Button variant="primary" icon={Save} busy={save.isPending} onClick={doSave} autoFocus>
              儲存
            </Button>
          </>
        }
      >
        <DiffView before={section.body.trim()} after={next} />
      </Modal>

      <HistoryList sectionKey={section.key} current={section.body.trim()} onRestore={(v) => setDraft(v.body)} />
    </div>
  );
}

export function PersonaPage() {
  const persona = usePersona();
  const [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const sections = persona.data ?? [];
  const current = useMemo(() => sections.find((s) => s.key === selected) ?? sections[0], [sections, selected]);

  // Saved: the server body caught up with the draft, so drop the draft.
  useEffect(() => {
    setDrafts((d) => {
      let changed = false;
      const next = { ...d };
      for (const s of sections) {
        if (next[s.key] !== undefined && next[s.key]?.trim() === s.body.trim()) {
          delete next[s.key];
          changed = true;
        }
      }
      return changed ? next : d;
    });
  }, [sections]);

  const isDirty = (key: string) => drafts[key] !== undefined && drafts[key]?.trim() !== sections.find((s) => s.key === key)?.body.trim();

  // Drafts survive switching sections; warn before a reload throws them away.
  const anyDirty = sections.some((s) => isDirty(s.key));
  useEffect(() => {
    if (!anyDirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyDirty]);

  return (
    <div className="page">
      <PageHeader title="Persona" description="她的個性、說話風格與規則。每次儲存都會留下版本,隨時可以比較或還原。" />
      <QueryView
        query={persona}
        route="GET /api/persona"
        isEmpty={(d) => d.length === 0}
        empty={
          <Panel>
            <EmptyState icon={ScrollText} title="Persona 沒有任何段落">
              檢查 profile 的 persona 檔案是否載入成功。
            </EmptyState>
          </Panel>
        }
      >
        {() =>
          current ? (
            <div className="split">
              <Panel title="段落" titleId="persona-sections" flush>
                <ul className="rows" role="listbox" aria-label="Persona 段落">
                  {sections.map((s) => (
                    <li key={s.key} role="presentation">
                      <button
                        type="button"
                        role="option"
                        aria-selected={s.key === current.key}
                        className="row row--button"
                        onClick={() => setSelected(s.key)}
                      >
                        <div className="row__main">
                          <div className="row__title mono" style={{ fontSize: "var(--fs-sm)" }}>
                            {s.key}
                          </div>
                          <div className="row__meta">{s.body.length} 字</div>
                        </div>
                        {isDirty(s.key) && <span className="dot" data-tone="warn" title="未儲存" />}
                      </button>
                    </li>
                  ))}
                </ul>
              </Panel>
              <SectionEditor
                key={current.key}
                section={current}
                draft={drafts[current.key] ?? current.body}
                setDraft={(v) => setDrafts((d) => ({ ...d, [current.key]: v }))}
              />
            </div>
          ) : null
        }
      </QueryView>

    </div>
  );
}
