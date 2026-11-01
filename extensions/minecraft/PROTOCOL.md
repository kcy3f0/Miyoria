# miyoria-bridge 通訊協定(protocol 1)

`miyoria-bridge` 是裝在 Minecraft 1.21.1 客戶端裡的 Fabric 模組,在本機開一個 WebSocket 伺服器。TS adapter(`extensions/minecraft/adapter`,之後實作)連上來,把它包成 `GameAdapter` 的 `describe / observe / act / events`。

- 位址:`ws://127.0.0.1:<port>`(預設 `7890`;只綁 loopback,不會對外)。
- 每則訊息是一個 **文字 frame,內容為單一 JSON 物件**(UTF-8,單則上限 1 MiB)。
- 所有遊戲存取都在 Minecraft 的 client thread 執行;回覆用 `id` 對應請求,可以亂序抵達。
- 不接受帶 `Origin` 標頭的連線(瀏覽器網頁不能連進來)。Node 的 `ws` 預設不送 `Origin`,沒問題。

## 1. 設定檔與 token

第一次啟動時模組會建立 `<遊戲目錄>/config/miyoria-bridge.json`:

```json
{
  "port": 7890,
  "token": "隨機產生的 32 字元",
  "entityRadius": 24,
  "blockScanRadius": 16,
  "maxEntities": 16,
  "maxBlockKinds": 20,
  "lowHealthThreshold": 6.0,
  "hostileRadius": 16.0,
  "autoRespawn": true,
  "autoRespawnDelayTicks": 40,
  "disablePauseOnLostFocus": true,
  "screenshotMaxWidth": 640
}
```

| 欄位 | 說明 |
|---|---|
| `port` | 本機 WebSocket 埠(1024–65535) |
| `token` | 共享密鑰,連線後第一則訊息必須帶它。長度不足 16 會自動重新產生 |
| `entityRadius` | `observe` 的附近生物半徑(格),4–64 |
| `blockScanRadius` | 掃描「值得注意的方塊」的水平半徑,4–32(垂直為其與 12 取小) |
| `maxEntities` / `maxBlockKinds` | `observe` 回傳的生物數 / 方塊種類上限 |
| `lowHealthThreshold` | 血量(點數,20 = 10 顆心)小於等於此值時推送 `low_health` |
| `hostileRadius` | 敵對生物進入此距離時推送 `hostile_near` |
| `autoRespawn` | 死亡後自動按「重生」(等 `autoRespawnDelayTicks` 讓 `death` 事件先送出) |
| `disablePauseOnLostFocus` | 視窗失焦時不暫停遊戲(她在背景玩、你在別的視窗時需要) |
| `screenshotMaxWidth` | `screenshot` 預設縮圖寬度 |

adapter 應該從這個檔案讀 `port` 與 `token`(同一台機器上)。

## 2. 連線流程

1. 連上 WebSocket。
2. **第一則訊息必須是 `hello`**,5 秒內沒送、送別的、token 錯誤,伺服器會回一則 `error` 然後以 close code `1008` 斷線。

```json
{"type":"hello","token":"<token>","client":"miyoria-adapter"}
```

3. 成功時回:

```json
{
  "type": "hello_ack",
  "protocol": 1,
  "mod_version": "0.1.0",
  "minecraft": "1.21.1",
  "capabilities": { "baritone": true, "altoclef": false, "screenshot": true }
}
```

`capabilities.baritone` / `altoclef` 表示對應模組在執行時有沒有安裝。之後可以重送 `hello`(冪等)。

4. 之後就是「請求 → 回覆」與伺服器主動推送的事件。

## 3. 訊息格式

### 3.1 請求(client → mod)

```json
{"id":"42","type":"<動作>", ...參數}
```

- `id`:字串或數字,可省略;有的話會原樣放進回覆。其他型別的 `id` 會被忽略。
- `type`:見 §5。

### 3.2 回覆(mod → client)

成功:

```json
{"type":"result","id":"42","ok":true,"data":{ ... }}
```

失敗:

```json
{"type":"result","id":"42","ok":false,"error":{"code":"invalid_args","message":"slot must be 0-8"}}
```

連線層級的錯誤(JSON 壞掉、認證失敗,無法對應到請求)用:

```json
{"type":"error","error":{"code":"bad_json","message":"not valid JSON"}}
```

### 3.3 事件(mod → client,主動推送)

```json
{"type":"event","name":"damage","time":1730000000000,"data":{ ... }}
```

`time` 是 Unix epoch 毫秒。事件只送給已通過 `hello` 的連線。

### 3.4 錯誤碼

| code | 意思 |
|---|---|
| `bad_json` | 不是合法 JSON |
| `bad_request` | 不是 JSON 物件,或缺 `type` |
| `unauthorized` | 沒先 `hello` / token 錯誤(之後會斷線) |
| `unknown_type` | 不認得的請求 `type` |
| `invalid_args` | 參數缺漏或型別 / 範圍錯誤 |
| `not_in_game` | 還在主選單或載入中,沒有玩家 / 世界 |
| `baritone_unavailable` | 沒有安裝 Baritone |
| `altoclef_unavailable` | 沒有安裝 AltoClef(或還沒初始化 / API 不符) |
| `screenshot_failed` | 擷取或編碼失敗 |
| `internal` | 模組內部例外 |

### 3.5 識別碼慣例

方塊、物品、生物、維度、生物群系的 id 一律 **省略 `minecraft:` 命名空間**(`iron_ore`、`zombie`、`the_nether`)。其他模組的 id 保留完整(`modid:thing`)。輸入也接受完整 id。

## 4. `observe` 回傳的快照

請求:`{"id":"1","type":"observe"}`。回覆的 `data` 長這樣(欄位順序不保證):

```json
{
  "health": 17.5,
  "max_health": 20.0,
  "food": 18,
  "saturation": 4.3,
  "air": 300,
  "position": { "x": 100.46, "y": 64.0, "z": -20.2 },
  "block_position": { "x": 100, "y": 64, "z": -21 },
  "yaw": 91.3,
  "pitch": -12.3,
  "dimension": "overworld",
  "biome": "plains",
  "time_of_day": 6000,
  "time_phase": "day",
  "is_night": false,
  "weather": "clear",
  "held_item": { "item": "iron_pickaxe", "count": 1, "durability_pct": 88, "slot": 0 },
  "inventory": { "apple": 3, "cobblestone": 84, "iron_pickaxe": 1 },
  "inventory_free_slots": 32,
  "hotbar": [ { "item": "iron_pickaxe", "count": 1, "durability_pct": 88 }, null, null, { "item": "cobblestone", "count": 64 }, null, null, null, null, null ],
  "armor": {
    "head": { "item": "iron_helmet", "count": 1, "durability_pct": 50 },
    "chest": null,
    "legs": null,
    "feet": null
  },
  "offhand": null,
  "looking_at": { "kind": "block", "block": "oak_log", "position": { "x": 5, "y": 64, "z": -3 }, "face": "north", "distance": 2.4 },
  "nearby_entities": [
    { "type": "zombie", "distance": 3.0, "hostile": true },
    { "type": "player", "name": "Steve", "distance": 8.0, "hostile": false },
    { "type": "cow", "distance": 12.0, "hostile": false }
  ],
  "nearby_entities_total": 3,
  "hostile_count": 1,
  "nearby_blocks": [
    { "block": "diamond_ore", "count": 2, "nearest": { "x": 30, "y": 12, "z": 30 }, "distance": 40.0 },
    { "block": "chest", "count": 1, "nearest": { "x": 1, "y": 64, "z": 1 }, "distance": 5.0 }
  ],
  "baritone": { "available": true, "busy": true, "process": "Mine", "goal": "GoalBlock{x=1,y=2,z=3}" },
  "altoclef": { "available": false, "busy": null }
}
```

欄位說明:

- `time_of_day`:0–23999 ticks。`time_phase`:`day`(0–11999)、`dusk`(12000–12999)、`night`(13000–22999)、`dawn`(23000–23999)。`is_night` 只在主世界(`overworld`)可能為 `true`。
- `weather`:`clear` / `rain` / `thunder`。
- `held_item` 沒拿東西時為 `null`;`durability_pct` 只有會損耗的物品才有(剩餘百分比)。
- `inventory`:物品 id → 總數(整個背包 + 快捷列加總,依 id 排序);`hotbar` 是 9 格,空格為 `null`;`armor` / `offhand` 空的為 `null`。
- `looking_at`:準心指到的東西。`kind` 為 `block` / `entity` / `none`。方塊有 `block`、`position`、`face`、`distance`;生物有 `entity`(型別)、`name`(玩家或有自訂名稱時)、`position`、`distance`。
- `nearby_entities`:只含活的生物(不含自己、盔甲架),依距離排序,最多 `maxEntities` 個;`hostile` 為 Minecraft 的 `Monster` 分類(殭屍、骷髏、苦力怕、史萊姆、幻翼……)。`nearby_entities_total` 是截斷前的總數。`name` 只在玩家或有自訂名稱時出現。
- `nearby_blocks`:`blockScanRadius` 內「值得注意的方塊」(礦石、箱子 / 桶 / 終界箱 / 界伏盒、工作台 / 熔爐 / 鐵砧等工作站、床、地獄 / 終界傳送門、刷怪磚、岩漿、可收成作物等),依方塊種類分組,每種給出數量與最近一個的座標。排序:鑽石 / 遠古殘骸 → 其他礦石 / 刷怪磚 → 箱子 / 岩漿 / 傳送門 → 其他;同級依距離。最多 `maxBlockKinds` 種。
- `baritone.busy`:Baritone 目前有沒有在執行(尋路或某個流程在控制);`process` 是流程名稱(例如 `Mine`、`Follow`、`Explore`、`Farm`、`Custom Goal`),`goal` 是目前目標的字串表示。沒有安裝 Baritone 時 `available:false`。
- `altoclef.busy`:AltoClef 使用者任務是否在跑;無法判斷時為 `null`。

## 5. 動作(請求)

所有動作的回覆都是 `{"type":"result","id":..,"ok":true,"data":{..}}`;`data` 見各小節。動作只是**開始**執行,不會等到做完——完成與否看事件(§6)或再 `observe`。

### 5.1 `ping`

`{"id":"1","type":"ping"}` → `data: {"time": <epoch ms>}`。不需要在遊戲世界裡也能回。

### 5.2 `baritone`

透過 Baritone 的 Java API 執行(**不是**送聊天訊息)。`command` 決定參數:

| command | 參數 | 說明 |
|---|---|---|
| `goto` | `{x,y,z}` 或 `{x,z}` 或 `{block}`;可選 `near`(搭配 xyz,走到該點 `near` 格內) | 走到座標 / 只管水平座標 / 走到最近的某種方塊旁 |
| `mine` | `blocks`: 方塊 id 陣列(或單一 `block`);可選 `count`(預設 0 = 一直挖到停止) | 蒐集 / 挖掘 |
| `follow` | `player`: 玩家名稱,或 `entity`: 生物型別 | 跟隨 |
| `explore` | 可選 `x`,`z`(預設目前位置) | 以該點為中心探索未探索的區域 |
| `farm` | 可選 `range`(預設 0) | 自動收割並重新種植附近作物 |
| `build` | `schematic`: `baritone/schematics` 內的檔名;可選 `x`,`y`,`z` 原點 | 蓋建築(內部用 Baritone 的 `build` 指令) |
| `stop` | 無 | 取消 Baritone 目前所有工作(也接受 `cancel`) |
| `raw` | `line`: Baritone 指令字串(不含前綴),例如 `"set allowBreak true"` | 逃生口,直接丟給 Baritone 指令管理器 |

範例:

```json
{"id":"2","type":"baritone","command":"goto","x":120,"y":64,"z":-30}
{"id":"3","type":"baritone","command":"goto","block":"crafting_table"}
{"id":"4","type":"baritone","command":"mine","blocks":["iron_ore","deepslate_iron_ore"],"count":12}
{"id":"5","type":"baritone","command":"follow","player":"Steve"}
{"id":"6","type":"baritone","command":"explore"}
{"id":"7","type":"baritone","command":"stop"}
```

回覆 `data` 會回顯 `command`,以及 `goal`(goto)、`blocks`/`count`(mine)等。參數錯誤回 `invalid_args`。

### 5.3 `altoclef`

```json
{"id":"8","type":"altoclef","command":"get iron_pickaxe"}
```

等同在聊天輸入 `@get iron_pickaxe`(前綴 `@` 可寫可不寫)。模組透過 AltoClef 自己的指令執行器(以反射呼叫,**不是**編譯期依賴)執行,所以 AltoClef 的指令集完全可用(`get`、`goto`、`stop`、`gamer`、`give`……)。沒安裝回 `altoclef_unavailable`;指令解析失敗回 `invalid_args`。`data: {"command":"get iron_pickaxe","dispatched":"@get iron_pickaxe"}`。

### 5.4 `chat`

```json
{"id":"9","type":"chat","message":"大家好"}
{"id":"10","type":"chat","message":"/time set day"}
```

以 `/` 開頭視為指令。長度 1–256。若同時裝了 AltoClef,以 `@` 開頭的訊息會被 AltoClef 攔截當指令。

### 5.5 `look`

```json
{"id":"11","type":"look","yaw":90,"pitch":0}
{"id":"12","type":"look","at":{"x":10,"y":65,"z":3}}
{"id":"13","type":"look","at":{"x":10,"y":65,"z":3},"smooth":false}
```

`yaw` / `pitch` 單位為度(Minecraft 慣例:`yaw 0` 朝 +Z / 南,`90` 朝 -X / 西;`pitch` -90 朝上、+90 朝下)。只給其中一個時另一個保持不變。`at` 為看向某個世界座標。`smooth` 預設 `true`:每 tick 最多轉 24°,看起來像人在轉頭;`false` 直接瞬間轉。`data: {"yaw","pitch","smooth"}`(目標值)。

### 5.6 `use` / `attack`

```json
{"id":"14","type":"use"}
{"id":"15","type":"use","hold_ticks":32}
{"id":"16","type":"attack"}
{"id":"17","type":"attack","hold_ticks":60}
```

`use` = 右鍵(吃東西、放方塊、開門、丟雪球……),`attack` = 左鍵(攻擊、開始挖掘)。不帶 `hold_ticks` 時等同按一下;`hold_ticks`(1–1200)則按住那麼多 tick(20 tick = 1 秒),例如吃東西要按住約 32 tick、挖方塊要按住到挖斷。按住期間可用 `stop` 提早放開。這兩個動作作用在準心指到的東西上,先用 `look` 對準。`data: {"action","hold_ticks"}`。

注意:左鍵挖方塊需要遊戲視窗取得游標鎖定(畫面是第一人稱而不是開著選單)。

### 5.7 `select_slot`

```json
{"id":"18","type":"select_slot","slot":2}
{"id":"19","type":"select_slot","item":"diamond_pickaxe"}
```

選擇快捷列第 `slot`(0–8)格,或選擇快捷列裡第一個該物品。`data: {"slot","item"}`。找不到物品回 `invalid_args`。

### 5.8 `respawn`

`{"id":"20","type":"respawn"}` → 已死亡時按「重生」。`data: {"respawned": true|false}`。預設 `autoRespawn` 已經會自動做。

### 5.9 `stop`

`{"id":"21","type":"stop"}` → 取消 Baritone、停止 AltoClef 任務(`@stop`)、放開所有按住的按鍵、取消進行中的轉頭。`data: {"baritone": bool, "altoclef": bool}`(表示對應模組有沒有裝)。

### 5.10 `screenshot`

```json
{"id":"22","type":"screenshot","max_width":640,"format":"jpeg","quality":0.8}
```

在 render thread 從 framebuffer 讀取目前畫面(含 HUD),縮小(絕不放大)後編碼成 PNG(預設)或 JPEG,以 base64 回傳。參數:`max_width`(預設用設定檔 `screenshotMaxWidth`,64–3840)、`format`(`png` | `jpeg`)、`quality`(JPEG,0–1)。

```json
{"type":"result","id":"22","ok":true,"data":{
  "mime":"image/jpeg","width":640,"height":360,
  "source_width":1920,"source_height":1080,
  "data_base64":"/9j/4AAQ..."
}}
```

## 6. 事件

| name | 何時送出 | `data` |
|---|---|---|
| `death` | 玩家死亡(每次死亡一次) | `{"dimension","position":{x,y,z},"last_damage_source","last_attacker"?}` |
| `damage` | 血量下降 | `{"amount","source","attacker"?,"health"}`;`source` 是傷害類型(`mob`、`arrow`、`fall`、`lava`、`drown`、`player`、`explosion`……,取不到為 `"unknown"`),`attacker` 是攻擊者型別或玩家名 |
| `low_health` | 血量降到 `lowHealthThreshold` 以下(要先回復超過門檻 +4 才會再次觸發) | `{"health","threshold","food"}` |
| `hostile_near` | 有新種類的敵對生物進入 `hostileRadius`(同種類 5 秒冷卻) | `{"count","entities":[{type,distance}...最多8],"new_types":[..]}` |
| `item_picked` | 背包中某物品總數增加(約 0.5 秒合併一次;合成、從箱子取出也算) | `{"items":{"oak_log":3,"apple":1}}` |
| `night_started` | 主世界時間跨過 13000(上線時已是夜晚不會觸發) | `{"time_of_day"}` |
| `chat` | 收到聊天或系統訊息 | `{"sender": string\|null,"message","system": bool,"self": bool}`;`system:true` 表示伺服器 / 遊戲訊息(死亡訊息、玩家加入離開等),`self` 表示是她自己說的 |
| `advancement` | 她自己達成成就(解析聊天裡的成就公告,所以伺服器要開 `announceAdvancements`) | `{"kind":"task"\|"goal"\|"challenge","title"}` |
| `goal_reached` | Baritone 抵達路徑目標 | `{"goal"}` |
| `goal_failed` | Baritone 找不到路徑 | `{"reason":"no_path","goal"}` |
| `baritone_idle` | (額外)Baritone 從忙碌變成閒置(連續閒置 10 tick 才送,過濾路段切換的抖動)。挖礦做完、跟隨目標消失這類沒有 `goal_reached` 的流程用它判斷結束 | `{"process","goal","cancelled": bool}`;`cancelled` 表示是我們送了 `stop` |

`goal_reached` 對應 `goto` 類目標;`mine` / `follow` / `explore` / `farm` 沒有「到達」的概念,結束時只會有 `baritone_idle`。

範例:

```json
{"type":"event","name":"damage","time":1730000000000,"data":{"amount":3.5,"source":"mob","attacker":"zombie","health":16.5}}
{"type":"event","name":"chat","time":1730000001234,"data":{"sender":"Steve","message":"你好","system":false,"self":false}}
{"type":"event","name":"goal_reached","time":1730000002345,"data":{"goal":"GoalBlock{x=120,y=64,z=-30}"}}
```

## 7. 反射(reflex)放哪裡

LLM 不碰逐幀控制。吃東西、躲怪、水中求生這類反射交給 Baritone / AltoClef 的設定;模組本身只提供狀態與事件。建議的 Baritone 設定見 `README.md` §5。
