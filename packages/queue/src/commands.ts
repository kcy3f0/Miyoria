import {
  ArgKind,
  argSpec,
  type CommandHandler,
  type CommandRegistry,
  CommandReply,
  type CommandSpec,
  commandName,
  commandSpec,
  type Invocation,
} from "@miyoria/commands";
import type { RequestQueue } from "./queue.js";
import {
  type ItemId,
  QueueError,
  type QueueItem,
  tallies,
  type VoteResult,
  winnerOption,
} from "./types.js";

const LIST_LIMIT = 10;

type Handler = (queue: RequestQueue, inv: Invocation) => CommandReply;

/**
 * Registers `request`, `vote`, `queue list | next | done | skip | remove | clear | pause |
 * resume | priority | upvote` and `queue vote start | end`. Returns the registered paths (for
 * unregistering).
 *
 * `vote <option>` is a top-level command, so starting a vote lives under `queue vote start` (a
 * command path cannot be the prefix of another).
 */
export function registerCommands(registry: CommandRegistry, queue: RequestQueue): string[] {
  const perms = queue.config.permissions;
  const paths: string[] = [];
  const add = (spec: CommandSpec, handler: Handler): void => {
    paths.push(commandName(spec));
    const wrapped: CommandHandler = (inv) => handler(queue, inv);
    registry.register(spec, wrapped);
  };

  registry.setGroupDescription("queue", "請求佇列");
  registry.setGroupDescription("queue vote", "投票模式");

  add(
    commandSpec("request", "排一個請求", {
      args: [
        argSpec("text", "想要的內容", ArgKind.string),
        argSpec("kind", "種類,例如 song、game_goal", ArgKind.string, { required: false }),
      ],
      permission: perms.request,
    }),
    (q, inv) => {
      try {
        const s = q.submit({
          requester: inv.invoker,
          requesterName: inv.invoker_display_name,
          kind: inv.str("kind") ?? "",
          text: inv.str("text") ?? "",
          context: inv.context,
        });
        return CommandReply.public(`收到啦,#${s.item.id} 排第 ${s.position} 個。`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  add(
    commandSpec("queue list", "看目前的佇列", { permission: "queue.list", ephemeral: true }),
    (q) => CommandReply.ephemeral(formatList(q)),
  );

  add(commandSpec("queue next", "叫下一個", { permission: perms.manage, ephemeral: true }), (q) => {
    const item = q.next();
    if (item) return CommandReply.public(`輪到 ${describe(item)}`);
    return q.isPaused()
      ? CommandReply.ephemeral("暫停中,不叫人。")
      : CommandReply.ephemeral("沒有人在排隊。");
  });

  add(
    commandSpec("queue done", "標記進行中的項目完成", {
      args: [argSpec("id", "項目編號,預設目前進行中的", ArgKind.integer, { required: false })],
      permission: perms.manage,
      ephemeral: true,
    }),
    (q, inv) => {
      const target = targetId(q, inv);
      if (target === null) return CommandReply.ephemeral("要指定編號,或是現在要有進行中的項目。");
      try {
        return CommandReply.ephemeral(`#${q.complete(unwrap(target)).id} 完成了。`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  add(
    commandSpec("queue skip", "跳過項目", {
      args: [argSpec("id", "項目編號,預設目前進行中的", ArgKind.integer, { required: false })],
      permission: perms.manage,
      ephemeral: true,
    }),
    (q, inv) => {
      const target = targetId(q, inv);
      if (target === null) return CommandReply.ephemeral("要指定編號,或是現在要有進行中的項目。");
      try {
        return CommandReply.ephemeral(`跳過 #${q.skip(unwrap(target)).id} 了。`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  add(
    commandSpec("queue remove", "移除項目", {
      args: [argSpec("id", "項目編號", ArgKind.integer)],
      permission: perms.manage,
      ephemeral: true,
    }),
    (q, inv) => {
      try {
        return CommandReply.ephemeral(`移除 #${q.remove(itemId(inv)).id} 了。`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  add(
    commandSpec("queue clear", "清空排隊中的項目", {
      permission: perms.manage,
      ephemeral: true,
    }),
    (q) => CommandReply.ephemeral(`清掉 ${q.clear()} 個。`),
  );

  add(
    commandSpec("queue pause", "暫停叫號", { permission: perms.manage, ephemeral: true }),
    (q) => {
      q.pause();
      return CommandReply.ephemeral("暫停了,還是可以排,但不會叫下一個。");
    },
  );

  add(
    commandSpec("queue resume", "恢復叫號", { permission: perms.manage, ephemeral: true }),
    (q) => {
      q.resume();
      return CommandReply.ephemeral("繼續囉。");
    },
  );

  add(
    commandSpec("queue priority", "設定項目優先度(越大越前面)", {
      args: [
        argSpec("id", "項目編號", ArgKind.integer),
        argSpec("priority", "優先度整數", ArgKind.integer),
      ],
      permission: perms.manage,
      ephemeral: true,
    }),
    (q, inv) => {
      const raw = inv.int("priority");
      const priority = raw !== null && Number.isInteger(raw) && fitsI32(raw) ? raw : null;
      let id: ItemId;
      try {
        id = itemId(inv);
      } catch {
        return CommandReply.ephemeral("編號或優先度不對。");
      }
      if (priority === null) return CommandReply.ephemeral("編號或優先度不對。");
      try {
        q.setPriority(id, priority);
        return CommandReply.ephemeral(`#${id} 優先度設成 ${priority}。`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  add(
    commandSpec("queue upvote", "幫排隊中的項目加一票", {
      args: [argSpec("id", "項目編號", ArgKind.integer)],
      permission: perms.vote,
      ephemeral: true,
    }),
    (q, inv) => {
      try {
        return CommandReply.ephemeral(`加票了,現在 ${q.vote(itemId(inv), inv.invoker)} 票。`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  add(
    commandSpec("queue vote start", "開始投票", {
      args: [
        argSpec("options", "選項,用逗號分隔", ArgKind.string),
        argSpec("seconds", "投票秒數", ArgKind.integer),
      ],
      permission: perms.manage,
    }),
    (q, inv) => {
      const options = (inv.str("options") ?? "").split(/[,，、]/u).map((s) => s.trim());
      const seconds = inv.int("seconds");
      if (seconds === null || !Number.isInteger(seconds) || seconds < 0) {
        return CommandReply.ephemeral("秒數要是正整數。");
      }
      try {
        q.startVote(options, seconds * 1000);
        const vote = q.voteStatus();
        const list = (vote?.options ?? []).map((o, i) => `${i + 1}. ${o}`).join(" / ");
        return CommandReply.public(`投票開始!${seconds} 秒內用 \`vote <選項>\` 投:${list}`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  add(commandSpec("queue vote end", "提前結束投票", { permission: perms.manage }), (q) => {
    try {
      return CommandReply.public(formatResult(q.endVote()));
    } catch (error) {
      return failure(error);
    }
  });

  add(
    commandSpec("vote", "投票", {
      args: [argSpec("option", "選項文字或編號", ArgKind.string)],
      permission: perms.vote,
      ephemeral: true,
    }),
    (q, inv) => {
      try {
        return CommandReply.ephemeral(
          `投給「${q.castVote(inv.invoker, inv.str("option") ?? "")}」了。`,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  return paths;
}

function fitsI32(n: number): boolean {
  return n >= -(2 ** 31) && n <= 2 ** 31 - 1;
}

/** A `QueueError` becomes an ephemeral reply; anything else is a real failure. */
function failure(error: unknown): CommandReply {
  if (error instanceof QueueError) return CommandReply.ephemeral(errorText(error));
  throw error;
}

/** Required `id` argument. Negative numbers are treated as unknown items. */
function itemId(inv: Invocation): ItemId {
  const raw = inv.int("id") ?? 0;
  if (!Number.isInteger(raw) || raw < 0) throw QueueError.notFound(0);
  return raw;
}

/** An id, or the error that parsing it produced. */
type Target = { id: ItemId } | { error: QueueError };

/** Optional `id`, defaulting to the current active item. `null` when neither exists. */
function targetId(q: RequestQueue, inv: Invocation): Target | null {
  if (Object.hasOwn(inv.args, "id")) {
    try {
      return { id: itemId(inv) };
    } catch (error) {
      return { error: error as QueueError };
    }
  }
  const current = q.current();
  return current ? { id: current.id } : null;
}

function unwrap(target: Target): ItemId {
  if ("error" in target) throw target.error;
  return target.id;
}

function describe(item: QueueItem): string {
  const chars = [...item.text];
  const text = chars.slice(0, 30).join("");
  const ellipsis = chars.length > 30 ? "…" : "";
  return `#${item.id} [${item.kind}] ${item.requester_name}:${text}${ellipsis}`;
}

function formatList(q: RequestQueue): string {
  const items = q.list();
  let out = q.isPaused() ? "佇列(暫停中)" : "佇列";
  if (items.length === 0) out += ":空的。";
  for (const item of items.slice(0, LIST_LIMIT)) {
    const place = item.state === "active" ? "進行中" : "排隊";
    out += `\n${place} ${describe(item)}`;
    if (item.votes > 0) out += ` (${item.votes}票)`;
  }
  if (items.length > LIST_LIMIT) out += `\n……還有 ${items.length - LIST_LIMIT} 個`;
  const vote = q.voteStatus();
  if (vote) {
    const counts = tallies(vote);
    const line = vote.options.map((o, i) => `${o} ${counts[i] ?? 0}`).join(" / ");
    out += `\n投票中:${line}`;
  }
  return out;
}

function formatResult(result: VoteResult): string {
  const line = result.options.map((o, i) => `${o} ${result.tallies[i] ?? 0} 票`).join(" / ");
  const winner = winnerOption(result);
  return winner !== null
    ? `投票結束:${line}。贏的是「${winner}」。`
    : `投票結束:${line}。沒有人投,算了。`;
}

/** User-facing (Traditional Chinese) text of a queue error. */
export function errorText(error: QueueError): string {
  switch (error.kind) {
    case "blocked":
      return "這個我不接。";
    case "empty_text":
      return "要寫點內容啦。";
    case "text_too_long":
      return `太長了,最多 ${error.arg} 個字。`;
    case "user_limit":
      return `你已經排了 ${error.arg} 個了,先等等啦。`;
    case "queue_full":
      return "佇列滿了啦,晚點再來。";
    case "not_found":
      return `找不到 #${error.arg}。`;
    case "wrong_state":
      return `#${error.arg} 現在不能這樣處理。`;
    case "vote_running":
      return "已經有投票在跑了。";
    case "no_vote":
      return "現在沒有在投票。";
    case "bad_vote":
      return `投票設定不對:${error.arg}`;
    case "unknown_option":
      return `沒有「${error.arg}」這個選項。`;
  }
}
