# 讓她第一次玩 Minecraft:逐步設定

照順序做一次就好。背景說明在 [README.md](README.md),協定在 [PROTOCOL.md](PROTOCOL.md)。

**前提**:Minecraft 和 Miyoria Core 跑在**同一台 Windows 電腦**(模組只聽 `127.0.0.1`)。Node ≥ 24、pnpm 已可用(`corepack enable`)。

## 1. 建置(在 repo 根目錄,一次)

模組(需要 JDK 21;這台電腦已有 Temurin 21):

```powershell
cd extensions\minecraft\mod
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-21.0.3.9-hotspot"
.\gradlew.bat downloadBaritone     # 抓 baritone-api-fabric-1.11.3.jar 到 mod\libs\
.\gradlew.bat build                # 測試 + 產出模組 jar
cd ..\..\..
```

產出兩個等一下要用的檔案:

- `extensions\minecraft\mod\build\libs\miyoria-bridge-0.1.0.jar`
- `extensions\minecraft\mod\libs\baritone-api-fabric-1.11.3.jar`

adapter(Core 用 `node dist\index.js` 啟動它,所以要先 build):

```powershell
pnpm install
pnpm --filter "@miyoria/ext-minecraft..." build
```

## 2. 建一個她專用的遊戲實例

不要跟你自己玩的實例混用。二選一:

**A. Prism Launcher(推薦)**

1. 「新增實例」→ 名稱 `Miyoria-1.21.1` → 版本 **1.21.1** → 模組載入器選 **Fabric**(0.16.x 或更新)→ 確定。
2. 實例上按右鍵 →「資料夾」。打開的是 `%APPDATA%\PrismLauncher\instances\Miyoria-1.21.1\`,**遊戲目錄是裡面的 `minecraft\`**(舊版 Prism 叫 `.minecraft\`)。下面說的「遊戲目錄」都是指這層。
3. Java:Prism 的「設定 → Java」開自動下載,或指到 `C:\Program Files\Eclipse Adoptium\jdk-21.0.3.9-hotspot\bin\javaw.exe`(1.21.1 需要 Java 21)。

**B. 官方啟動器**

1. 執行 Fabric 安裝程式(https://fabricmc.net/use/installer/ )→ Client → Minecraft **1.21.1** → Loader 選最新 → 勾「建立設定檔」→ Install。
2. 啟動器 →「安裝檔」→ `fabric-loader-1.21.1` →「編輯」→ **遊戲目錄**改成專用資料夾,例如 `C:\Games\Miyoria-1.21.1`。這個資料夾就是「遊戲目錄」。

帳號:在這個實例登入**她自己的** Microsoft 帳號(不要用你的;帳號資訊只存在啟動器,不要放進 repo 或設定檔)。只想先試單人世界,可以用離線帳號。

## 3. 放模組:`<遊戲目錄>\mods\`

**只用 Baritone(建議第一次這樣)**,`mods\` 裡剛好三個檔:

| 檔案 | 從哪來 |
|---|---|
| `fabric-api-0.116.17+1.21.1.jar`(或更新的 1.21.1 版) | https://modrinth.com/mod/fabric-api (篩 1.21.1 / Fabric) |
| `baritone-api-fabric-1.11.3.jar` | 複製 `extensions\minecraft\mod\libs\` 裡那個(= GitHub `cabaletta/baritone` v1.11.3 的同名檔) |
| `miyoria-bridge-0.1.0.jar` | 複製 `extensions\minecraft\mod\build\libs\` 裡那個 |

- **不要用 `baritone-standalone-fabric-1.11.3.jar`**:standalone 版把 API 也混淆了,模組呼叫不到,她會不能走路挖礦。
- **改用 AltoClef 時**:把 Baritone 那個 jar **拿掉**,換成 `altoclef-1.21.1-0.19.jar`(https://github.com/MiranCZ/altoclef/releases/tag/0.19 ,內建自己的 Baritone)。**Baritone jar 和 AltoClef 絕對不要同時放**(兩個 id 都是 `baritone`,會衝突)。
- 不要放 `-sources.jar`。

## 4. 第一次啟動遊戲

1. 啟動實例,停在主選單也可以。打開 `<遊戲目錄>\logs\latest.log`(Prism:實例的「Minecraft 記錄」視窗),要看到這一行:

   ```
   Miyoria bridge listening on ws://127.0.0.1:7890 (token in C:\...\config\miyoria-bridge.json)
   ```

   同時**不能**有 `Baritone is not installed` 或 `baritone.api is missing`(有的話回去看第 3 步)。看到 `could not bind 127.0.0.1:7890` 是埠被占用,改 token 檔裡的 `port` 後重開遊戲。
2. Token 檔就是那行 log 裡的路徑:`<遊戲目錄>\config\miyoria-bridge.json`(第一次啟動自動產生,含隨機 `token`)。不用手動複製 token,adapter 會自己讀;不要外流或提交。刪掉會重新產生新 token。
3. 建一個單人世界(第一次建議:生存、和平或簡單難度、不開作弊)進去。
4. 影像:按 `F11` 切回**視窗化**(全螢幕獨占 OBS 抓不到),1920×1080 或 1280×720。失焦不暫停已由模組自動處理;但挖方塊 / 攻擊需要遊戲視窗在前景、不要開著選單。
5. (可選)Baritone 建議設定寫進 `<遊戲目錄>\baritone\settings.txt`,內容見 [README.md](README.md) §5。

## 5. Miyoria 設定(你的 `miyoria.toml`,在 repo 根目錄)

加上(或併入已有的同名表格;TOML 不能出現兩個 `[modules.extensions]`):

```toml
[modules.extensions]
dirs = ["extensions"]   # 預設值;Miyoria 要在 repo 根目錄啟動,才找得到 extensions\minecraft\adapter

[extensions."miyoria.minecraft"]
# 遊戲目錄(含 config\ 的那層)。用單引號,Windows 的反斜線才不用跳脫。
minecraft_dir = 'C:\Users\owenl\AppData\Roaming\PrismLauncher\instances\Miyoria-1.21.1\minecraft'
# minecraft_dir = 'C:\Games\Miyoria-1.21.1'   # 官方啟動器的例子
# allow_commands = false   # true 才讓她送 / 開頭的遊戲指令
# damage_important = 4     # 一次受傷幾點以上算大事(會馬上實況)

[modules.game]
default_game = "minecraft"
decide_secs = 20           # 多久想一次下一步(有事件時會提早,最快每 4 秒)
# 她不在語音頻道時,實況送到哪(可省略;省略就送到下 /game start 的頻道)
# stream_context = { platform = "discord", scope = "<伺服器 id>", channel = "<頻道 id>", kind = "voice" }
```

確認找得到擴充:

```powershell
pnpm dev ext list          # 要列出 miyoria.minecraft 0.1.0  ...\extensions\minecraft\adapter
```

## 6. 開玩

1. 遊戲開著、在世界裡(順序其實無所謂,adapter 每幾秒會自動重連,最多等 15 秒)。
2. 啟動 Core:`pnpm dev:core`。Core 的 log 會出現 adapter 的 `connected to the mod`(帶 `capabilities`,`baritone` 要是 `true`)。如果是 `no miyoria-bridge token` 或 `the mod refused the connection`,就是 `minecraft_dir` 指錯了。
3. Discord(owner 有全部權限,moderator 有 `game.*`):

   | 指令 | 作用 |
   |---|---|
   | `/game status` | 看她在不在玩、目前目標、bot 忙不忙(先打這個確認) |
   | `/game start` | 開始玩。可選參數 `game`(預設 `minecraft`)、`where`:`auto`(預設:她所在的語音頻道 > `stream_context` > 這裡)/ `voice` / `here` / `stream` |
   | `/game goal 去砍十個橡木原木` | 指定她接下來要做的事 |
   | `/game stop` | 停止(也會叫 Baritone / AltoClef 停下來) |

4. 第一次建議先 `/game goal 走到最近的樹旁邊`,確認她會走;再試 `/game goal 挖一些石頭`。

## 7. OBS

1. 建一個場景,例如 `Game`(遊戲場景)。
2. 來源 →「視窗擷取」→ 視窗選 `[javaw.exe]: Minecraft* 1.21.1 - ...`;擷取方式 **Windows 10 (1903 and up)**;取消「擷取游標」;勾「Client Area」。黑畫面就改用「遊戲擷取」→ 擷取特定視窗。
3. 疊上 VTube Studio 的她(角落)和 overlay 瀏覽器來源 `http://127.0.0.1:7884/overlay/`(1920×1080,字幕與狀態)。
4. 音訊:「應用程式音訊擷取」選 `javaw.exe` 只收遊戲聲音;她的語音走 TTS 那條。
5. 切換:直播機的 Stage 節點連著時可以 `/stream scene Game`,不然在 OBS 手動切。

## 出問題時

先看 [README.md](README.md) §8 疑難排解。最常見:

- 她站著不動、`/game status` 說 bot 閒置:看遊戲 log 有沒有 Baritone 相關錯誤;`baritone.api is missing` = 裝成 standalone 了。
- `/game start` 回「找不到 minecraft 的遊戲 adapter」:adapter 沒 build(第 1 步)、不是在 repo 根目錄啟動 Core,或 `pnpm dev ext list` 沒列出它。
- `/game status` 的狀況寫「還在主選單或載入中」:導演在等,進入世界就好,下一次決策(≤ 20 秒)會自己接上。
