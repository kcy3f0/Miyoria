// Whether what she says she did really happened (v2 §1.8 #5: no string as protocol).
//
// What she did is structured: every body transition a tool of hers asked for is an
// ActivityManager task tagged with her turn (the `TransitionResult` her tool got back: started /
// queued / already / refused), and what came back later is an `agent.notice` with its task id.
// The snapshot says what is true now. A line of hers that says she joined voice, went live or
// started a game is fine when one of those backs it.
//
// Only the claim itself is still spotted in her text (`CLAIMS`): that is the one thing no
// structured signal carries, and without it she could tell someone "我游過去了" when nothing
// happened (the model does that). It is a safety net, not the protocol: it never decides what
// happened, and a claim backed by a task, a notice or the current state is never questioned.

import type { ActivityManager, ActivityRequestType, Notice, TurnId } from "@miyoria/types";
import type { ToolScope } from "./tool-scope.js";

/** A claim of something only a tool does, by the transition (and tool) it stands for. */
export interface Claim {
  tool: string;
  request: ActivityRequestType;
  said: RegExp;
  /** Her state already is what she says (nothing to do, nothing false). */
  holds(scope: ToolScope): boolean;
}

export const CLAIMS: readonly Claim[] = [
  {
    tool: "voice_join",
    request: "ensure_voice",
    said: /游過去|游去了|進語音了|進去語音|加入語音了|過去語音/,
    holds: (s) => s.inVoice,
  },
  {
    tool: "voice_leave",
    request: "leave_voice",
    said: /離開語音了|退出語音了|游走了|先下語音/,
    holds: (s) => !s.inVoice,
  },
  {
    tool: "stream_start",
    request: "ensure_live",
    said: /開台了|開播了|開始直播了/,
    holds: (s) => s.live,
  },
  {
    tool: "stream_stop",
    request: "stop_live",
    said: /關台了|下播了|結束直播了/,
    holds: (s) => !s.live,
  },
  {
    tool: "game_start",
    request: "start",
    said: /開遊戲了|開始玩了|開好遊戲/,
    holds: (s) => s.game !== null,
  },
];

/** What backs her claims in one turn. */
export interface Backing {
  /** Transitions her turn asked for that were accepted (tasks queued, running or done). */
  requests: ReadonlySet<ActivityRequestType>;
  /** Tools of this turn that answered without an error (no ActivityManager: the only signal). */
  tools: ReadonlySet<string>;
  /** Her state now (`null`: unknown). */
  scope: ToolScope | null;
}

/**
 * The transitions `turn` asked for that were accepted, plus those an ok notice she was told
 * reports (by its task id).
 */
export function acceptedRequests(
  manager: ActivityManager | null,
  turn: TurnId,
  notices: readonly Notice[],
): Set<ActivityRequestType> {
  const out = new Set<ActivityRequestType>();
  if (manager === null) return out;
  for (const task of manager.tasks()) {
    if (task.turn === turn && task.status !== "failed") out.add(task.request.type);
  }
  for (const notice of notices) {
    if (!notice.ok || notice.task === null) continue;
    const task = manager.task(notice.task);
    if (task !== null && task.status === "done") out.add(task.request.type);
  }
  return out;
}

/**
 * The first claim in `text` (of a tool on offer) that nothing backs: no accepted transition of
 * this turn or notice, no successful tool call, and her state is not already what she says.
 */
export function unbackedClaim(
  text: string,
  offered: ReadonlySet<string>,
  backing: Backing,
): Claim | null {
  for (const claim of CLAIMS) {
    if (!offered.has(claim.tool) || !claim.said.test(text)) continue;
    if (backing.requests.has(claim.request) || backing.tools.has(claim.tool)) continue;
    if (backing.scope !== null && claim.holds(backing.scope)) continue;
    return claim;
  }
  return null;
}

export function claimReminder(tool: string): string {
  return `(系統提醒,不是對方說的話)你剛才說的事要呼叫 ${tool} 才會真的發生,但這一回合還沒呼叫。要做就現在呼叫它;決定不做或做不到,就照實跟對方說。`;
}
