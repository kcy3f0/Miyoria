# Minecraft 擴充(客戶端模組路線)

讓她**真的開一個 Minecraft 視窗在玩**:Fabric 客戶端模組 `miyoria-bridge` 在本機開 WebSocket,對外提供狀態快照、事件推送與動作;能力來源是 **Baritone**(尋路、挖礦、跟隨、探索、蓋建築)與可選的 **AltoClef**(高階任務、自動吃東西、躲怪)。直播畫面直接擷取她的遊戲視窗,也就是她的第一人稱視角。架構背景見 `docs/ARCHITECTURE.md` §12.3–§12.4。

```
extensions/minecraft/
  mod/        # Fabric 客戶端模組 miyoria-bridge(Java 21,Gradle + Fabric Loom)
  adapter/    # TS game adapter(之後實作):連到 mod 的 WebSocket,實作 GameAdapter
  PROTOCOL.md # 通訊協定(精確的 JSON)
```

| | 版本 |
|---|---|
| Minecraft | **1.21.1**(Java 版) |
| Fabric Loader | ≥ 0.16(建置使用 0.16.14) |
| Fabric API | 0.116.17+1.21.1(或更新的 1.21.1 版) |
| Baritone | **1.11.3**(對應 Minecraft 1.21 / 1.21.1,Fabric 版) |
| AltoClef(可選) | MiranCZ 分支 0.19,`altoclef-1.21.1-0.19.jar` |
| Java | 21 |

## 1. 玩家端安裝

用一個專屬的 Minecraft 實例(例如 Prism Launcher / 官方啟動器建一個 `Miyoria-1.21.1` profile),不要跟你自己玩的混在一起。

1. 安裝 **Fabric Loader** for 1.21.1(官方安裝程式 https://fabricmc.net/use/installer/ )。
2. 把這些放進該實例的 `mods/`:
   - **Fabric API**(`fabric-api-0.116.17+1.21.1.jar` 或更新的 1.21.1 版)。
   - **Baritone**:`baritone-standalone-fabric-1.11.3.jar`(https://github.com/cabaletta/baritone/releases/tag/v1.11.3 )。
   - **miyoria-bridge**:`mod/build/libs/miyoria-bridge-0.1.0.jar`(建置方式見 §2)。
   - 可選 **AltoClef**:`altoclef-1.21.1-0.19.jar`(https://github.com/MiranCZ/altoclef/releases/tag/0.19 )。
3. **重要:AltoClef 內建了自己的 Baritone**。只用 AltoClef 時,**不要**再放獨立的 Baritone jar(會有兩個 id 為 `baritone` 的模組而衝突);只想用 Baritone 時就不要放 AltoClef。
4. 啟動一次遊戲,進單人世界,看 `logs/latest.log` 有沒有:

```
Miyoria bridge listening on ws://127.0.0.1:7890 (token in .../config/miyoria-bridge.json)
```

沒有 Baritone 時模組仍會啟動(可以 `observe`),但 `baritone` 動作會回 `baritone_unavailable`,啟動時 log 會有警告。

## 2. 建置模組

需要 JDK 21(`JAVA_HOME` 若指向 Java 8,先改成 JDK 21;Gradle wrapper 已附上,不需要另外安裝 Gradle)。

```bash
cd extensions/minecraft/mod
export JAVA_HOME="C:/Program Files/Eclipse Adoptium/jdk-21.0.3.9-hotspot"   # Windows / Git Bash 範例
./gradlew downloadBaritone      # 第一次:抓 Baritone API jar 到 mod/libs/
./gradlew build                 # 單元測試 + 產出 build/libs/miyoria-bridge-0.1.0.jar
```

### Baritone 怎麼被解析

Baritone **沒有**發佈到公開 Maven 倉庫,官方產物是 GitHub Releases 的 jar。所以建置時編譯對象是 `mod/libs/baritone-api-fabric-<版本>.jar`(`compileOnly`,不會打包進模組,執行時由玩家安裝的 Baritone / AltoClef 提供):

- `./gradlew downloadBaritone` 會從 `https://github.com/cabaletta/baritone/releases/download/v1.11.3/baritone-api-fabric-1.11.3.jar` 下載;也可以手動下載放到同一路徑。版本由 `mod/gradle.properties` 的 `baritone_version` 決定。
- jar 缺少時:`./gradlew test` **仍可執行**(改用 `src/baritoneStub/java` 裡標明「COMPILE-ONLY STUB」的最小介面,只含用到的少數型別,**不會**被打包),但 `jar` / `build` / `runClient` 會失敗並印出上述修復指示。
- 該 jar 為 LGPL-3.0,已被 `.gitignore` 排除,不進版控。

### 開發時直接跑遊戲

```bash
./gradlew downloadBaritoneStandalone   # 取得完整 Baritone,只給 runClient 用
./gradlew runClient                    # 啟動帶有 miyoria-bridge + Fabric API + Baritone 的開發客戶端
```

### 目錄

```
mod/
  build.gradle  gradle.properties  settings.gradle  gradlew(.bat)
  libs/                       # Baritone API jar(git 忽略)+ README
  src/main/java/dev/miyoria/bridge/
    protocol/   Request / Messages / Protocol         # JSON 編解碼(純 Java)
    snapshot/   SnapshotSummarizer                    # 原始狀態 → 快照 JSON(純 Java)
    events/     EventDetector                         # 每 tick 狀態 → 事件(純 Java)
    server/     BridgeServer                          # Java-WebSocket(以 jar-in-jar 內嵌),token 驗證
    config/     BridgeConfig                          # config/miyoria-bridge.json
    game/       Minecraft / Baritone / AltoClef 相關(client thread)
  src/baritoneStub/java/      # 僅在缺 Baritone jar 時使用的編譯期 stub
  src/test/java/              # JUnit:協定、快照、事件、設定、伺服器(真的 WebSocket round trip)
```

## 3. 她自己的 Minecraft 帳號

- 需要一個**擁有 Java 版**的 Microsoft 帳號,專門給她用(不要用你自己的;帳號被 ban 或被伺服器管理員盯上時才不會牽連)。
- 在該實例的啟動器登入那個帳號。**不要把帳號、密碼或 token 放進這個 repo 或 adapter 設定**;登入狀態只存在啟動器裡。
- 單人世界(最簡單)或任何允許 Baritone 的伺服器都可以。多人伺服器請先確認規則:Baritone / AltoClef 在很多伺服器上算作弊。要上伺服器時,把 Baritone 設定 `antiCheatCompatibility true`(見 §5)。
- 純測試可以用離線(offline)啟動器帳號跑單人世界,不需要正版帳號。

## 4. 設定檔

`config/miyoria-bridge.json` 第一次啟動自動建立,欄位與預設值見 `PROTOCOL.md` §1。重點:

- `port`(預設 7890)與 `token`(隨機產生)。adapter 從同一份檔案讀取。
- 只綁 `127.0.0.1`;帶 `Origin` 標頭的連線(瀏覽器)會被拒絕。
- 改完設定要重啟遊戲。

## 5. 建議的 Baritone 設定

反射與行為偏好放在 Baritone / AltoClef 設定裡,模組本身不做逐幀控制。Baritone 讀 `<遊戲目錄>/baritone/settings.txt`(一行一個:`名稱 值`),建議:

```
allowBreak true
allowPlace true
allowSprint true
allowParkour false
allowParkourPlace false
allowInventory false
allowWaterBucketFall true
maxFallHeightNoWater 3
autoTool true
replantCrops true
avoidance true
mobAvoidanceRadius 8
smoothLook true
smoothLookTicks 5
chatControl false
prefixControl false
antiCheatCompatibility true
logAsToast false
desktopNotifications false
notificationOnPathComplete false
echoCommands false
```

- `smoothLook` 讓視角轉動像人在轉頭,直播畫面比較自然。
- `chatControl false` / `prefixControl false`:不讓 Baritone 攔截聊天輸入裡的 `#` 指令(我們走 API,不需要)。
- `allowParkour false`:直播時別讓她太冒險;想要更像玩家再開。
- `allowInventory false`:避免 Baritone 自己開背包整理物品。
- 設定也能在執行中用 `{"type":"baritone","command":"raw","line":"set allowBreak false"}` 調整。

AltoClef(`<遊戲目錄>/altoclef/altoclef_settings.json`)內建這些生存反射,預設即開啟,可依需要調整:`autoEat`、`mobDefense`、`dodgeProjectiles`、`avoidDrowning`、`autoMLGBucket`、`autoRespawn`、`autoReconnect`、`minimumFoodAllowed`。AltoClef 的指令前綴預設 `@`(`commandPrefix`)。若使用 AltoClef,可把 `miyoria-bridge.json` 的 `autoRespawn` 關掉,讓它自己處理(兩邊同時開也不會出事)。

## 6. 直播用的影像設定

她的視窗就是畫面來源,所以:

- **視窗化 / 無邊框視窗**(`F11` 切換全螢幕,直播時用視窗化),解析度 1920×1080 或 1280×720,固定不要縮放。全螢幕獨占會讓視窗擷取抓不到。
- **垂直同步開**、最大幀率 60;渲染距離 10–12、模擬距離 8(Baritone 尋路和 AltoClef 掃描要有足夠已載入區塊,太小會常常找不到路)。
- **FOV 80**,**視角晃動(View Bobbing)關**、「失真效果」與「FOV 效果」調到 50% 以下,觀眾比較不會暈。
- **HUD 保留**(血量、飢餓、快捷列、經驗),觀眾要看得到;`GUI 縮放` 2 或 3。聊天視窗建議開著,Baritone / AltoClef 的狀態會顯示在那裡。
- 失焦不暫停:模組預設會把「失去焦點時暫停(pauseOnLostFocus)」關掉(`disablePauseOnLostFocus`)。但**挖方塊、攻擊需要游標鎖定在遊戲視窗**,所以直播機上讓遊戲視窗保持前景、不要開選單。
- 光影 / 材質包可用(Iris + Sodium 等),畫面最後是由 OBS 擷取;這些與模組的相容性尚未實測,遇到 `screenshot` 全黑時先關光影試試。

### OBS 視窗擷取

1. 來源 → **視窗擷取(Window Capture)**,視窗選 `[javaw.exe]: Minecraft* 1.21.1 ...`。
2. 擷取方式選 **Windows 10 (1903 and up)**;關閉「擷取游標」;勾選「Client Area」(只抓遊戲畫面,不含標題列與邊框)。
3. 視窗不能最小化;被其他視窗擋住在新版擷取方式下仍能擷取。若黑畫面,改用 **Game Capture**(模式:擷取特定視窗)。
4. 音訊:Windows 11 可用「應用程式音訊擷取」只收 Minecraft 的聲音;她的語音(TTS)走另一條(見 `docs/ARCHITECTURE.md` §12.2 的 VB-Cable)。
5. 想讓 LLM「看」畫面時,用協定的 `screenshot`(縮圖給支援圖片的模型),和 OBS 擷取互不干擾。

## 7. TS adapter 怎麼連(之後實作)

`extensions/minecraft/adapter` 實作 `GameAdapter`,對應關係:

| GameAdapter | miyoria-bridge |
|---|---|
| `describe()` | 靜態描述:可用動作與 JSON Schema(來自 `PROTOCOL.md` §5),`hello_ack.capabilities` 決定哪些動作可用 |
| `observe()` | `{"type":"observe"}`(必要時加 `screenshot`)→ 快照 JSON,adapter 再轉成給 LLM 看的文字摘要 |
| `act(action)` | 對應的請求 `baritone` / `altoclef` / `chat` / `look` / `use` / `attack` / `select_slot` / `stop` |
| `events()` | 伺服器推送的 `{"type":"event",...}` → `AsyncIterable<GameEvent>` |

連線骨架(Node + `ws`):

```ts
import { readFileSync } from "node:fs";
import WebSocket from "ws";

const cfg = JSON.parse(readFileSync(`${MC_DIR}/config/miyoria-bridge.json`, "utf8"));
const ws = new WebSocket(`ws://127.0.0.1:${cfg.port}`);

let seq = 0;
const pending = new Map<string, (m: any) => void>();
const request = (body: object) =>
  new Promise<any>((resolve) => {
    const id = String(++seq);
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, ...body }));
  });

ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token: cfg.token, client: "miyoria-adapter" })));
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "result") {
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  }
  else if (m.type === "event") console.log("event", m.name, m.data);
  else if (m.type === "hello_ack") request({ type: "observe" }).then((r) => console.log(r.data));
});
```

雙速控制的分工:快迴路(逐幀)完全在 Baritone / AltoClef;慢迴路(LLM)每幾秒或遇到事件(`damage`、`hostile_near`、`low_health`、`death`、`goal_reached`、`baritone_idle`)時才 `observe` 一次,下高階目標(`baritone goto/mine/follow`、`altoclef get ...`)並產生實況評論。

## 8. 疑難排解

| 現象 | 處理 |
|---|---|
| log 顯示 `could not bind 127.0.0.1:7890` | 埠被占用,改 `config/miyoria-bridge.json` 的 `port` |
| 連上後立刻被關(close 1008) | 第一則不是 `hello`、5 秒內沒送、token 錯誤 |
| `not_in_game` | 還在主選單或載入畫面,等進入世界後再下動作 |
| `baritone_unavailable` | `mods/` 沒有 Baritone(或用了 AltoClef 又另外放了獨立 Baritone 造成衝突) |
| `altoclef_unavailable` | 沒裝 AltoClef,或剛進世界還沒初始化,或版本 API 不同 |
| `goto` 一直 `goal_failed` | 目標區塊沒載入或不可達;調高渲染距離、確認 `allowBreak` / `allowPlace` 設定 |
| `screenshot` 全黑 | 關掉光影再試;確認視窗未最小化 |
| 建置時 `Baritone API jar not found` | 執行 `./gradlew downloadBaritone` |

## 9. 驗證狀態

已驗證:Gradle 建置、JUnit(協定、快照、事件偵測、設定、WebSocket 驗證與請求回覆 round trip)、對真實 Baritone 1.11.3 API jar 的編譯、缺 jar 時的失敗訊息與 stub 測試路徑。

**尚未在真實遊戲裡驗證**(需要 Minecraft 帳號與圖形環境):所有與遊戲互動的行為,包含 `observe` 的實際內容、Baritone / AltoClef 動作、`use` / `attack` 按鍵模擬、`screenshot` 擷取、`advancement` / `chat` 事件解析,以及 AltoClef 的反射呼叫(已對照 `altoclef-1.21.1-0.19.jar` 的方法簽名撰寫,未實跑)。第一次實機測試請從 `observe` 與 `baritone goto` 開始。
