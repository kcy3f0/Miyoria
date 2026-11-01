// `/link`, `/me` and `/admin person ...`.

import {
  ArgKind,
  argSpec,
  type CommandRegistry,
  CommandReply,
  type CommandSpec,
  commandSpec,
  type Invocation,
  type Permissions,
  parseAccount,
} from "@miyoria/commands";
import { type AccountRef, accountRefString, type PersonId, toTimestamp } from "@miyoria/types";
import type { LinkOutcome, Social } from "./engine.js";
import { BLOCKED_TAG, type EventKind, isBlocked, label, OWNER_TAG } from "./rel.js";
import { classify } from "./rules.js";

/** Paths registered by `registerCommands`. */
export const PATHS: readonly string[] = [
  "link",
  "me",
  "admin person show",
  "admin person tag",
  "admin person untag",
  "admin person block",
  "admin person unblock",
  "admin person reset",
  "admin person adjust",
];

const MAX_CALL_NAME_CHARS = 20;
const MAX_TAG_CHARS = 24;

type AdminOp = "show" | "tag" | "untag" | "block" | "unblock" | "reset" | "adjust";

/** Registers the social commands. Undo with `unregisterCommands`. */
export function registerCommands(registry: CommandRegistry, social: Social): void {
  registry.setGroupDescription("admin person", "管理她認識的人");
  const perms = registry.permissions();

  registry.register(
    commandSpec("link", "把你的其他帳號連到同一個人(不帶代碼 = 取得代碼)", {
      args: [argSpec("code", "另一個帳號拿到的連結代碼", ArgKind.string, { required: false })],
      permission: "me.link",
      ephemeral: true,
    }),
    async (inv) => CommandReply.ephemeral(await link(social, inv)),
  );

  registry.register(
    commandSpec("me", "看看她怎麼看你,或設定她怎麼叫你", {
      args: [
        argSpec("call", "想讓她怎麼叫你(「清除」= 取消)", ArgKind.string, { required: false }),
      ],
      permission: "me.self",
      ephemeral: true,
    }),
    async (inv) => CommandReply.ephemeral(await me(social, inv)),
  );

  const user = () => argSpec("user", "要管理的人(@提及、platform:id 或名字)", ArgKind.user);
  const tag = () => argSpec("tag", "標籤,例如 friend、regular、troll", ArgKind.string);
  const specs: Array<[AdminOp, CommandSpec]> = [
    [
      "show",
      commandSpec("admin person show", "看她對某人的詳細數值", {
        args: [user()],
        permission: "admin.person.show",
      }),
    ],
    [
      "tag",
      commandSpec("admin person tag", "幫某人加標籤", {
        args: [user(), tag()],
        permission: "admin.person.tag",
      }),
    ],
    [
      "untag",
      commandSpec("admin person untag", "移除某人的標籤", {
        args: [user(), tag()],
        permission: "admin.person.tag",
      }),
    ],
    [
      "block",
      commandSpec("admin person block", "讓她不理某人", {
        args: [user()],
        permission: "admin.person.block",
      }),
    ],
    [
      "unblock",
      commandSpec("admin person unblock", "解除封鎖", {
        args: [user()],
        permission: "admin.person.block",
      }),
    ],
    [
      "reset",
      commandSpec("admin person reset", "把她對某人的印象歸零(標籤保留)", {
        args: [user()],
        permission: "admin.person.reset",
      }),
    ],
    [
      "adjust",
      commandSpec("admin person adjust", "直接調整好感(只有主人能用)", {
        args: [user(), argSpec("affinity", "好感變化,-100 到 100", ArgKind.integer)],
        permission: "admin.person.adjust",
      }),
    ],
  ];
  for (const [op, spec] of specs) {
    registry.register({ ...spec, ephemeral: true }, async (inv) =>
      CommandReply.ephemeral(await admin(social, perms, op, inv)),
    );
  }
}

export function unregisterCommands(registry: CommandRegistry): void {
  for (const path of PATHS) registry.unregister(path);
}

const UNAVAILABLE = "帳號連結現在沒辦法用……不是我的問題喔。";

function linkReply(outcome: LinkOutcome): string {
  switch (outcome.type) {
    case "linked":
      return "好了,我知道這兩個帳號都是你了。哼,別以為換個帳號我就認不出來。";
    case "already_linked":
      return "這兩個帳號本來就連在一起了啦。";
    case "same_account":
      return "要用「另一個」帳號輸入代碼啦,笨蛋。";
    case "invalid_code":
      return "這個代碼不對,或是已經過期了。";
    case "too_many_attempts":
      return "你試太多次了,等一下再來。";
    case "unavailable":
      return UNAVAILABLE;
  }
}

async function link(social: Social, inv: Invocation): Promise<string> {
  const now = social.clock.now();
  const code = inv.str("code")?.trim() ?? "";
  if (code === "") {
    const issued = await social.issueLinkCode(inv.invoker, inv.invoker_display_name, now);
    if (issued === null) return UNAVAILABLE;
    return (
      `你的連結代碼是 \`${issued}\`。十分鐘內用你的另一個帳號輸入 \`/link code:${issued}\`……` +
      "快點啦,我不會等你太久的。"
    );
  }
  const outcome = await social.redeemLinkCode(inv.invoker, inv.invoker_display_name, code, now);
  return linkReply(outcome);
}

const NOT_TALKING = "……我現在不想跟你說話。";
const CLEAR_WORDS = new Set(["清除", "取消", "reset", "clear", "-"]);

async function me(social: Social, inv: Invocation): Promise<string> {
  const now = social.clock.now();
  const person = await social.resolve(inv.invoker, inv.invoker_display_name, now);
  if (person === null) return "……你是誰?";
  const rel = social.relationship(person);
  const blocked = rel !== null && isBlocked(rel);
  const rawCall = inv.str("call");
  if (rawCall !== null) {
    if (blocked) return NOT_TALKING;
    const call = rawCall.trim();
    if (CLEAR_WORDS.has(call)) {
      await social.setCallName(person, null, now);
      return "好啦,那我就照普通的方式叫你。";
    }
    const why = checkCallName(call);
    if (why !== null) return why;
    const labelNow = rel === null ? "陌生人" : label(rel);
    if (labelNow === "很討厭") return "我們有熟到可以這樣叫嗎?哼。";
    await social.setCallName(person, call, now);
    return `……「${call}」是吧。知、知道了,我會這樣叫你的。`;
  }
  if (blocked) return NOT_TALKING;
  const labelNow = rel === null ? "陌生人" : label(rel);
  const feeling = FEELINGS[labelNow] ?? "你誰啊?我們又不熟。";
  const callName = rel?.call_name ?? null;
  const call =
    callName !== null
      ? `我都叫你「${callName}」。`
      : "你還沒告訴我要怎麼叫你,用 `/me call:名字` 設定吧。";
  return `在我心裡你是「${labelNow}」。${feeling}\n${call}`;
}

const FEELINGS: Readonly<Record<string, string>> = {
  很討厭: "……你自己心裡有數。",
  討厭: "老實說,我現在不太想理你。",
  摯友: "你、你是我最重要的朋友之一啦……這種話不要讓我說第二次!",
  好朋友: "哼,你算是我的好朋友……不准得意喔。",
  朋友: "勉、勉強算是朋友啦。",
  認識: "嗯……算是認識的人吧。",
};

const RUDE_KINDS: ReadonlySet<EventKind> = new Set([
  "rude",
  "insult",
  "harassment",
  "flirt_too_far",
]);

/** Rejects names she would not use: too long, links / mentions, rude words. */
function checkCallName(call: string): string | null {
  const len = [...call].length;
  if (len === 0) return "名字是空的啦。";
  if (len > MAX_CALL_NAME_CHARS) return "太長了,我才記不住!短一點。";
  if (/[\n@<>`]/.test(call) || call.includes("://")) return "這種奇怪的東西我才不要叫。";
  if (classify(call).some((k) => RUDE_KINDS.has(k))) {
    return "才、才不要那樣叫你咧!換一個正常一點的啦。";
  }
  return null;
}

async function admin(
  social: Social,
  perms: Permissions,
  op: AdminOp,
  inv: Invocation,
): Promise<string> {
  const now = social.clock.now();
  const user = inv.str("user") ?? "";
  const person = await findPerson(social, inv, user);
  if (person === null) return `我不認識「${user.trim()}」這個人。`;
  const name = social.displayName(person) ?? user.trim();
  const by = accountRefString(inv.invoker);
  const isOwner = () => social.subjectIsOwner(inv.subject(), perms.isOwner(inv.invoker));
  switch (op) {
    case "show":
      return show(social, person, name, now);
    case "tag":
    case "untag": {
      const on = op === "tag";
      const tag = normalizeTag(inv.str("tag") ?? "");
      if (tag === null) return "標籤只能用小寫英數字、- 和 _,而且不能太長。";
      if (tag === OWNER_TAG && !isOwner()) return "`owner` 標籤只有我的主人能改!";
      const changed = await social.setTag(person, tag, on, by, now);
      if (changed) return on ? `幫 ${name} 加上 \`${tag}\` 了。` : `${name} 的 \`${tag}\` 拿掉了。`;
      return on ? `${name} 本來就有 \`${tag}\` 了。` : `${name} 本來就沒有 \`${tag}\`。`;
    }
    case "block":
    case "unblock": {
      const on = op === "block";
      const changed = await social.setTag(person, BLOCKED_TAG, on, by, now);
      if (changed)
        return on ? `好,我不會再理 ${name} 了。` : `好啦,我會再理 ${name} 的……看他表現。`;
      return on ? `${name} 本來就被我封鎖了。` : `${name} 本來就沒被封鎖啊。`;
    }
    case "reset":
      await social.reset(person, by, now);
      return `我對 ${name} 的印象歸零了。……重新認識一次吧。`;
    case "adjust": {
      if (!isOwner()) return "這個只有我的主人能用,你、你又不是!";
      const delta = inv.int("affinity") ?? 0;
      if (delta < -100 || delta > 100 || delta === 0) {
        return "好感變化要在 -100 到 100 之間,而且不能是 0。";
      }
      const r = await social.adjust(person, delta, by, now);
      const signed = delta > 0 ? `+${delta}` : `${delta}`;
      return `${name} 的好感調整了 ${signed},現在是 ${fixed1(r.affinity)}(${label(r)})。……這是作弊吧。`;
    }
  }
}

/** Rust `{:.1}`. */
function fixed1(v: number): string {
  return v.toFixed(1);
}

/** `%Y-%m-%d %H:%M UTC`. */
function utcMinutes(ts: string): string {
  const iso = toTimestamp(Date.parse(ts));
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function show(social: Social, person: PersonId, name: string, now: number): string {
  const r = social.relationship(person);
  if (r === null) return `我跟 ${name} 還沒有任何交集。`;
  let out =
    `**${name}**(person \`${person}\`)\n` +
    `好感 ${fixed1(r.affinity)} / 信任 ${fixed1(r.trust)} / 熟悉 ${fixed1(r.familiarity)} → ${label(r)}`;
  const tags = r.tags.length === 0 ? "無" : r.tags.join("、");
  out += `\n標籤:${tags}`;
  out += `\n稱呼:${r.call_name ?? "未設定"}`;
  const last = r.last_interaction === null ? "從來沒有" : utcMinutes(r.last_interaction);
  out += `\n互動 ${r.interactions} 次,最後一次 ${last}`;
  const day = social.today(person, now);
  if (day !== null) {
    out +=
      `\n今天:好感 +${fixed1(day.affinity_gained)} / -${fixed1(day.affinity_lost)}、` +
      `信任 +${fixed1(day.trust_gained)} / -${fixed1(day.trust_lost)}`;
  }
  const notes = r.notes.trim() === "" ? "(還沒有)" : r.notes.trim();
  out += `\n印象:${notes}`;
  return out;
}

function normalizeTag(tag: string): string | null {
  const t = tag.trim().toLowerCase();
  const len = [...t].length;
  return len >= 1 && len <= MAX_TAG_CHARS && /^[a-z0-9_-]+$/.test(t) ? t : null;
}

/**
 * Resolves the `user` argument (mentions are already reduced to ids by the registry):
 * `platform:id`, a bare numeric id on the invoker's platform, or a unique display name she
 * knows.
 */
async function findPerson(social: Social, inv: Invocation, user: string): Promise<PersonId | null> {
  const s = user.trim();
  if (s === "") return null;
  let account: AccountRef | null = null;
  if (/^[0-9]+$/.test(s)) {
    account = { platform: inv.context.platform, id: s };
  } else if (s.includes(":")) {
    try {
      account = parseAccount(s);
    } catch {
      account = null;
    }
  }
  if (account !== null) return social.resolve(account, null, social.clock.now());
  const named = social.peopleNamed(s);
  return named.length === 1 ? (named[0] as PersonId) : null;
}
