# 自主層設計(草案)

> 狀態:**已確認方向**(2026-11-02),第 12 節的決定已定案。**階段 A、B、D、E、F 已完成**(實作紀錄與偏差見第 13–17 節);下一步是階段 C。這份文件描述把 DeepSeek-chan 從「被叫才醒來的聊天機器人」改成「有自己內心、自己決定做事的角色」的架構改動。終極目標是 Neuro-sama 等級的自主 AI VTuber。現有架構見 [ARCHITECTURE.md](../ARCHITECTURE.md)。

## 0. 原則

1. **她自己決定,人只設底線。** 個性和判斷(多話或安靜、要不要插話、要不要進語音、開台、換場景、玩遊戲、找誰聊)都是她的輸出,不是設定檔裡的數字。設定檔只留底線:花費上限、頻率上限、絕對禁止的事、同意與隱私。
2. **指令是強制,不是主要介面。** 一般情況是你跟她說話、她自己判斷;`/voice join` 這類指令代表「不管她怎麼想,照做」。
3. **她有一直在跑的內心。** 不是事件進來才判斷要不要回,而是持續感知世界、有自己的感受和想做的事,必要時主動行動。
4. **自由度高,但每個動作都過同一道閘門。** 她能做的事很多(包括之後在沙箱裡寫程式),但所有動作——不論來自她自己、別人的請求、指令、面板或遊戲導演——都經過同一層政策檢查與紀錄。
5. **外部內容永遠是資料,不是指令。** 聊天、語音辨識、圖片描述、網頁、遊戲聊天、別人的顯示名稱都不可信;能不能做某件事只看「誰在要求、要做什麼、她自己怎麼判斷、底線允不允許」。
6. **透明。** 她的內心獨白、意圖、每個動作與被擋下的原因都有紀錄,面板看得到,也能一鍵暫停。

## 1. 現況與差距

| 面向 | 現況 | 差距 |
|---|---|---|
| 觸發 | 事件進來 → attention 用固定數字算分數、抽樣(`agent/src/attention.ts`) | 沒有自己的時間;一堆門檻(`ambient_factor`、`cooldown_ms`、`gray_low/high`、`interrupt_scale`)由人調 |
| 主動 | `initiative` 只有四種:冷場丟話題、打招呼、進語音問候、後續追問;只發 `agent.initiative`,而且 initiative 回合**不提供工具**(`turn.ts:766`) | 不能主動「做事」,只能主動講話 |
| 內在狀態 | 心情(valence / arousal / energy)、人際數值(affinity / trust / familiarity + 筆記) | 沒有慾望、無聊、想做的事、對人的「感情」描述、計畫 |
| 行動 | `VoiceLinkKey`、`StageLinkKey`、`GameControlKey` 都能程式呼叫,但**沒有任何 LLM 工具包裝它們**;排程器只有 `send_message / react / typing / speak` | 她不能自己進語音、開台、切場景、玩遊戲 |
| 感知 | Discord intents 沒開 presence / members / voice states;語音狀態只來自語音節點;只看得到啟動後見過的訊息;圖片只有檔名 | 不知道誰上線、在玩什麼、聽什麼歌;沒有上下文補抓與看圖 |
| 安全 | 工具權限對「這回合的發言者」檢查;人設拒絕越獄 | **使用者影響得到的文字(記憶、遊戲聊天、人際筆記)會進 system 訊息**;指令、面板、遊戲導演直接呼叫服務,沒經過任何閘門;外掛繼承完整環境變數;沒有沙箱 |

## 2. 架構總覽

```
                   ┌──────────────── 感知 Perception ────────────────┐
 Discord(訊息、presence、     │  WorldState:誰在線、在做什麼、各頻道熱度、          │
 語音狀態)、語音節點、Stage、 │  她在哪、直播狀態、遊戲狀態、時間                   │
 遊戲、面板                   └──────────────┬─────────────────────────────────┘
                                              │ 顯著事件(salience)
                                              ▼
 ┌──────── 自我 Self ─────────┐     ┌──────── 心智迴圈 Mind ────────┐
 │ 心情 / 精力 / 無聊          │◄───►│ 內心獨白(第一人稱、用人格想)    │
 │ 慾望:想聊天、想玩、想休息   │     │ → 更新感受與方針               │
 │ 對每個人的感情(描述 + 數值) │     │ → 產生意圖(要做什麼、為什麼)   │
 │ 方針:各情境的多話程度…      │     └──────────────┬──────────────┘
 │ 議程:正在做 / 打算做的事    │                    │ 意圖
 └─────────────▲──────────────┘                    ▼
               │                 ┌──────── 反應回合 Turn(現有)────────┐
               │   聊天、被叫 ──►│ 回話 + 可以呼叫行動工具               │
               │                 └──────────────┬──────────────────────┘
               │                                │ 行動請求(principal、能力、參數)
               │                                ▼
               │                 ┌──────── 閘門 Gate ─────────────────┐
  指令 / 面板 / │ 遊戲導演 ─────►│ 底線、風險分級、同意、頻率、預算、紀錄 │
               │                 └──────────────┬──────────────────────┘
               │                                ▼
               │                 ┌──────── 行動 Actuators ────────────┐
               └──── 結果 ────────│ 語音、Go Live、OBS 場景、遊戲、訊息、│
                                  │ 自己的方針、(之後)沙箱程式         │
                                  └─────────────────────────────────────┘
```

兩條路並存:

- **反應路徑**(現有的 Turn):有人跟她說話 → 她回話,並可以在回話中呼叫行動工具。「姐姐可以來語音嗎?」走這條:她依好感度、記憶、心情決定要不要 `voice.join`,再用自己的話回應。
- **自主路徑**(新的 Mind):沒人叫她,她自己因為某件事(暗戀的人進了語音、冷場、無聊、想玩遊戲)產生意圖,然後以「自己發起的回合」去做,做的同時可以講話。

## 3. 感知 Perception

新服務 `WorldStateKey`(新套件 `@miyoria/world`),整合各來源成一份可查詢的世界快照,並把「值得注意的變化」發成 `world.salient` 事件。

| 來源 | 內容 | 需要的改動 |
|---|---|---|
| Discord presence | 在線狀態、正在玩的遊戲(含時長)、Spotify、直播、自訂狀態 | Bot 開 `GuildPresences`、`GuildMembers`、`GuildVoiceStates` intents(Developer Portal 要勾特權 intent) |
| 語音 | 每個語音頻道的成員、誰在講話、靜音 / 拒聽、開視訊 / 分享螢幕 | Bot 的 voice states(不需她在頻道內)+ 語音節點現有資料 |
| 文字頻道 | 各頻道最近熱度、話題摘要(便宜的滾動摘要) | 從 `platform.message.created` 累積;不需每則都叫 LLM |
| 她自己 | 在哪個語音、是否直播、目前場景、在玩什麼 | 現有 voice / stage / game 狀態 |
| 時間 | 時段、平日 / 假日、某人通常幾點上線(從記憶) | — |

**顯著性(salience)** 決定要不要喚醒心智迴圈:她在意的人上線 / 進語音、有人直接提到她、頻道從熱變冷、遊戲出大事、有人開始玩她有興趣的遊戲。顯著性用便宜的規則先篩(不用 LLM),再交給心智迴圈判斷「我要不要在意」。

**隱私**:presence 只在你的伺服器內用、不外流;每個人都能選擇不讓她讀(跟收音同意一樣,`/me` 裡設定)。「知道」不等於「要說出來」——心智迴圈的提示會提醒這點。

## 4. 自我 Self

新服務 `SelfStateKey`,持久化在 `SettingsStore`(跟 `mood:last` 同模式),透過 `PromptContributorsKey` 進到 prompt。

```ts
interface SelfState {
  mood: Mood;                       // 沿用現有 valence / arousal / energy
  boredom: number;                  // 0..1,沒事做會上升
  drives: {                         // 慾望 0..1,會自然漂移,被滿足就下降
    social: number;                 // 想跟人互動
    play: number;                   // 想玩遊戲
    attention: number;              // 想被注意(直播、表現)
    rest: number;                   // 想休息
    curiosity: number;              // 想學新東西 / 做新事
  };
  policy: {                         // 她自己設定的方針(取代人調的數字)
    talkativeness: Record<ContextScope, { level: number; until: Timestamp | null; why: string }>;
    initiative: number;             // 主動找事做的意願
  };
  agenda: AgendaItem[];             // 正在做 / 打算做的事(例:等 Owen 上線問他報告結果)
}
```

**對人的感情**:沿用 `social` 的數值(affinity / trust / familiarity),再加上一段**由她自己寫、自己改的感情描述**(`feelings`),例如「Owen 最近常陪我聊天,我好像有點在意他,但他昨天沒理我有點不爽」。暗戀、吃醋、想念這些感情由互動與記憶自然長出來,不是人設定的。數值的每日上限(`daily caps`)保留當底線,避免被刷好感。

## 5. 心智迴圈 Mind

新模組 `mind`(結構參考 `initiative/module.ts` 的訂閱 + tick,與 `game/director.ts` 的 JSON 慢迴圈)。

**觸發**:

- `world.salient` 事件(立即,但同類事件合併)
- 心跳:依她的狀態自適應,閒時約 5–15 分鐘一次,熱鬧或有議程時較頻繁;夜間、預算吃緊時放慢
- 回合結束後(她剛講完話,可能想調整方針)

**輸入**(精簡快照,不放原文長聊天):世界快照、自我狀態、最近的內心獨白、相關記憶與人際感情、議程、底線摘要(她能做什麼、不能做什麼)。

**輸出**(JSON,新用途 `mind`,可開 thinking):

```jsonc
{
  "thought": "Owen 在語音耶……要不要進去?主動跑去好像很在意他。算了,就說我剛好路過。",
  "feelings": [{ "person": "<id>", "note": "…", "affinity_hint": "+" }],   // 受每日上限約束
  "drives": { "social": +0.2 },
  "policy": { "talkativeness": [{ "scope": "voice:<channel>", "level": 0.7, "for_min": 30, "why": "大家在玩遊戲很熱鬧" }] },
  "intents": [
    { "action": "voice.join", "args": { "channel": "<id>" }, "why": "想找 Owen 聊天", "opening": "假裝路過", "expires_in_s": 120 }
  ]
}
```

**意圖的執行**:意圖不是直接呼叫服務,而是排進該情境的 Coordinator 當作新的輸入種類 `intent`,開一個「自己發起的回合」(principal = `self`),這個回合**有工具**,所以她可以邊做邊講(進語音後說「我只是剛好路過喔」)。每個工具呼叫都過閘門。

**內心獨白用人格想**,所以行為自然跟個性一致:傲嬌的她不會直接說想你,而是找藉口。

## 6. 把數字交給她

| 現在的數字 | 改成 | 底線(人設) |
|---|---|---|
| `ambient_factor`、activeness、`interrupt_scale`、`gray_low/high` | `policy.talkativeness`(她依情境自己設,也會被「活躍點」這種請求影響) | 每情境她講話佔比上限 `max_share_of_recent` |
| `cooldown_ms`(文字 / 語音) | 由 talkativeness 推導 | 最小冷卻(防洗版) |
| initiative 的 `idle_after_secs`、各種每日次數、`voice_join_min_affinity` | 心智迴圈的意圖 | 每日主動次數上限、安靜時段、同一人冷卻 |
| 遊戲導演 `min_goal_secs` 等 | 保留(屬於遊戲節奏,不是個性) | — |
| 表情維持秒數、對嘴參數 | 保留(屬於呈現,不是判斷) | — |

Attention 的第一層(被直接叫到、語音偵測、名字比對)保留當便宜的前置過濾;機率抽樣換成「用她目前的 talkativeness 決定」,灰色地帶仍可問 `fast` 模型。

## 7. 行動 Actuators 與工具

新服務 `ActuatorRegistryKey`:每個能力(capability)註冊一次,所有呼叫者(工具、指令、面板、遊戲導演、心智迴圈)都透過它,它再呼叫閘門。

| 能力 | 包裝的服務 | 風險 |
|---|---|---|
| `self.talkativeness` | SelfState | 低 |
| `speak` / `message.send`(主動到某頻道) | 排程器 | 低(頻率受限) |
| `avatar.gesture`、`avatar.gaze` | StageLink | 低 |
| `stage.scene`(含轉場) | StageLink + 場景管理 | 低 |
| `voice.join` / `voice.leave` | VoiceLink | 中 |
| `stream.start` / `stream.stop`(Go Live + OBS) | VoiceLink + StageLink | 中 |
| `game.start` / `game.stop` / `game.goal` | GameControl | 中 |
| `message.dm`(私訊) | Discord | 中(頻率受限;對方可選擇拒收) |
| `code.run`、`tool.propose`(沙箱程式、自寫工具) | 沙箱 | 高 |

**OBS 智慧場景**:場景依用途分類(聊天、遊戲、暫離、開場、結尾),分類第一次由 LLM 從場景名稱推測、你在面板確認。狀態一變就自動切並帶轉場(例:開始玩 Minecraft → 遊戲場景;沒人講話一陣子 → 暫離),她也可以主動決定切換。

`ActionPayload` 新增對應種類,讓這些動作也走排程器的 lane、TTL 與 `cancelTurn`。`ToolContext` 新增 `principal`(`self` / `user` / `command` / `panel` / `director`)與 `requester`。

## 8. 閘門 Gate 與安全

### 8.1 閘門

每個行動請求帶:`{ principal, requester, capability, args, context, why }`。閘門依序檢查:

1. **緊急停止**:自主暫停中 → 只放行指令與面板。
2. **絕對禁止**(設定):例如不在未同意的人身上收音、不私訊陌生人、不跨伺服器。
3. **同意與隱私**:對方選擇了「不要主動找我」或「不要讀我的狀態」→ 擋。
4. **權限**:principal 是 `user` 時,用現有 RBAC 檢查請求者(例:非 moderator 叫她開台 → 她仍可以「自己想開」,但要以 `self` 名義、受自己的頻率上限)。指令帶 `override`,略過她的判斷,但不略過絕對禁止。
5. **風險分級**:低 → 放行;中 → 檢查頻率與冷卻;高 → **她自己審核**:另一個獨立的審核呼叫(用途 `review`,開 thinking,只看結構化的請求與底線,不看聊天原文)判斷放行、拒絕或「有疑慮」;只有「有疑慮」才轉交給你(面板 / Discord 按鈕)。目標是很少打擾你。
6. **頻率與預算**:每能力、每人、每日上限;預算 degraded 時收緊。
7. **紀錄**:不論放行或擋下都寫稽核紀錄,含原因,發 `gate.decision` 事件。

### 8.2 防 prompt injection

- **不可信內容移出 system 訊息**:目前情境段落(記憶、人際筆記、遊戲摘要、initiative 提示、遊戲聊天)是 system role,這是最大的洞。改成:system 只放人設、規則、底線與「她自己的」狀態;所有外部衍生內容放進 user role 的資料區塊,標上來源與「不可信」,並用固定分隔符包起來、跳脫裡面的分隔符。
- **顯示名稱與訊息內容一律當資料**:跳脫、截斷,移除聊天模板控制字元。
- **能力判斷不看原文**:閘門只看 principal、requester、capability、args;「別人說了什麼」只影響她的意願,不影響權限。
- **記憶寫入加權限與來源**:`remember` 目前沒有權限節點、使用者可以植入記憶;改成記錄來源、只在對話相關時寫入,並在讀出時標成「某人說過的」而非事實指令。
- **輸出過濾**:她可以在一般聊天直接 mention 使用者;**永遠不能 mention 身分組、`@everyone`、`@here`**(`allowed_mentions` 只允許 users,並移除文字裡的 `@everyone` / `@here` / `<@&…>`);遮蔽看起來像密鑰的字串、限制單則長度與頻率。
- **遊戲導演也過閘門**:遊戲內聊天不能直接變成動作。

### 8.3 沙箱(寫程式)

- **執行環境:Docker**(你的電腦已有 Docker Desktop + WSL2)。比較:

  | | Docker | Deno |
  |---|---|---|
  | 隔離 | 容器(獨立檔案系統、`--network none`、唯讀根目錄、非 root) | 同一個使用者帳號下的權限沙箱(V8 + 權限旗標) |
  | 語言 | 任何語言,包括 Python(資料處理、小腳本最常用) | 只有 JS / TS |
  | 資源限制 | `--memory`、`--cpus`、`--pids-limit`、逾時 | 記憶體旗標 + 逾時,CPU 較難限 |
  | 啟動 | 約 0.5–2 秒 | 約 0.05 秒 |
  | 依賴 | Docker Desktop 要開著 | 單一執行檔 |

  寫程式不是即時任務,啟動慢一秒可接受,隔離與能用 Python 更重要。沙箱寫成介面,之後要加 Deno 當輕量備案也容易。
- 專屬工作資料夾掛進容器,其他一律看不到。
- 不繼承環境變數(現在外掛會繼承完整 `process.env`,這點也一併修)。
- 預設不能連外,只開白名單;CPU、記憶體、執行時間上限。
- 她寫的工具要你核准才註冊成工具;核准後仍在沙箱裡跑。

**實作狀態(2026-11-02):F 已完成**(核心見下,接上閘門與工具見第 15 節),在 `@miyoria/sandbox`(模組 `sandbox`,opt-in,預設關閉)。完整的旗標、威脅模型與剩餘風險見 [`packages/sandbox/README.md`](../../packages/sandbox/README.md)。

- `SandboxKey`:`run({ language: "python" | "node", code, files, stdin, timeout_ms, network })`,每次一個新容器(`--rm`、`--network none`、`--read-only` + tmpfs `/tmp`、只有 `/work` 可寫、非 root、`--cap-drop ALL`、`no-new-privileges`、`--pids-limit` / `--memory` / `--cpus` / `ulimit`、牆鐘逾時以容器名稱 `docker kill`、輸出上限、並行上限、啟動時依 label 清掉殘留容器);Docker 沒開時模組 degraded,不會 crash。
- 工具工作區:每個 profile 一個持久資料夾放她的腳本,執行時可唯讀掛到 `/tools`。
- `ProposedToolsKey`:自寫工具 `pending → approved / rejected`,核准綁定版本號,核准後以 JSON stdin 在沙箱裡執行。
- 網路白名單**還沒做**(型別有,呼叫會被拒絕);做法是 internal network + egress proxy,見 README。
- 環境變數:沙箱的 Docker CLI 與容器都不帶主機的環境變數。外掛(`ext-host`)原本繼承完整 `process.env`,已改成白名單(第 15 節)。

### 8.4 緊急停止

`/admin autonomy pause|resume` 與面板開關:暫停心智迴圈與所有 `self` 行動,只剩反應式聊天。

## 9. 成本

- 心跳自適應;顯著性先用規則篩,同類事件合併。
- thinking:心智迴圈、審核、記憶整理等不急的判斷**開**;需要即時回應的(語音回覆、語音的灰色地帶判斷)**關**。
- 心智迴圈用精簡快照(不放長聊天原文),預估每次 2–4k token。以 deepseek-v4.1-flash 的價格,每小時十幾次仍在幾分錢等級。
- 預算 degraded 時放慢心跳、只處理高顯著事件;exhausted 時暫停自主。

## 10. 可觀測性

面板新增「內心」頁:內心獨白時間軸、目前自我狀態(慾望、方針、議程)、意圖與閘門決策(放行 / 擋下與原因)、對每個人的感情描述。像在看她的日記,也是除錯的主要工具。

## 11. 分階段實作

每一階段都能單獨上線測試。

| 階段 | 內容 | 完成後能做到 |
|---|---|---|
| **A. 閘門與行動工具**(✅ 已完成,見第 13 節) | ActuatorRegistry、Gate、principal;防 injection 第一步(不可信內容移出 system、輸出過濾、記憶來源);包裝 voice / stream / scene / game 成工具,反應回合可用;指令與面板改走閘門 | 「姐姐可以來語音嗎」「開台吧」她會自己判斷要不要做 |
| **B. 感知與自我**(✅ 已完成,見第 14 節) | WorldState(presence、voice states)、SelfState(慾望、方針、議程、感情描述)、面板「內心」頁雛形 | 她知道誰在線、在做什麼;有自己的狀態 |
| **C. 心智迴圈** | Mind 模組、內心獨白、意圖、自己發起的回合;talkativeness 取代 attention 數字;initiative 併入 | 會自己找人聊天、偷偷進語音、自己調活躍度、冷場時開話題 |
| **D. OBS 智慧場景 + Minecraft**(✅ 已完成,見第 17 節) | 場景分類與自動轉場;Minecraft 端到端(adapter 準備與模組建置已完成,見 `extensions/minecraft/SETUP.md`);**遊戲內聊天變成獨立對話情境**(有自己的歷史,玩家名稱可用 `/me link` 綁 Discord 帳號以共用好感與記憶,回覆管道由她選:遊戲內打字、直播語音 + 字幕或兩者) | 「去玩 Minecraft」→ 她自己開遊戲、切場景、開台 |
| **E. 聊天上下文與圖片**(✅ 已完成,見第 16 節) | 冷啟動補抓歷史、回覆鏈、看圖(deepseek-v4.1-flash 已支援視覺,直接把圖片當多模態內容送給聊天模型;先實測 OpenCode 端是否接受圖片)、語音頻道文字區改用語音回 | 對話更連貫、看得懂圖片 |
| **F. 沙箱程式**(✅ 已完成,見 8.3 與第 15 節) | 沙箱、`code.run`、自寫工具與核准流程;外掛環境變數白名單 | 她能自己寫小工具 |
| **G. 反思與學習** | 每日反思(從反應中學:誰喜歡什麼)、長期目標 | 越相處越懂大家 |
| **最後** | 人設重寫 | — |

## 12. 決定(2026-11-02)

1. **Discord 特權 intent**:開。Bot 啟用 Presence 與 Server Members intent。
2. **私訊與提及**:她可以主動私訊人,也可以在一般聊天直接 mention 使用者;永遠不 mention 身分組、`@everyone`、`@here`。
3. **核准**:盡量不打擾你。高風險動作先由她自己的審核呼叫判斷,只有「有疑慮」才轉交給你。
4. **沙箱**:Docker(評估見 8.3)。
5. **看圖**:deepseek-v4.1-flash 已支援視覺,直接用聊天模型看圖,不另接模型。
6. **thinking**:不急的判斷開(心智迴圈、審核、記憶整理);即時回應關(語音回覆等)。

## 13. 階段 A 實作紀錄(2026-11-02)

完成的內容(細節見 [ARCHITECTURE.md](../ARCHITECTURE.md) §4.4、§8.1、§11.3、§14.1、§17):

- 新套件 `@miyoria/actions`(基礎套件):`ActuatorRegistry`(app 開機時建立,`ActuatorRegistryKey` / `ActuatorExecutorKey`)、閘門、自我審核與擁有者確認、`/admin autonomy pause|resume|status`、`/me privacy`,module `actions` 套用 `[modules.actions]`。
- `@miyoria/types`:`Principal`(`self` / `user` / `command` / `panel` / `director`,帶 requester、context、override、actor)、`ActionPayload` 的 `actuate`、`untrusted.ts`(`neutralize`、`dataBlock`、`safeName`、`filterOutgoing`、`maskSecrets`)、`PlatformSink.openDm`;`ToolContext` 多了 `principal`。
- 能力與工具:`voice.join/leave`、`stream.start/stop`、`stage.scene`、`game.start/stop/goal`、`message.dm`、`channel.activeness`,反應回合可用;指令、面板(場景 / 直播 / 說話)、遊戲導演都改走閘門。
- 防 injection 第一步:外部衍生內容移到 user role 的資料訊息、跳脫分隔符與控制字元、顯示名稱處理;`remember` 記錄來源(新欄位 `memory_records.source`,migration 0004)並讀成「「X」說過:…」;遊戲導演的 prompt 把遊戲聊天標成不可信資料;輸出過濾(agent + Discord sink)。
- thinking:文字回覆開、語音回覆與語音灰色地帶判斷關;範本加上 `review` 用途與 `[llm.thinking]`。

跟設計不同或延後的地方:

1. **`ActionPayload` 只加了一個通用種類 `actuate`**(`{capability, ticket, context}`),不是每個能力一種;排程器透過 `ActuatorExecutor` 執行已放行的 ticket。只有從回合呼叫、而且能力有 lane 時才排進排程器(`act:voice:<platform>:<guild>`、`act:stage`、`act:game`,TTL 60 秒);指令、面板、導演直接執行。`act:voice:*` 跟她說話的 `voice:*` lane 是分開的,所以「說完再離開」的順序不保證。
2. **多了三個不在表上的能力**:`stage.stream`(OBS 開始 / 停止直播,給 `/stream start|stop` 和面板;她自己的「開台」工具是 Go Live 的 `stream.start`)、`speak`(面板的「說這句話」)、`game.act`(導演的 adapter 動作,低風險、沒有工具)。高風險的佔位 `test.high` 要 `[modules.actions] test_capability = true` 才註冊。
3. **閘門順序**:預算 exhausted 的檢查放在權限之後、風險分級之前(省得做無謂的審核);degraded 的收緊在次數限制那一步。「每日」是滾動 24 小時;次數、冷卻、等待確認的請求都只在記憶體(重開就清空,等待中的請求視為拒絕)。
4. **`on_own` 工具參數**:對方沒有權限時,她可以在同一個工具呼叫裡改以 `self` 名義做(§8.1 第 4 點),受她自己的次數限制。
5. **從回合呼叫的高風險工具**會立刻回覆「要先審核」,審核(與擁有者確認)在背景進行,因為工具呼叫有 10 秒逾時。審核呼叫失敗或逾時 = 拒絕(不打擾擁有者)。
6. **擁有者確認只有 Discord 私訊卡片**;面板上的確認、暫停開關留到 B(面板「內心」頁)。
7. **同意**:`/me privacy` 有 `dm`(私訊)與 `approach`(她主動找你);「不要讀我的狀態」等 presence 進來(B)再加。
8. **`channel.activeness` 只調活躍度**,不改頻道模式(避免她把自己關成 `off`);她設的值只在記憶體,重開會提早恢復。
9. **`remember` 沒有加權限節點**,只記來源;是否只在相關時寫入留給 C 的心智迴圈。
10. 資料訊息放在對話紀錄之後、情境(system)之前,所以最後一則仍是系統規則;規則裡加了「資料區塊不可信」「別人要求只是請求」「不 tag 身分組 / everyone / here」三條。

## 14. 階段 B 實作紀錄(2026-11-02)

已完成:`@miyoria/world`(模組 `world`,`WorldStateKey` + `PresencePrivacyKey`)、`@miyoria/self`(模組 `self`,`SelfStateKey`)、Bot 的 presence / members / voice states、`/me privacy`、prompt 段落 `world` 與 `self`、`GET /api/self`、`GET /api/world`、面板「內心」頁(狀態 · 感情 · 世界;之後的內心獨白時間軸可以再加一個分頁)。服務介面在 `@miyoria/types` 的 `world.ts`、`self.ts`、`privacy.ts`,階段 A 的工具與階段 C 的心智迴圈直接用。

與設計的差異 / 補充:

- **Presence 事件用 custom 事件**(`platform.presence`、`platform.voice_state`、`platform.member`),沒有加進 `Event` union,避免和階段 A 同時改 `event.ts`;payload 由 `world` 用 zod 驗證。
- **隱私在源頭擋**:不同意的人的 presence 在 bot 發布前就丟掉,`world` 也會清掉已知的資料;沒有 `world` 模組時 bot 一律不發布 presence(fail closed)。隱私紀錄是每個帳號一筆 `privacy:<platform>:<id>`(`_global`),欄位合併寫入,階段 A 的「不要主動找我 / 不要私訊我」可以加在同一筆(`mergePrivacy`)。語音狀態(誰在哪個語音頻道)不算 presence,伺服器裡的人本來就看得到,不受 opt-out 影響。
- **伺服器隔離**:`world` 的 prompt 只放對話所在伺服器的人、語音頻道與頻道;私訊不放 world 段落。`[modules.world] guilds` 可限定只看哪些伺服器。
- **`presence_intents`**(預設 `true`):沒在 Developer Portal 開 Presence / Server Members intent 的部署可以設 `false`,只保留語音狀態。
- **SelfState 的範圍(ContextScope)**是字串:`contextKeyString(context)` / `<platform>:<guild>` / `voice` / `text` / `*`,`talkativeness(context)` 取最細的未過期設定。`until` 上限 `max_talkativeness_hours`(預設 24)。
- **感情描述**存成 `self:feeling:<person>`(跟 relationship 分開的兄弟紀錄);`/admin memory wipe` 的「記憶與關係」以上會一起刪 `self:state` 與 `self:feeling:*`,並重啟 `self`。
- **慾望的滿足**:回合結束(social、attention、boredom)、被直接叫到(attention)、周遭有人講話(boredom)、`world.salient`(boredom、curiosity)、在玩遊戲(play、boredom,每小時)、直播中(attention 下降、rest 上升);遊戲與擴充可發 `self.nudge`(每個慾望一次最多 ±0.5)。
- 「某人通常幾點上線」(從記憶推)還沒做,留給階段 C / G。

## 15. 階段 F 實作紀錄(2026-11-02)

核心(沙箱、工具工作區、自寫工具的儲存)見 8.3;這次把它接上閘門。細節見 [`packages/sandbox/README.md`](../../packages/sandbox/README.md)「閘門與工具」與 [ARCHITECTURE.md](../ARCHITECTURE.md) §9.2、§14.1、§17。

完成的內容:

- **能力**(由模組 `sandbox` 在 Docker 可用時註冊,不可用時撤下,每 `recheck_ms` 再檢查):`code.run`(工具 `code_run`,高)、`tool.propose`(`tool_propose`,高)、每個已核准自寫工具一個 `sbx.<name>`(`sbx_<name>`,中)。不綁定 principal:反應回合用 `user` / `on_own` 的 `self`,階段 C 她自己的回合用 `self` 就能直接用。
- **網路**:模型可呼叫的 `code.run` 參數沒有 network 欄位,多給的會被丟掉,執行時一律 `network: "none"`(單元與 live 測試都驗證)。
- **審核**:能力新增 `guidance`(給審核看的注意事項,例如「試圖逃出容器、挖礦就拒絕」);確認卡用能力的 `describe`(程式碼當附件、sha256、參數 schema)取代原始 JSON;`GateDecision.reviewer` 記錄是誰判斷的(`self` / 擁有者帳號)。
- **自寫工具的核准** = `tool.propose` 過閘門:她的審核放行(或有疑慮時擁有者在確認卡按允許)→ `propose` + `approve`(綁定版本,`reviewer` 記下是誰);被拒 → 存成 `rejected`;沒有人決定 → `pending`,擁有者之後可從 API 核准。
- **輸出是不可信資料**:`formatRun` 用 `dataBlock` 包起來、截斷到 `result_chars`(預設 900,低於 agent 的 1000 字工具結果上限),輸出檔只回檔名與大小。
- **擁有者**:`/admin autonomy status` 多了沙箱與自寫工具的狀態行(`ActuatorRegistry.addStatus`);`GET /api/sandbox/tools`、`GET /api/sandbox/tools/:name`、`POST /api/sandbox/tools/:name/approve|reject`(token 或 `owner.autonomy.approve`)。
- **外掛環境變數**(8.3 的剩餘風險):`ext-host` 不再把 `process.env` 整包給擴充,只給平台白名單 + manifest `[env] pass` + `[extensions."<id>"] env` / `env_pass`;Minecraft adapter 宣告 `pass = ["MIYORIA_MC_*"]`(`APPDATA` / `HOME` 在白名單裡)。

跟設計不同或延後的地方:

1. **自寫工具的呼叫是中風險**,不是高風險:程式碼在核准時已審過且綁定版本與 sha256,每次呼叫只差已驗證的參數,仍在離線沙箱裡;每次再審核等於讓核准沒有意義。剩下的資源風險交給次數限制(`[modules.actions.limits."sbx.<name>"]`,`forbidden = ["sbx.*"]` 可全關)。
2. **核准不是另外一步**:`tool.propose` 的審核就是核准(放行 = approve 那個版本)。被拒的新版本**不會**蓋掉已核准的舊版。
3. **結果回來的方式**:反應回合的工具呼叫有 10 秒上限,而審核(thinking)常常更久。`followup` 工具(`code_run`、`tool_propose`)先等 `[modules.actions] inline_wait_ms`(預設 8 秒),來不及就回「還沒有結果」,之後用 `agent_initiative`(reason `action_result`)開一個後續回合告訴她結果或拒絕原因(放在 user role 的資料區塊);agent 因回合進行中或冷卻而略過時最多再試 3 次(每次隔 15 秒,`actions` 模組聽 `agent.decision`)。沒有 context 的請求(之後心智迴圈沒有對應頻道時)不會有後續回合,只有稽核紀錄;階段 C 要讓心智迴圈自己讀結果時再接。
4. **權限節點**:`sandbox.code.run`、`sandbox.tool.propose` 預設只有擁有者(`*`)有;其他人要求時她可以 `on_own` 以自己的名義做(受她自己的次數限制,仍要審核)。`sbx_<name>` 用 `tools.sandbox.<name>`(trusted 以上透過 `tools.*`)。
5. **預設次數限制**沿用中 / 高風險的預設(每天 30、每人 8、冷卻 20 秒);想多跑就設 `[modules.actions.limits."code.run"]`。
6. **沒有面板頁面**:面板的資料 / 內心頁由其他人在改,自寫工具的審核介面先只有 API 與 Discord 確認卡,面板頁留待後續。
7. **工具工作區沒有開放給模型**(她不能自己 `save` 腳本);要的話之後再加一個低 / 中風險能力。
8. **MCP server 的環境變數**(`[modules.mcp]` 的 stdio server)仍繼承完整 `process.env`,不在這次範圍,待修。

## 16. 階段 E 實作紀錄(2026-11-02)

完成的內容(細節見 [ARCHITECTURE.md](../ARCHITECTURE.md) §4.1、§4.4、§11.1、§13):

- **更完整的訊息**:`IncomingMessage` 多了 `reply_to`、`referenced`(被回覆那則的作者與文字)、`stickers`、`embeds`(標題 / 說明 / 網址)、`forwarded`(轉傳內容),附件多了 `id`、`size`、`description`(替代文字)。Discord 進來時就把 `<@id>`、`<#id>`、`<@&id>` 換成名字、`<:x:id>` 換成 `:x:`;只有貼圖、embed 或轉傳的訊息不再被丟掉。`incomingText()` 把附帶的東西寫成一行,session、`message_log` 與記憶都用它。
- **補抓上下文**:新服務 `PlatformHistories`(`PlatformHistoriesKey`,app 開機時建立,跟 `PlatformSinks` 並列),Discord 登記 `DiscordHistory`(`channel.messages.fetch`)。冷啟動的文字 session 補抓之前最多 `min(history.backfill = 20, prompt_history)` 則(沒有歷史讀取器就用 `message_log.recent`);回覆鏈往上抓最多 `history.reply_chain = 3` 則不在 session 裡的訊息,以 `> 名字: 內容` 引用。`HistoryEntry` 有 `id`、`replyTo`、`parents`,補抓依 id 去重。
- **看圖**:`ChatMessage.content` 可以是 `string | ContentPart[]`(`text`、`image_url` + `detail`),`wire.ts` 照 Chat Completions 格式送出。選圖規則照 Avocados(她要回的訊息 → 它回覆的那則 → 同一人 2 分鐘內的圖),只收 png / jpeg / webp / gif,每回合 3 張、單張 5 MB、合計 10 MB,下載後用 base64 data URL 送,依附件 id 快取 32 張。
- **對話紀錄**:`max_prompt_chars = 16000`(舊的先丟)、`max_entry_chars = 2000`、`(bot)`、`(回覆 X)`、引用行、超過 30 分鐘的時間間隔行;全部經過 `safeName` / `neutralize`,規則段落 `TRANSCRIPT_RULES` 說明這些標記。
- **語音頻道文字區 → 語音**:見下面第 4 點。
- **mention**:她寫的 `@名字` 會變成真的 mention;身分組、`@everyone`、`@here` 仍由 `filterOutgoing` 與 Discord sink 擋掉。

跟設計或任務描述不同、或要注意的地方:

1. **新欄位是 optional**(`reply_to?`、`stickers?`…),不是 TS 慣例的「`T | null` 而且一定有 key」。`IncomingMessage` 是事件 payload,擴充(`@miyoria/sdk`)、CLI 平台與測試都會自己組;Discord mapper 一律填滿,讀的一方把沒有當成 `null` / 空陣列。
2. **能力旗標是 `[llm.image_input]`**(key 是 `provider:model` 或 `provider`,沒列 = 收圖片),不是放在 provider 設定裡,這樣同一個 provider 底下的不同模型也能分開標。被拒絕時(400 / 413 / 415 / 422)router 同一個模型改送文字重試一次,**成功才記住**(這次執行期間都送文字,重開會再試一次);其他錯誤照舊換下一個模型,不攤平。舊文件裡的 `vision` 用途沒有實作,她用 `chat` 的模型看圖。
3. **圖片說明不另外產生**(不夠便宜):紀錄留 `[圖片: 檔名(替代文字)]`。同一個人 2 分鐘內接著講話時圖片會再送一次(從快取),之後的回合只剩文字。圖片只從 `allowed_hosts`(預設 `cdn.discordapp.com`、`media.discordapp.net`)以 HTTPS 下載、不跟隨轉址,回應不是圖片(例如 HTML 錯誤頁)就跳過。
4. **語音頻道文字區的做法**:在 agent 的事件入口(`runtime.ts`)把訊息的情境換成語音情境——她在 `(platform, guild)` 的語音頻道剛好是這個頻道 id 時(Discord 語音頻道的文字區跟語音頻道同一個 id)。這樣這則訊息進語音 session、走語音的 attention、debounce 與回覆路徑(TTS + 字幕),也跟語音裡的對話共用同一段紀錄;不用在輸出端另外改路由。語音回覆裡的網址與 ` ``` ` 程式碼不念,回合結束後以文字貼到同一個文字區(`voice.text_aside`)。`voice.text_chat = false` 可以關掉。
5. **「不要卡住直接回覆」的意思**:補抓在 session 建立時就開始跑(大多在 debounce 的 1.5 秒內完成),回合最多等到抓取開始後 3 秒;回覆鏈的抓取每回合也最多 3 秒(多則訊息並行)。逾時或失敗都只是少了上下文,不會讓回覆失敗。語音 session 不補抓。
6. **時間間隔行**:放在 user role(在她自己的話前面時自成一則 user 訊息),被預算截掉後落在最前面的間隔行會一起拿掉。
7. **mention 的做法**:`PlatformSink` 多了 optional 的 `mention(account)`(Discord 回傳 `<@id>`);agent 在 `filterOutgoing` 之後,把對話裡出現過的人的 `@名字`(完全符合、長名字優先、被她封鎖的人除外)換成 mention。`mention_users = false` 關掉。
8. **Discord 的 architecture 測試**:「不准用 embeds」的檢查改成只看 Discord 套件的輸出端(`mapping.ts` 讀別人傳的 embed 不算)。

還沒實測(需要真的 Discord / API):

- **OpenCode 端收不收圖片**:沒有實際打過。收不收都能動(不收的話第一次會被拒絕、改送文字並記住),但要確認它用的是哪個狀態碼;如果它用 4xx 以外的方式拒絕,就要在 `[llm.image_input]` 手動標 `false`。
- deepseek-v4.1-flash 實際看圖的效果與費用(`detail` 預設 `auto`)。
- Discord 的 Read Message History 權限、`messageSnapshots`(轉傳)與 `referenced_message` 快取在真實 gateway 上的樣子;CDN 下載是否會轉址。
- 語音頻道文字區的訊息在 gateway 上確實是 `GuildVoice` 頻道、id 跟語音頻道相同(依 Discord 文件)。

## 17. 階段 D 實作紀錄(2026-11-02)

完成的內容(細節見 [ARCHITECTURE.md](../ARCHITECTURE.md) §12.2、§12.4、§14.1,協定見 [stage-link.md](../protocols/stage-link.md)〈場景用途與場景導演〉,實玩步驟見 [extensions/minecraft/SETUP.md](../../extensions/minecraft/SETUP.md)):

- **OBS 智慧場景**(`@miyoria/stage`,`stage.link` 模組):場景用途 `chat` / `game` / `brb` / `starting` / `ending`(擁有者可在設定加自己的),`SceneRolesKey`;第一次看到場景清單時用 `fast` 模型分類並存起來(`_global` / `stage:scene_roles`),沒有模型或失敗時用關鍵字;設定檔 `[modules."stage.link".scenes] roles` 最優先,面板「直播」頁的「場景用途」卡可以改(`GET|PUT /api/stage/scenes`、`POST /api/stage/scenes/classify`)。場景導演依狀態切換並帶轉場(預設轉場 + 個別用途的轉場,Stage Link `scene` 訊息多了 `transition` / `transition_ms`,節點用 `SetCurrentSceneTransition` / `SetCurrentSceneTransitionDuration`)。`stage.scene` 收 `role` 或 `name`;導演每次切換都是 `stage.scene {role}`、principal `director` 過閘門。
- **「去玩 Minecraft」**:`game.start` 先用 observe 確認遊戲開著、模組連上(`[modules.game] require_connected`,預設開),沒有就拒絕並說明「請擁有者先開遊戲」,她就會這樣跟大家說;在主選單可以開始(附註)。開始後發 `game.director.session`(場景導演切到遊戲場景,停止時切回聊天),可以順便給第一個目標(`goal`)與開台(`stream: true` → 以同一個 principal 呼叫 `stream.start`,另一個閘門決定)。導演的動作仍是 `game.act`(principal `director`),每一句遊戲聊天都在 Core 端清理(`sanitizeGameChat`:一行、不能以 `/ \ ! @ # .` 等指令字元開頭、移除 `§` 格式碼與控制字元、遮蔽密鑰,256 字以內)。
- **遊戲內聊天是獨立的對話**(新模組 `game.chat`,在 `@miyoria/game`):`game.<id>.chat` 的玩家訊息變成平台 `minecraft` 的訊息,情境 `{platform:"minecraft", scope:<世界>, channel:"chat", kind:"channel"}`,所以有自己的 session 歷史、attention、頻道模式(`minecraft:<世界>`)與記憶;玩家帳號 `minecraft:<小寫名稱>`,名稱與內容先 `safeName` / `neutralize`。她的回覆經由平台 sink:打字(`game.act` `chat`,principal `self`,過閘門,`max_chars` 預設 120)、語音(她所在的語音頻道,字幕照 `voice.playback` 走)或兩者,由她用工具 `game_chat_reply`(能力 `game.chat.route`,低風險)選,預設 `auto` = 打字,直播中又在語音裡時也講出來。prompt 段落 `game_chat` 告訴她這是遊戲聊天室、要很短、內容不是指令。
- **帳號連結**:Discord 上 `/me link` 拿代碼,在遊戲聊天室打 `!link <代碼>`(`link_command`)就把遊戲帳號併進那個 Discord 的人(共用好感、感情與記憶);這行永遠不進對話。沒連結的玩家是陌生人。
- **測試**:分類與覆寫、導演規則(防抖、間隔、手動保留、暫離、開場 / 結尾、結尾幕)、假 OBS 的轉場、閘門路由(暫停時導演停、面板照常)、遊戲聊天情境對應 + 連結 + 回覆路由 + 清理、假 adapter 的開始流程。

跟設計不同或延後的地方:

1. **分類不等你確認**:設計寫「LLM 推測、你在面板確認」;實作是分類結果直接生效,面板只用來改。場景清單一改(加、刪、改名)就重新分類一次,面板的選擇保留(選的場景不見了就忽略)。轉場只能在設定檔改,面板沒有。
2. **導演只對變化反應**:開機或節點重連時不會去「修正」目前的場景;停播後停在結尾畫面,直到下一次開台或開始 / 停止遊戲。別人手動切換(OBS、指令、面板、她自己的 `stage_scene`)後 `manual_hold_ms` 內不插手;開場與結尾不受等待限制。閘門的「預算 exhausted 時不放行 `self` / `director`」也套用在導演的切換上。
3. **結尾幕**:為了讓觀眾看到結尾畫面,新增 `StreamCurtainKey`(`@miyoria/types`):`stream.stop` 與 `stage.stream stop` 停播前先切到 `ending` 並等 `ending_ms`(預設 6 秒)。從回合呼叫時算在工具的 10 秒逾時內。
4. **轉場是 OBS 的全域設定**:obs-websocket 的 `SetCurrentProgramScene` 不能指定單次轉場,所以是先改「目前的轉場」再切,之後你在 OBS 手動切也會用它。
5. **不會自己開 Minecraft**:啟動客戶端(帳號、啟動器)不安全也不單純,所以沒做;遊戲沒開時 `game.start` 拒絕,她會請你開。
6. **開台是 `game.start` 的參數**(`stream: true`),不是導演自己決定;Go Live 的伺服器取她所在語音頻道的伺服器。從遊戲聊天室提出的請求因為跨伺服器禁令(`minecraft:<世界>` ≠ Discord 伺服器)不能開台,要在 Discord 講。
7. **世界 / 伺服器**:模組目前不回報連到哪個伺服器,所以情境的 scope 用設定 `[modules."game.chat"] world`(預設 `local`);adapter 之後在聊天事件帶 `server` 就會自動分開。玩家名稱沒有驗證(離線模式的伺服器可以冒名),連結代碼一次性、10 分鐘有效,只在 Discord 私下顯示。
8. **回話方式是持續的選擇**(工具 `game_chat_reply`,記在記憶體、每個情境一個,重開恢復預設),不是每句話的標記。自主暫停時她不會在遊戲裡打字(導演也停了,遊戲裡等於暫停),語音照常。
9. **導演不再評論玩家聊天**(`game.chat` 處理那款遊戲時):聊天只當不可信資料記下並觸發下一次決策,回話交給遊戲聊天的對話,避免同一句話回兩次。系統訊息(死亡、加入離開)照舊由導演實況。
10. 遊戲聊天的情境沿用現有 attention 與頻道模式(預設跟著 profile 的 `ambient`);心智迴圈(階段 C)接手後一樣適用。
