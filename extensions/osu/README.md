# osu! 擴充(AI 玩家)

讓她把一個 osu! AI 玩家送進 lazer 多人房,跟大家一起打;也可以叫它單獨打一張譜,把 replay 貼出來;或是開台自己打 osu,邊打邊實況(game adapter,見下面「她自己打 osu 開台」)。

AI 本體是 [osu_rl](https://github.com/SQL1024-sql/osu_RL) 的 `live.service`:一個強化學習模型,用普通帳號以 lazer 客戶端的協定連上 osu! 私人伺服器(例如 Illyaverse),判定和計分都用 lazer 自己的程式算。這個擴充只把它的 HTTP API 包成工具,不碰遊戲本身。

```
她(LLM)--tool call--> miyoria.osu --HTTP--> osu_rl live.service --SignalR / REST--> osu! 伺服器 <-- 大家的 lazer
```

## 工具

| 工具 | 做什麼 | 權限節點 |
|---|---|---|
| `osu_ai_status` | AI 在哪個房間、什麼難度、準備好沒、上一場成績 | 無 |
| `osu_ai_list_rooms` | 列出開著的多人房 | 無 |
| `osu_ai_join_room` | 進房(`room_id`、可選 `password`、`level`),準備好就自己按準備,之後每一輪都一起打 | `tools.osu.play` |
| `osu_ai_leave_room` | 離開房間 | `tools.osu.play` |
| `osu_ai_set_level` | 換強度(`easy` / `normal` / `hard` / `expert`),下一輪生效 | `tools.osu.play` |
| `osu_ai_play_map` | 單獨打一張譜(`beatmap_id`、可選 `level`、`mods`,例如 `["HD"]`),回傳準度、評級、分數和 replay 連結 | `tools.osu.play` |

`tools.osu.play` 在內建角色裡是 `trusted` 以上才有(`tools.*`)。想讓一般朋友也能叫 AI 進房,就把這個節點加給 `user` 角色。

服務出錯或連不上時,工具會回 `失敗:<原因>`(例如 `失敗:already_in_room`),不會讓回合當掉。

## 帳號保護

`live.service` 用它自己設定裡的帳號(`OSU_RL_AI_USERNAME`)登入,這個擴充看不到那邊的設定。所以每一次呼叫前,擴充都會先問 `live.service`「你現在登入的是誰」(`GET /status` 的 `user`):

- 不是 `account` 設定的 AI 帳號 → 拒絕,回 `失敗:osu! AI 登入的帳號(…)不是設定的 AI 帳號`;
- 是 `blocked_accounts` 裡的帳號(例如擁有者自己的)→ 拒絕,就算 `account` 也寫成那個名字;
- 沒設定 `account`、或 `live.service` 還沒登入 → 拒絕。

被拒絕時除了這個檢查,什麼請求都不會送到 `live.service`。帳號名稱比對不分大小寫。

AI 一定要用**另外註冊的帳號**,不要把自己的帳號密碼填進 `live/.env`。在同一台電腦上架 `live.service` 或跑 `live.e2e` 之前,自己的 lazer 登入不用動,但 `live/.env` 裡只能放 AI 帳號(`OSU_RL_TESTER_*` 也不要放自己的帳號)。

## 一台機器開台(最簡單的做法)

全部放在直播機上:Miyoria、AI(`live.service`)、OBS 和看畫面的 lazer。AI 只吃 CPU,不佔顯存。

**第一次**

1. **AI**:clone [osu_rl](https://github.com/SQL1024-sql/osu_RL),照它的 [live/README.md](https://github.com/SQL1024-sql/osu_RL/blob/master/live/README.md) 裝好 Python 套件和 .NET 10,執行 `python -m live.setup`。它會問伺服器和 Miyo 的 osu 帳號,最後印出下面要貼的金鑰。
2. **Miyoria**:`pnpm build`(含這個擴充),`miyoria.toml` 加上:

```toml
[extensions."miyoria.osu"]
account = "<Miyo 的 osu 帳號名稱>"          # live.service 登入的不是它就全部拒絕(見上面「帳號保護」)
blocked_accounts = ["<你們自己的帳號>"]
env = { MIYORIA_OSU_TOKEN = "<live.setup 印出來的金鑰>" }
```

3. **畫面**:在同一台開 lazer(用 Kaleidoscope 連同一台伺服器),用**另一個帳號**登入,設定裡開「自動下載缺少的譜面」。OBS 建一個遊戲場景擷取 lazer 視窗,在 `[modules."stage.link".scenes]` 把 `game` 對應到它。

**每次開台**

1. 開 `python -m live.service`、Miyoria、OBS、lazer。
2. lazer 到 Miyo 帳號的個人頁按「觀戰」,之後她打的每一張譜畫面都會自動跟上。
3. 在語音頻道下 `/game start game:osu`(或跟她說「去打 osu」),開播照平常(`/voice golive start` 或 OBS 推流)。
4. 想點譜就直接跟她說譜面 id;結束 `/game stop`。

`[modules.game]` 和工具逾時都不用改:打完一張是導演認得的 `goal_reached`,她會接著選下一張。

## 她自己打 osu(game adapter 的細節)

這個擴充同時是 `game = "osu"` 的 game adapter,跟 Minecraft 一樣走導演迴路(`docs/ARCHITECTURE.md` §12.3):

- `game_osu_observe`:正在打哪張譜、進度、combo、準度、miss;準備中;沒在打時是上一張的成績
- `game_osu_act`:`play`(`beatmap_id`、可選 `level`、`mods`)、`stop`、`set_level`、`join_room`、`leave_room`
- 事件 `game.osu.*`,每個都有 `data.text` 給她實況:`preparing`、`started`、`combo_break`(100 combo 以上算重要)、`goal_reached`(打完:準度、評級、是否 FC)、`goal_failed`(中途停止或出錯)、`connected` / `disconnected`

`play` 是單人打譜:AI 用自己的帳號打,伺服器上看得到它在玩,成績也會送出。打譜照真實時間播放,事件也照遊戲時間送出。

注意:

- 正在打的時候不能再 `play`(會回 `already playing`);在多人房裡也不能單人打。
- 譜面要在伺服器上(`/osu/{id}` 下載得到)。
- 伺服器會把 AI 的單人成績算進排行榜和 pp。

## 設定

| 設定(`[extensions."miyoria.osu"]`) | 環境變數 | 預設 |
|---|---|---|
| `url` | `MIYORIA_OSU_URL` | `http://127.0.0.1:8765`(同一台) |
| `token` | `MIYORIA_OSU_TOKEN` | 無(沒設會在 log 警告,每次呼叫都被拒絕) |
| `public_url` | `MIYORIA_OSU_PUBLIC_URL` | 同 `url`;replay 連結要給別人點時設成對外網址 |
| `account` | `MIYORIA_OSU_ACCOUNT` | 無(沒設就全部拒絕) |
| `blocked_accounts` | | `[]` |
| `request_timeout_ms` | | `25000`(比宿主預設的 30 秒工具逾時短) |

`osu_ai_play_map` 打一張沒打過的譜超過逾時時,會請她 20 秒後用同樣的參數再問一次,那時結果已經算好存起來了。

AI 跟 Miyoria 不在同一台時:`live.service` 用 `--host 0.0.0.0` 啟動,`url` 設成那台的位址,兩台之間走 Tailscale。

## 測試

```bash
pnpm --filter @miyoria/ext-osu test
```

單元測試用一個假的 `live.service` 跑完整的 SDK 流程(工具、game adapter、事件、逾時)。2026-11-03 接上真的 `live.service`(本機 Illyaverse)實測:工具全部正常;`game_osu_act play` 打完一整張 Renatus Hard,事件依序是 preparing → started → combo_break → goal_reached,observe 一路回報進度、combo 和準度。
