# v2 實作分工(平行工作的 brief)

> 狀態:**第一波開工用**(2026-11-04)。設計見 [v2-architecture.md](v2-architecture.md)(以下「§」都指那份);kernel / module / service key 模型見 [ARCHITECTURE.md](../ARCHITECTURE.md) §2;程式慣例見 [TS-CONVENTIONS.md](../TS-CONVENTIONS.md);commit 規則見 `AGENTS.md`。共用契約已經放進 `packages/types/src`(下面 §1),各工作流**照契約寫,不要各自再定義一份**。
>
> 行號是寫這份文件當下(commit `2a86ff0` 之後)的位置;動手前用旁邊寫的識別字 grep 一下確認。

## 0. 共用檔案規則

平行的 worktree 最後要合在一起,共用檔案只能做「不會衝突」的修改:

| 檔案 | 規則 |
|---|---|
| `packages/types/src/**` | **只新增檔案**。`index.ts` 只能在檔尾追加 export;既有型別不改名、不改欄位。真的要擴充既有 union(例如 `SpeakOutcome`)時,只能在 union **尾端追加成員**,並在 PR 說明列出。新的 bus topic 一律用 custom event + `*_TOPIC` 常數(見 `v2-topics.ts`),**不要**動 `event.ts` 的 `Event` union / `EVENT_TOPICS`(SDK 有一份對應的副本) |
| `packages/core/src/modules.ts` | 只追加小 hunk(新 module 一行、import 一行),不重排既有順序 |
| `packages/core/src/boot.ts`、`packages/core/src/recorder.ts` | 同上,只追加 |
| `miyoria.example.toml` 與 `packages/cli/templates/miyoria.example.toml` | 兩份要一起改(內容相同);只追加新的 section / key,舊 key 的刪除留到該階段收尾 |
| `docs/design/*.md` | 各工作流只在自己的小節追加實作紀錄 |

其他規則:

- 每個工作流只改「擁有」欄列出的路徑;要改別人的檔案就在 PR 說明寫「需要 Wx 配合」,不要直接改。下面列出的例外(某工作流可以改別人檔案裡的某個 hunk)才可以。
- 消費別人還沒做好的服務時,一律 `ctx.services.get(XKey)`,拿不到就走**現在的行為**(fallback),這樣每個工作流都能單獨合併。
- 新的 config key 照 TS-CONVENTIONS §6:zod schema、每個欄位有預設值,預設值等於 example toml。

## 1. 共用契約(`packages/types/src`,本次新增)

| 檔案 | 內容 | 提供者 | 主要消費者 |
|---|---|---|---|
| `handle.ts` | `Handle`、`HandleEntry`、`HandleDirectory` + `HandleDirectoryKey`;`isEphemeralHandle()`(擋 `u1`/`p2`/`g3`)、`ephemeralHandlesIn(text)`、`assignHandle()`(同名才加 `#2`)、`handleBase()`、`isValidHandle()` | W5(store + `core/src/boot.ts`) | 全部 |
| `turn.ts` | `TurnFocus{addressed_by, addressed_accounts, focus, background, phase, restarts}`、`TurnFocusView` + `TurnFocusViewKey`、`inputDisposition()`(§3.9 取消規則表)、`isShortReply()`、`TurnOutcome`(sent / silence / cancelled{cause, by} / error)、`TurnOutcomeRecord`;topic `agent.turn.focus`、`agent.turn.outcome` | W1(agent) | W2、W6、面板 |
| `prompt-block.ts` | `PromptAuthority`(`self` 可信 / `data` 不可信)、`PromptBlock extends PromptSection`(authority、source、`budget_chars`、overflow)、`asPromptBlock()`、`SELF_BLOCK_KEYS`、`CompiledBlock`、`SavedPrompt` | W1 | 所有 prompt contributor |
| `reasoning.ts` | `ReasoningLevel`(off/low/medium/high)、`REASONING_PURPOSES`(§3.10 的十個)、`DEFAULT_REASONING`、`reasoningFor()`、`reasoningEnabled()` | W1(llm) | 所有呼叫 LLM 的模組 |
| `activity.ts` | `HerPresence` / `HerBroadcast` / `HerActivity`(三台狀態機)、`ActivitySnapshot`(帶 `version`、`scene`、`override`)、`ActivityRequest`(ensure_voice / leave_voice / ensure_live / stop_live / start / stop / scene_override / clear_override)、`ActivityTransition`(principal、turn、context)、`TransitionResult`(started / already / queued / refused,帶 task id)、`ActivityTask`、`ActivityTaskEvent`、`Notice`、`ActivityManager` + `ActivityManagerKey`;topic `activity.changed|started|done|failed`、`agent.notice` | W3(新 `packages/activity`) | W1、W4、W6、W7、stage |
| `task.ts` | `TaskId`、`TaskSpec{id, goal, args, budget_s}`、`TaskEvent`(started / progress / done / failed{code, detail})、`TASK_FAILURE_CODES`、`StructuredState`、`TaskExecutor`(observe / start / cancel / events)、`taskTopic()` / `parseTaskTopic()`(`<owner>.task.<type>`) | W3(ActivityManager)、W8(extension) | W3、W7、W8 |
| `arbiter.ts` | `Impulse{source, kind, target, priority, expires_at, why, hint, coalesce_key, goal}`、`IMPULSE_SOURCES`、`isSelfInitiated()`(只有 plan / agenda 算她主動)、`ArbiterDecision{verdict, reason, detail, retry_at}`、`LedgerEntry` / `LedgerLimits` / `LedgerView` / `LedgerRecord`、`Arbiter` + `ArbiterKey`;topic `arbiter.impulse|decision|ledger` | W6(新 package) | W1、W3、W7、所有發 initiative 的地方 |
| `affect.ts` | `AppraisalEvent{emotion, strength: weak|medium|strong, toward, cause}`、`APPRAISAL_STRENGTH`(0.1/0.2/0.35)、`AffectEvent` + `AFFECT_EVENT_KINDS`(規則事件)、`AffectInput`、`AppliedAppraisal`、`PersonCard`(一人一卡,含 `attachment`、`feeling`、`label`)、`BondChange`、`RelationshipLabel` + `relationshipLabel()`(唯一刻度,門檻同現在 `social/src/rel.ts:308`)、`AffectBiases`、`AffectSnapshot`(`top` 2–3 種、`mood` 推導、`mood_line`)、`AffectState` + `AffectStateKey`;topic `affect.event`、`affect.changed`。沿用 `self.ts` 的 `Drives`、`EmotionName`、`PersonEmotionName`、`EmotionReading`、`ShownEmotion` 與 `social.ts` 的 `Mood` | W4(self module) | W1、W6、W7 |
| `plan.ts` | `Goal`(§3.7,`expires` 必填,`steps: string[]`)、`GoalTrigger`(at / when_online(Handle) / after_activity / whenever)、`triggerFires()` / `goalDue()`(**whenever 永遠不是到期**)、`isGoalExpired()`、`Desire`(想做的事清單)、`PlanWake`、`GoalAgenda` + `GoalAgendaKey`;topic `plan.goal` | W7 | W6、W1 |
| `v2-topics.ts` | `V2TopicPayloads`(topic → payload 型別表)、`V2_TOPICS`、`V2_TOPIC_PREFIXES`、`v2Event()`、`v2Payload()` | — | 全部 |

形狀規則照 TS-CONVENTIONS §2:序列化的欄位 snake_case、可選值是 `T | null`;訊息用既有的 `MessageRef`(語音句子是 `{context, id: utterance.id}`,`agent/src/runtime.ts:640` 已經這樣包)。v2 的 topic 都是 custom event;`activity` / `arbiter` / `affect` / `plan` 這四個前綴要加進 extension host 的保留前綴(見 W3)。

## 2. 工作流

### W1 Converse(對話管線、prompt 編譯器、推理分級、人設)

**擁有**:`packages/agent/**`、`packages/llm/**`、`profiles/**`;`packages/core/src/recorder.ts` 追加 outcome 紀錄的 hunk;兩份 example toml 的 `[llm.reasoning]`、`[modules.agent]` 段。

**提供**:`TurnFocusViewKey`(agent module `ctx.provide`)、topic `agent.turn.focus` / `agent.turn.outcome`、prompt 編譯器(`PromptBlock` 的唯一消費者)、`[llm.reasoning]`(router 依 `ReasoningPurpose` 決定推理等級)、notice 的呈現。

**消費**:`HandleDirectoryKey`(fallback:`safeName(display_name)`)、`AffectStateKey`(fallback:`SelfStateKey` + `MoodSignalsKey`)、`ActivityManagerKey`(fallback:`WorldStateKey` 的 `her`)、`ArbiterKey.ledger()`(fallback:`MindKey.unanswered`)、`GoalAgendaKey`(fallback:`SelfState.agenda()`)、topic `agent.notice`、`voice.barge_in`。

**階段 0**:1、3、4、5、7、8、18。

| 要改的地方 | 現況 |
|---|---|
| `agent/src/coordinator.ts:122-141` | 新訊息無條件 `#abort` 未 committed 的回合;語音已生成未播放的也 `#cancel` 重生成 → 改用 `inputDisposition()`;`#abort`(`:433`)要帶 cancel cause |
| `agent/src/coordinator.ts:302-345` | `#initiative` 的 busy / cooldown / `startBlocked` 判斷(W6 之後移到 Arbiter,W1 先別刪) |
| `agent/src/attention.ts:380-383` | talkativeness ≤ 靜音門檻就 return,在「是不是在回她」之前 → 回她剛說的話要先跳過安靜檢查與 level 冷卻;talkativeness 下限 |
| `agent/src/prompt.ts:39` `GUARD_RULES`、`:65-66` `ADDRESSED`、`:344-357` `focusMessage()`(取最後 3 則 `current`)、`:486-489`(資料區塊 + 第二則 system) | §3.5 編譯器:self 可信 system 區塊 / data 不可信區塊;focus 只放 `TurnFocus.focus`,寫「Owen 問你:…」 |
| `agent/src/turn.ts:803-810` | contributor 收集後 `renderSections(…, max_context_chars)` 依順序截斷(`agent/src/config.ts:323` 預設 4000)→ 每段自己的 budget(`asPromptBlock()`) |
| `agent/src/turn.ts:1044` | `reply_reference` 引用最後一則 → 引用 `focus[0]`;`agent/src/config.ts:299` 預設改 true |
| `agent/src/turn.ts:1155-1163` | **文字回覆的 thinking 寫死在這裡**(`thinking: !this.voice`),不是 `[llm.thinking] chat`;改成 `reasoningFor("chat_text" / "chat_voice" / "chat_intent")` |
| `agent/src/turn.ts:733-741` | gray-zone `fast` 檢查的 thinking |
| `agent/src/turn.ts:276-344` `#sentence` | 雙語:中文字幕先寫、`<voice>` 日文後寫,整對寫完才送 TTS → 先寫 `<voice>`,寫完立刻送(§3.9 延遲) |
| `agent/src/turn.ts:923`、`agent/src/config.ts:265` | `history_after_fold` 10 → 25 |
| `agent/src/config.ts:252` | 文字 debounce 1500 → 800 |
| `agent/src/turn.ts:562`、`agent/src/runtime.ts:421`、`:517` | 發 `agent_decision` 的三處;回合結束時另發 `agent.turn.outcome`(不要改 `DecisionTrace`) |
| `agent/src/turn.ts:1339` `#toolSpecs` | 工具依 `ActivitySnapshot.activity` 限定(§3.4);**階段 0 item 9 不在這裡修**(W3 在 ext-host 源頭擋) |
| `agent/src/turn.ts:126` `CLAIMS` | 用正則抓她說的話判斷有沒有做動作 → 改看 `TransitionResult` / notice(W3 之後) |
| `agent/src/turn.ts:1446` | 發 `agent.emotion`(Stage 表情要用,照發;回寫心情的是 W4 的 `social/src/mood.ts:294`) |
| `agent/src/signals.ts:74-78`(冷淡/普通/親近)、`:136` `moodHint` | 第二、三套刻度與第二個心情 renderer → `relationshipLabel()` 與 `AffectSnapshot.mood_line` |
| `llm/src/module.ts:78`、`llm/src/router.ts:171` `#thinkingFor` | `[llm.thinking]` 開關 → `[llm.reasoning]` 等級;舊 key 先保留當 fallback(`true` 視為 `medium`)|
| `core/src/recorder.ts:88` | 目前只把 `agent_decision` 寫進 decision log;追加 `agent.turn.outcome` 的紀錄(store 需要的方法請 W5 加,見 W5) |

**單一 renderer(item 18)**:W1 的編譯器直接從服務 render `SELF_BLOCK_KEYS`(心情、在做什麼、方針、議程、Ledger、notice);「在場的人」由 W1 render 成**一個** data 段落(每人一行:handle、`relationshipLabel`、她的感覺一句)。現有 contributor 中跟它重複的(key `mood` — `social/src/mood.ts:426`;`emotion`、`self` — `self/src/prompt.ts:128`、`:48`;`social` — `social/src/prompt.ts:9`;`world` 裡她自己的狀態)由 W1 在編譯器裡**忽略**(列在 agent 自己的 superseded 清單),W4 之後再刪掉那些 contributor。

### W2 Voice(barge-in、ducking、回音排除、TTS 預取、唱歌 / GPU)

**擁有**:`packages/voice/**`(**除了** `packages/voice/src/actions.ts`,那是 W3 的)、`apps/voice-node/**`、`docs/protocols/voice-link.md`;需要時可改 `packages/sing` 裡 `VoiceFloor` / `SpeechPause` 的提供端(只限那部分)。

**提供**:選擇性 barge-in;topic `voice.barge_in`(新增在 `packages/voice/src/topics.ts`,payload `{context, turn, account, action: "duck"|"pause"|"resume"|"stop", reason}`;W1 用它把 `TurnOutcome` 記成 `cancelled{cause: "barge_in", by}`;如果要跨套件共用型別,在 `packages/types/src` 新增檔案);voice link 的 duck / resume 訊息。

**消費**:`TurnFocusViewKey.current(voiceContext)`(`addressed_accounts` = 該停的人;拿不到就維持現在的行為,但先改成 duck);`isShortReply()`(ASR 回來是短回應就不停)。

| 要改的地方 | 現況 |
|---|---|
| `voice/src/listen.ts:120` | 每個 frame `barge.observe(guild, speechRunMs)`,不看是誰 → 帶上說話者 account |
| `voice/src/barge.ts:47-55` `observe` | 任何人連續 `barge_in_ms` 就 `stop` → 只有 focus 的人 / 叫她名字 / ASR 實質內容才停,其他人先 duck;被打斷先 pause,不是在跟她說話就 resume |
| `voice/src/config.ts:38` | `barge_in_ms` |
| `voice/src/listen.ts` `#transcribe` | 回音排除:轉錄是 ASR 提示詞回音(「御坂10514號…」)或她自己的聲音就丟掉、不算有人講話 |
| `voice/src/sink.ts:168-178` | 唱歌(`VoiceFloor`)或 GPU 借出(`SpeechPause`)時直接回 `"interrupted"` 丟掉整輪 → 等 / 延後,或回報明確原因(`SpeakOutcome` 要加成員就照 §0 尾端追加) |
| `voice/src/sink.ts:146` `prepare` | TTS 預取:下一句在上一句播放時就先合成 |
| `apps/voice-node/src/playback/` | duck / pause / resume 的實作 |

**整合**:W1 負責「語音已生成未播放就照播、不重生成」(coordinator);W2 負責「播放中被誰、怎麼打斷」。兩邊的交界是 `voice_playback`(既有)+ `voice.barge_in`(新)。

### W3 Activity(ActivityManager、任務契約、閘門缺口)

**擁有**:新 `packages/activity/**`、`packages/stage/**`、`packages/game/**`、`packages/actions/**`、`packages/sdk/**`、`packages/ext-host/**`、`packages/voice/src/actions.ts`;`packages/world/src/engine.ts` 的 `her()`(`:475`)改成讀 `ActivitySnapshot` 的 hunk;`core/src/modules.ts` 加 `ActivityModule` 一行。

**提供**:`ActivityManagerKey`、topic `activity.*`、`agent.notice`(`Notice`)、場景 = `f(snapshot, override)`。

**消費**:`ArbiterKey.record()`(有就寫 Ledger,沒有就只發 topic)、`task.ts` 契約(遊戲 adapter 先用 `TaskEvent` 包現有的事件)。

**階段 0**:9、10、16、17。

| 要改的地方 | 現況 |
|---|---|
| `ext-host/src/extension.ts:500-516`、`sdk/src/game.ts:131-140` | extension 的 `game.<id>.observe` / `.act` 直接進 `ToolRegistry`,聊天回合全部拿得到(`agent/src/turn.ts:1339`)→ 不登記給聊天用,只透過 capability、過閘門(item 9) |
| `ext-host/src/extension.ts:74` `RESERVED_PREFIXES` | 加上 `activity`、`arbiter`、`affect`、`plan`(`V2_TOPIC_PREFIXES`),否則有 `events` 權限的 extension 可以偽造 v2 事件 |
| `actions/src/registry.ts:137` `abortable()` | 只停止等待,ticket 還在排程器裡照跑 → 工具逾時 / 回合取消時取消 ticket(item 10;W1 的 `turn.ts:1377` 已經把 signal 傳進工具) |
| `actions/src/tools.ts:88-98` | 高風險工具回 `REVIEW_PENDING` 後結果只寫 log → 結果變成 `Notice` |
| `actions/src/followup.ts:102` | 直接發 `agent_initiative`(W6 之後改 Impulse,見 §3) |
| `voice/src/actions.ts:225` | `goliveStart` 送出就回「Go Live started」→ `ensure_live` task,結果走 `activity.done/failed` |
| `voice/src/actions.ts`(`voice.join` / `voice.leave`) | join 不是 idempotent(已在語音時會換頻道);leave 不先收 broadcast |
| `stage/src/link/director.ts:62-89` | 她在做什麼的第一份副本(golive、obsStreaming、playing、game、singing…)→ 讀 `ActivitySnapshot` |
| `stage/src/link/director.ts:312`、`:393`(`#expect`)、`:357-368`(`#busy`) | `#expect` 在 `#busy` 保護外被寫,她自己切的被當成手動切換 → 場景切換 mutex(item 17) |
| `stage/src/obs.ts:463` `setScene` | 先改 OBS 的**全域**轉場 → 轉場每次切換帶入(item 17) |
| `stage/src/link/module.ts:246`、`:257` | OBS 跟著 Go Live 開關,沒過閘門 → broadcast 狀態機的子步驟 |
| `game/src/director.ts:384-386`(`#voices`、`#session`)、`game/src/chat.ts:164`、`game/src/module.ts:166`(`LiveState`,`game/src/live.ts:9`) | 其他副本 → 讀 `ActivitySnapshot` |
| `game/src/director.ts:810-821`、`:886-887` | `game.<id>.*` 事件進 `#onGameEvent`;`disconnected` 落到 `default` 只變成一句評論,session 不收尾 → `activity` 進 `failed(disconnected)`、場景切回(item 16) |
| `game/src/director.ts:850-856` | 用事件名稱 + `settle_secs` 猜目標完成 / 失敗 → `TaskEvent`(完整收斂是 W8) |

**狀態機注意**:`presence` 只有一份(她的語音帳號同時只能在一個語音頻道),但現有 capability 參數都以 guild 為單位(`voice/src/actions.ts` 的 `GuildArgs`);跨 guild 的 `ensure_voice` = 先離開再加入。

### W4 Affect(驅力、情緒動態、一人一卡)

**擁有**:`packages/self/**`、`packages/social/**`;例外:可改 `mind/src/mind.ts:963-969`(mind 直接 `self.feel`)與 `mind/src/prompt.ts:145-149`(`OUTPUT_FORMAT` 的情緒 / 驅力範例值)這兩個 hunk,做 item 14 的「mind 不再寫情緒」部分。

**提供**:`AffectStateKey`(由 `self` module 提供,跟 `SelfStateKey` 並存;`SelfState` 先保留給舊消費者)、`PersonCard`、`relationshipLabel()` 的實際使用(`social/src/rel.ts:308` `label()` 改成呼叫它)、topic `affect.changed`。

**消費**:`HandleDirectoryKey`(卡片的 `handle`)、topic `affect.event`(Arbiter 的 `topic_ignored` 等)、既有 topic:`social.event`、`social.appraisal`、`sing.cue`(`ended` → `song_finished`)、`voice_playback`(`interrupted`)、`activity.done/failed`(`task_succeeded/failed`)。規則事件能從既有事件推導的就自己訂閱,不要求別人改。

**階段 0**:15(以及 14 的情緒部分)。

| 要改的地方 | 現況 |
|---|---|
| `self/src/emotions.ts:142` `stir` | 飽和加法、沒有遞減 → habituation(2 小時內同原因 ×0.5ⁿ)、互斥(壓下量 = 一半)、10 分鐘總量預算 |
| `self/src/emotions.ts:195` `feel`、`self/src/state.ts:96`、`:103` | 唯一寫入路徑改成 `appraise(AffectInput)`;`feel` 先保留但走同一套動態 |
| `self/src/rules.ts:139` `EmotionRules` | 規則事件表(§3.6) |
| `social/src/mood.ts:294-299` | `agent.emotion`(她的 `<emo>` 標籤)回推心情 → 刪掉(切斷閉迴路) |
| `social/src/mood.ts:314` `describe`、`agent/src/signals.ts:136` `moodHint` | 兩個心情 renderer → `AffectSnapshot.mood_line`(agent 那份由 W1 換) |
| `social/src/rel.ts:308` `label`(與 `social/src/engine.ts:828`、`:1047`、`:1081`、`social/src/commands.ts:282`、`:327`) | → `relationshipLabel()` |
| `social/src/engine.ts` familiarity | 一天 +1 → 依互動量與深度 |
| `self/src/heart.ts`、`self/src/feelings.ts` | romance / hearts / feelings → `PersonCard.attachment`、`emotions`、`feeling` |
| contributor:`social/src/mood.ts:499`、`social/src/module.ts:149`、`self/src/module.ts:224` | W1 的編譯器接手後刪掉(先別刪,W1 會忽略它們) |

### W5 Memory / Learning(新鮮度、followup 到期、穩定 handle + migration)

**擁有**:`packages/memory/**`、`packages/store/**`(含 `packages/store/migrations/**`)、`packages/learning/**`;`core/src/boot.ts:187-203` 追加 `HandleDirectoryKey` 的 provide;例外:`mind/src/snapshot.ts:285`(people 的 `u${n}` ref)與 `mind/src/mind.ts` 對應的 ref 解析(`:923`、`:1051`、`:1161`)這幾個 hunk。

**提供**:`HandleDirectory` 實作(store 一張表或 `ProfileDataStore` key,開機時 provide);`DecisionLog` 上 W1 需要的 outcome 寫入方法(新增 optional 方法,W1 用 `?.` 呼叫);migration。

**消費**:`ephemeralHandlesIn()`(寫入 lessons / recap / knowledge / 記憶前驗證)。

**階段 0**:6、13;以及 item 3 的「style lesson 不再轉成 `talk` 偏移」(在 learning 裡)。

| 要改的地方 | 現況 |
|---|---|
| `learning/src/conversation.ts:288` | fold 每次重編 `u1, u2…` → handle |
| `learning/src/reflect.ts:350`(與 `:356` 的 `p${n}`) | reflect 每次重編 → handle;place 代號也不能寫進持久資料 |
| `learning/src/drafts.ts:98-111`、`learning/src/conversation.ts:407`、`learning/src/reflect.ts:533` | 把模型輸出的 ref 解析回人;改成用 handle 解析 |
| `learning/src/reflect.ts:111` | prompt 範例 `"person": "u1 或 null"` |
| `mind/src/snapshot.ts:285` | mind 快照的 `u${people.length + 1}`(例外 hunk) |
| `learning/src/lessons.ts:28-29`、`:81` `talkShift` | lesson 的 `talk` 偏移;style 類 lesson 不再轉 `talk` |
| `memory/src/config.ts:97` `min_score` 0.05 → 0.25;`:12` `recency`、`:100` `recency_tau_days` 14 | §3.9 新鮮度;episode 改小時~天的衰減 |
| `memory/src/engine.ts:455-465` | 在場的人的記憶不需要文字相關就入選 → 要文字相關 |
| `store/src/sqlite.ts:970-977`、`store/src/postgres.ts:1022` `dueFollowups` | 沒有年齡上限、`ORDER BY due ASC` 先挑最舊 → 到期幾小時後自動關、先挑最新 |
| 記憶寫入(`memory/src/extract.ts`) | 現在式的狀態 / 承諾筆記(「已經開台」)設到期 |
| learning 的 conversation 狀態 | 「已淡出的話題」不放進 prompt(prompt 端由 W1 不 render,資料端由 W5 不產生) |

**Migration**:一次性修掉已污染的 lessons、recap、議程(`self:state` 裡的 agenda 文字;那個 key 屬於 W4 的 self module,migration 只改文字欄位、不改形狀,PR 裡要寫明)。無法確定是誰的 `u7` 一律刪掉該句,不要猜。

**實作紀錄(W5)**:

- `HandleDirectory`:`StoredHandleDirectory`(`store/src/handles.ts`),一人(帳號)一列存在節點層級的 settings(`_global` 的 `handle:<platform>:<id>`,資料分類 `people`);`boot.ts` 開機時載入並 provide,`recorder` 第一次看到帳號時就定下 handle。`ofAccount()` 多一個可選的 `person` 參數(`types/src/handle.ts`)。同名只有第二個人加 `#2`,大小寫不同也算同名。
- 不再寫入臨時代號:conversation fold、reflect、mind 快照(`u${n}` → handle,`personByRef` 另外容許同一份快照裡的舊 `u<N>`,只在解析時用,不會存);fold 的 recap / notes、reflect 的 summary / insight / feeling / lesson / goal、記憶的 episode / fact / note / followup、知識文件的 draft 寫入前都過 `repairHandleText`(`types/src/handle-text.ts`):同一段文字裡有定義(`u1=御坂`、`御坂(u1)`)就換成名字,lesson 只剩一個代號時用 `person` 的 handle,其餘整句刪掉;什麼都不剩就拒絕寫入。地點(`p1`)改成直接用 context 字串。
- Migration:`repairEphemeralHandles`(`learning/src/repair.ts`)修 lessons、對話 recap / notes、`self:state` 的 `agenda[].text / why`(只改文字,不改形狀;議程的 `person` 欄位不可信,所以不拿它來猜代號,剩下的代號換成「某人」)。冪等。`ModuleCatalog.migrateStoredData` 在 `boot.ts` 載入 handle 之後、任何 module 啟動之前呼叫(module 啟動後會把舊文字存回去)。
- 新鮮度:`min_score` 0.25;記憶要有共同的字或 `min_vector`(0.3)以上的 embedding 才算相關(在場的人也一樣);episode 用 `episode_recency_tau_days`(1.5);現在式的 fact / self_note 用 summarizer 給的 `valid_hours` 或字面判斷(已經開台、正在…)設到期,存在 `due`(**非 followup 的 `due` 是失效時間**,recall 跳過,maintenance 刪除過期一週以上的);followup 到期 `followup_max_age_hours`(6)後自動關閉、先挑最新、查詢帶年齡上限;最近 `repeat.window` 個回想裡同一個梗超過 `allowed` 次就降權。
- 對話筆記:改寫不會更新年齡(`touchUnits` 依同一欄位 / 清單的相似度繼承舊時間),所以過期過濾真的生效;`drop_thread_mins`(240)沒人碰的就由 fold 直接刪。**這份程式裡找不到把「已淡出的話題」放進回合 prompt 的地方**(`render` 本來就不放過期的);fold 輸入裡「超過 N 分鐘沒人提的部分」仍保留,它是整理用的,不是回合 prompt。
- Style lesson:只有內容本身在講話多話少(`isTalkLesson`)的 lesson 才會有 `talk` 偏移;`panel` 來源的照設定。
- 回合結果:`DecisionLog.appendOutcome?` / `recentOutcomes?`(表 `turn_outcomes`,migration 0005,sqlite + postgres),`recorder` 訂閱 `agent.turn.outcome`。

### W6 Arbiter(第二波;§3.3)

**擁有**:新 `packages/arbiter/**`;刪除 `packages/initiative/**`;下面列的發 initiative 的 hunk;`core/src/modules.ts` 換掉 `InitiativeModule`(`:126`)。

**提供**:`ArbiterKey`、topic `arbiter.*`、`affect.event` 的 `topic_ignored`。

| 要改的地方 | 現況 |
|---|---|
| `sing/src/singer.ts:884`、`game/src/director.ts:1034`、`actions/src/followup.ts:102`、`initiative/src/engine.ts:51` | 直接發 `agent_initiative` → `Impulse`(source `song` / `game` / `followup` / `world`) |
| `mind/src/mind.ts:381-383` | `initiative:*` 回合(報幕)被算成她主動開的話題 → `isSelfInitiated(source)`(item 12) |
| `agent/src/coordinator.ts:302-345`、`agent/src/runtime.ts:392` `startBlocked` | agent 裡的第二、三道關卡 → 併進 Arbiter(跟 W1 約好再刪) |
| `initiative/src/config.ts:58`、`:64`、`mind/src/config.ts:51-52` | 兩套安靜時段 → 一份 |
| `world/src/engine.ts:435`(`channel_quiet`)、`mind/src/mind.ts` `voice_quiet`(`:569-595`)、initiative 的 idle 偵測 | 三個冷場偵測器 → 一個 |
| `agent/src/attention.ts` 的乘數、`agent/src/turn.ts:619` `#decide` | 只留便宜前置過濾;灰色區才問 fast |

Arbiter 接受 `speak` impulse 後,開回合仍走既有的 `agent_initiative` 事件 / `IntentSinkKey`(不另開新路徑);接受 `act` impulse 後呼叫 capability(活動類走 `ActivityManagerKey.request`)。

### W7 Mind → Appraise / Plan / Reflect + Goal agenda(第二波;§3.4、§3.7)

**擁有**:`packages/mind/**`(W4、W5 的例外 hunk 合併之後)。

**提供**:`GoalAgendaKey`、topic `plan.goal`、Appraise 的 `AffectInput`(呼叫 `AffectState.appraise`)、Plan 的 `Impulse`(source `plan` / `agenda`)。

| 要改的地方 | 現況 |
|---|---|
| `mind/src/mind.ts:657` | `agendaDue` 把 `due === null` 當到期,心跳被釘在 3 分鐘(`mind/src/pace.ts:38`)→ `goalDue()`(item 11) |
| `mind/src/mind.ts:421-427` `GAME_EVENT` | 任何 `game.<x>.*`(含 `disconnected`)都當成遊戲在跑 → 讀 `ActivitySnapshot` |
| `mind/src/prompt.ts:263` | 「乾脆離開去休息」催促(item 14) |
| `mind/src/prompt.ts` system | 整份聊天人設 + god prompt → 三個專用短 system(reasoning:`appraise` / `plan` / `plan_daily` / `reflect`) |
| 快照 | 加上 `LedgerView.limits`(她看得到 backoff 與限制) |

### W8 遊戲 / extension 任務契約(第二波;§3.8)

**擁有**:`packages/sdk/**`、`packages/ext-host/**`、`packages/game/**`、`extensions/**`(W3 合併之後)。SDK 不依賴 `@miyoria/types`,`task.ts` 的形狀要在 `sdk/src` 帶一份相同的副本(JSON 形狀一致,有測試對照)。Extension 的 task 事件發在 `game.<id>.task.<type>`(`taskTopic("game.<id>", …)`,在 game adapter 自己的命名空間內);ext-host 的 proxy 實作 `TaskExecutor`,`cancel` 與 `AbortSignal` 要一路傳到 RPC。

## 3. 跨工作流整合

**誰發 Impulse(W6 之後)**:收到訊息(agent,source `message`)、Plan / 議程(W7,`plan` / `agenda`)、followup(memory 與 `actions/src/followup.ts`,`followup`)、activity 結果(W3,`notice`)、遊戲評論(game director,`game`)、唱歌報幕(sing,`song`)、上線打招呼(world,`world`)。只有 `plan` / `agenda` 算她主動。W6 之前大家照舊發 `agent_initiative`;W6 逐一改掉上面 §2 W6 表裡的發送點。

**W1 怎麼 render 黑板**:每回合從服務直接讀(不要經過 contributor):`AffectState.snapshot()` → `self.mood`(`mood_line` + `top`);`ActivityManager.snapshot()` → `self.activity`;`Arbiter.ledger(context)` → `self.ledger`(含 `limits`,例如「今天主動 5 次,最近 3 次沒人接,下次 21:40 之後」);`GoalAgenda.goals()` → `self.goals`;未讀的 `Notice` → `self.notices`。這些都進**可信的 system 區塊**;人物卡的感覺文字、記憶、遊戲聊天進 data 區塊。服務不在時用 §2 W1 列的 fallback。

**語音 barge-in 怎麼知道這回合的 focus**:agent 在回合狀態改變時更新 `TurnFocusView`(並發 `agent.turn.focus`);voice 在 VAD / ASR 熱路徑上同步呼叫 `ctx.services.get(TurnFocusViewKey)?.current(voiceContext)`,比對說話者是否在 `addressed_accounts`;ASR 結果用 `isShortReply()` 判斷是不是實質內容。voice 不需要訂閱任何 agent 事件。

**取消的規則只有一份**:`inputDisposition()`(`turn.ts`)。W1 的 coordinator 用它決定 merge / restart / background;要調整規則就改那個函式和它的測試,不要在 coordinator 裡另外加條件。

**Notice 的路徑**:W3 發 `agent.notice`(帶 `turn`、`context`)→ W1 在下一個回合的 `self.notices` 顯示;如果問的那個回合已經結束、她也沒在講話,W6 之前 W1 自己用既有 initiative 路徑(reason `notice`)開一個短回合,W6 之後改成 `Impulse{source: "notice"}`。

**工具與 Activity**:聊天回合的工具清單 = 一般工具 + 依 `ActivitySnapshot.activity` 加上的 capability 工具(例如在 `game(minecraft)` 時才有遊戲的「目標」工具);extension 的原始工具永遠不進聊天(W3 在 ext-host 擋)。`game.start` 之類的工具立刻回 `TransitionResult`(「開始了,task 7」),不等 240 秒。

**情緒的輸入**:只有 `AffectState.appraise()`(Appraise / Reflect,W7 之前由 social appraisal 轉送)與 `affect.event` 規則事件。mind 不寫情緒(W4 的例外 hunk);`<emo>` 不回寫(W4)。Plan 讀 `AffectSnapshot.biases` 與 W7 算的 `Desire[]`。

**Handle**:寫入持久資料前一律 `ephemeralHandlesIn(text).length === 0`;prompt 裡給模型的人一律用 handle(同一個人每次一樣),模型回來的 `person` 用 `HandleDirectory.resolve()` 解析。`GoalTrigger.when_online.person`、`ImpulseTarget.person`、`AppraisalEvent.toward`、`TurnFocus.addressed_by` 都是 handle。

**推理等級**:W1 在 llm 加 `[llm.reasoning]` 與 request 層級的 reasoning purpose;其他模組的呼叫(memory 整理 = `summarizer`、social appraisal → 之後的 `appraise`、高風險審核 = `review`、mind → `plan`)在各自工作流改成帶 purpose。舊的 router purpose(`chat`、`fast`、`mind`、`review`、`summarizer`,`[llm.purposes]`)是**模型鏈**,跟 reasoning purpose 是兩件事。

**建議的合併順序**:types(本 commit)→ 第一波 W1–W5 任意順序(都有 fallback)→ W6 → W7 → W8。第一波合併後跑一次全部測試,再開第二波的 worktree。
