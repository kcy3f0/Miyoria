// What she organized and learned, read-only: `GET /api/knowledge` (her documents, whatever their
// shape), `GET /api/knowledge/conversations` (her running notes on each conversation),
// `GET /api/reflection` (her reflections, lessons and feedback signals) and
// `GET /api/mind/digests` (condensed older thoughts). Changes are hers (or the data page's
// delete), not these routes'.

import { SocialKey } from "@miyoria/social";
import {
  ConversationStatesKey,
  KnowledgeKey,
  type KnowledgeSubject,
  LessonsKey,
  MindKey,
  PlatformSinksKey,
  ReflectionKey,
} from "@miyoria/types";
import { json, type Route } from "./route.js";
import type { ApiState } from "./state.js";
import type {
  ConversationNoteView,
  KnowledgeDocView,
  KnowledgeView,
  LessonView,
  ReflectionView,
} from "./types.js";

const MAX_RUNS = 60;

/** `#` + the last 6 characters of the id (what her prompts show). */
function shortId(id: string): string {
  return `#${id.slice(-6).toLowerCase()}`;
}

function subjectLabel(state: ApiState, subject: KnowledgeSubject): string {
  switch (subject.type) {
    case "person":
      return state.optional(SocialKey)?.displayName(subject.person) ?? subject.person;
    case "guild":
      return `伺服器 ${subject.guild}`;
    case "self":
      return "她自己";
    case "topic":
      return subject.name;
  }
}

function knowledgeView(state: ApiState): KnowledgeView {
  const kb = state.service(KnowledgeKey, "knowledge module");
  const documents: KnowledgeDocView[] = kb.docs().map((doc) => ({
    ...doc,
    short_id: shortId(doc.id),
    subject_label: subjectLabel(state, doc.subject),
  }));
  return { documents };
}

async function conversations(state: ApiState): Promise<ConversationNoteView[]> {
  const states = state.service(ConversationStatesKey, "conversation module");
  const sinks = state.optional(PlatformSinksKey);
  return Promise.all(
    states.list().map(async (s) => {
      let label: string | null = null;
      try {
        label = await state.labels.label(sinks, s.context);
      } catch {
        label = null;
      }
      return { ...s, label };
    }),
  );
}

function reflectionView(state: ApiState, days: number): ReflectionView {
  const reflection = state.service(ReflectionKey, "reflect module");
  const social = state.optional(SocialKey);
  const lessons: LessonView[] = (state.optional(LessonsKey)?.all() ?? []).map((l) => ({
    ...l,
    display_name: l.person === null ? null : (social?.displayName(l.person) ?? null),
  }));
  return {
    stats: reflection.stats(),
    runs: reflection.runs(MAX_RUNS),
    lessons,
    feedback: reflection.feedback(days),
  };
}

function intQuery(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw ?? fallback);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), max) : fallback;
}

export function learningRoutes(state: ApiState): Route[] {
  return [
    { method: "GET", path: "/api/knowledge", handler: () => json(knowledgeView(state)) },
    {
      method: "GET",
      path: "/api/knowledge/conversations",
      handler: async () => json(await conversations(state)),
    },
    {
      method: "GET",
      path: "/api/reflection",
      handler: (c) => json(reflectionView(state, intQuery(c.req.query("days"), 7, 14))),
    },
    {
      method: "GET",
      path: "/api/mind/digests",
      handler: (c) => {
        const mind = state.service(MindKey, "mind module");
        return json(mind.digests?.(intQuery(c.req.query("limit"), 20, 100)) ?? []);
      },
    },
  ];
}
