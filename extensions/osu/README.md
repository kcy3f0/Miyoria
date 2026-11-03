# osu! 擴充(AI 玩家)

讓她把一個 osu! AI 玩家送進 lazer 多人房,跟大家一起打;也可以叫它單獨打一張譜,把 replay 貼出來。

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

## 設定

1. 照 osu_rl 的 [live/README.md](https://github.com/SQL1024-sql/osu_RL/blob/master/live/README.md) 架好 `live.service`(需要 Python、.NET 10、編好的 ppy/osu,和伺服器上一個 AI 帳號),記下 `OSU_RL_CONTROL_TOKEN`。
2. 建置:先 `pnpm build` packages/sdk,再在這裡 `pnpm install && pnpm build`。
3. `miyoria.toml`:

```toml
[modules.extensions]
dirs = ["extensions"]
# 沒打過的譜要先模擬加計分,第一次 10–40 秒;預設 30 秒會逾時
call_timeout_ms = 120000

[extensions."miyoria.osu"]
account = "Miyoria AI"                    # AI 自己的帳號名稱(MIYORIA_OSU_ACCOUNT);live.service 登入的不是它就全部拒絕
blocked_accounts = ["你自己的帳號"]        # 絕對不能用的帳號
url = "http://127.0.0.1:8765"            # live.service;也可以用環境變數 MIYORIA_OSU_URL
public_url = "https://osu-ai.example"     # 可選:replay 連結用的對外網址(MIYORIA_OSU_PUBLIC_URL)
env = { MIYORIA_OSU_TOKEN = "<OSU_RL_CONTROL_TOKEN>" }
```

| 設定 | 環境變數 | 預設 |
|---|---|---|
| `url` | `MIYORIA_OSU_URL` | `http://127.0.0.1:8765` |
| `token` | `MIYORIA_OSU_TOKEN` | 無(沒設會在 log 警告,每次呼叫都被拒絕) |
| `public_url` | `MIYORIA_OSU_PUBLIC_URL` | 同 `url` |
| `account` | `MIYORIA_OSU_ACCOUNT` | 無(沒設就全部拒絕) |
| `blocked_accounts` | | `[]` |
| `request_timeout_ms` | | `120000` |

`live.service` 預設只聽 `127.0.0.1`;不在同一台機器時,`live.service` 用 `--host 0.0.0.0` 並在前面加 HTTPS 反向代理,manifest 的 `network` 也要改成那個位址。

## 測試

```bash
pnpm --filter @miyoria/ext-osu test
```

單元測試用一個假的 `live.service` 跑完整的 SDK 流程。2026-11-03 也接上真的 `live.service`(本機 Illyaverse)測過 `status`、`list_rooms`、`set_level` 和 `play_map`:`play_map` 第一次打一張 Hard 譜花了 36 秒,所以上面的 `call_timeout_ms` 一定要調高。進房打一整輪的流程在 osu_rl 那邊用 `python -m live.e2e` 測過。
