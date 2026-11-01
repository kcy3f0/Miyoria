# Stage Link 協定(v1)

Stage 節點(`miyoria stage`,跑在直播機)和 Core 的 `stage.link` 模組之間的連線。跟 [Voice Link](voice-link.md) 一樣用 WebSocket + JSON(不用 gRPC,Windows 上不必裝 protoc)。實作在 `crates/miyoria-stage`。

- **方向**:Stage 主動連到 Core:`ws://<core>:7882/stage-link`(位址由 `[modules."stage.link"] bind` 設定,預設 `127.0.0.1:7882`)。
- **訊框**:只有文字訊框,都是 JSON,都有 `type` 欄位。
- **一次只接一個 Stage**:新的連線會取代舊的。

## 連線與認證

1. Stage 連上後 5 秒內送出:
   ```json
   {"type":"hello","version":1,"token":"<STAGE_LINK_TOKEN>","node":"stage",
    "capabilities":["overlay","vts","lipsync","obs"]}
   ```
   `capabilities` 只是告知用(Core 會記下來,`StageLink::node()` 查得到)。
2. Core 回 `{"type":"welcome","session":"<ulid>"}`。token 錯誤用 close code `4401` 關閉;版本不符、格式錯誤或 5 秒內沒送 hello 用 `4400`。Stage 收到 `4401` / `4400` 會直接結束(重試也沒用),其他情況會以 1 秒起跳、最多 30 秒的退避重連。
3. 新的 Stage 連線取代舊的,舊的用 `4409` 關閉。被取代的 Stage 等 30 秒再試。
4. 心跳:Core 每 15 秒送 `{"type":"ping"}`,Stage 回 `{"type":"pong"}`;任一方 45 秒沒收到任何東西就斷線(Core 用 `4408` 關閉)。
5. 連上之後 Stage 馬上送一次 `status`,之後只要 VTS / OBS 狀態有變就再送。

## Core → Stage

| type | 欄位 | 說明 |
|---|---|---|
| `emotion` | `name`, `intensity`(0..1) | 情緒標記(來自 `agent.emotion`)。`name` 是小寫,`intensity` 沒給時是 `1.0` |
| `subtitle` | `turn`, `text`, `final`(bool) | 字幕。同一個 `turn` 的新字幕取代舊的(`text` 是到目前為止的全文)。沒有 turn 的語音用 `""` |
| `speaking` | `state`(`started` / `stopped`) | 她開始 / 停止說話(來自 `voice.playback`) |
| `scene` | `name`, `id?` | 切 OBS 場景 |
| `stream` | `action`(`start` / `stop`), `id?` | 開始 / 停止直播 |
| `avatar_hotkey` | `name`, `id?` | 觸發 VTS hotkey(名稱或 hotkey ID) |
| `gaze` | `target`(`chat` / `game` / `camera`) | 她看哪裡 |
| `status_request` | `id?` | 要一份最新的 `status` |
| `ping` / `pong` | | |

範例:

```json
{"type":"emotion","name":"annoyed","intensity":1.0}
{"type":"subtitle","turn":"01JD3W6Q8X0Z5K2M9C4B7N1R3T","text":"哼,才不是在等你呢。","final":false}
{"type":"speaking","state":"started"}
{"type":"scene","name":"Game","id":12}
{"type":"stream","action":"start","id":13}
{"type":"avatar_hotkey","name":"Wave","id":14}
{"type":"gaze","target":"chat"}
```

**字幕的規則**(Core 端):

- 語音播放開始(`voice.playback` `started`)時,把這段文字接到該 turn 的字幕後面,送 `final: false`。
- 該 turn 已完成(`agent.turn.completed`)而且沒有正在播的語音時,送一次 `final: true`。之後如果同一個 turn 又有排隊的語音開始播,會再送 `final: false` 的更新,最後再 `final: true`。
- 文字頻道(非語音)的回合預設不出字幕;`[modules."stage.link"] subtitle_text_turns = true` 時,回合完成就直接送 `final: true` 的全文。

## Stage → Core

| type | 欄位 | 說明 |
|---|---|---|
| `status` | `vts`(bool), `obs`(bool), `scene`(string / null), `streaming`(bool), `id?` | 目前狀態。`vts`:已連上並通過 VTS 認證;`obs`:已連上 obs-websocket;`scene`:OBS 目前的 program 場景 |
| `error` | `message`, `id?` | 錯誤 |
| `ping` / `pong` | | |

```json
{"type":"status","vts":true,"obs":true,"scene":"Game","streaming":false}
{"type":"status","vts":true,"obs":true,"scene":"Game","streaming":true,"id":13}
{"type":"error","message":"OBS is not connected","id":13}
```

**請求與回覆**:`scene`、`stream`、`avatar_hotkey`、`status_request` 帶 `id` 時,Stage 一定要回一個帶同樣 `id` 的訊息:成功回 `status`(動作完成後的狀態),失敗回 `error`。`stream` 會等 OBS 真的進入(或離開)直播狀態才回,最多 `[stage.obs] stream_wait_ms`(預設 15 秒)。Core 端等 `request_timeout_ms`(預設 10 秒)沒回覆就當作失敗。沒有 `id` 的 `error` 只是通知(Core 會發佈成 `stage.error` 事件)。

## Core 端

```toml
[modules."stage.link"]
bind = "127.0.0.1:7882"
token = "${STAGE_LINK_TOKEN}"
# ping_interval_ms = 15000
# peer_timeout_ms = 45000
# hello_timeout_ms = 5000
# request_timeout_ms = 10000
# subtitle_text_turns = false
```

- 訂閱 `agent.emotion`、`agent.turn.completed`、`voice.playback`,依上面的規則轉送。
- 提供 `Arc<StageLink>`:`set_scene`、`stream`、`hotkey`、`refresh_status`、`gaze`、`status`、`subscribe_status`。
- 狀態變化發佈成 `Custom { topic: "stage.status" }`,payload `{connected, vts, obs, scene, streaming}`(斷線時只有 `{"connected": false}`)。
- 有 `CommandRegistry` 時註冊指令:`stream start`、`stream stop`、`stream scene <name>`、`stream status`(權限節點 `stream.start` / `stream.stop` / `stream.scene` / `stream.status`)。

---

# 嘴型音量串流(Lip-sync levels,v1)

Voice node(跟 Stage 在同一台直播機)播放她的聲音時,把播放中的音量送給 Stage,Stage 算出嘴型注入 VTube Studio。

- **位址**:`ws://127.0.0.1:7883/levels`(`[stage.lipsync] bind`)。只綁本機,不需要 token。
- **方向**:voice node → Stage,單向;Stage 不回任何東西。連線斷了 voice node 自己重連即可。
- **訊框**:文字 JSON,每 10–20 ms 一個,**只在她說話時送**:
  ```json
  {"t": 1234, "rms": 0.21}
  ```
  - `t`:這段音訊在本次播放中的位置(毫秒,從 0 開始)。目前只當作參考。
  - `rms`:這 10–20 ms 音訊的 RMS,範圍 0..1(PCM s16 除以 32768 後計算)。超出範圍會被截斷。
- 播完或被打斷時可以送一個 `{"t": <ms>, "rms": 0}`;就算沒送,Stage 在 150 ms(`stale_ms`)沒收到新值後也會把嘴巴闔上。Core 送來 `speaking` `stopped` 時 Stage 也會立刻歸零。
- RMS 應該在**實際出聲的那一刻**送出(也就是 voice node 把該段送進播放器的時候)。如果音訊輸出還有固定延遲,用 `[stage.lipsync] latency_ms` 在 Stage 端補。

Stage 端的處理:雜訊閘(`gate`,預設 0.015)→ 乘上 `gain`(預設 5.0)並截在 `max_open` → attack / release 平滑(預設 35 / 110 ms)→ `MouthOpen`;`MouthForm` 在嘴巴張開時小幅擺動(`form_base` ± `form_variation`)。以 `[stage.vts] inject_hz`(預設 60 Hz)用 `InjectParameterDataRequest`(mode `set`)跟頭部 / 視線參數一起注入。參數名稱來自 profile 的 `avatar.toml` `[lipsync]`;`mode = "mic"` 時不注入嘴型,也不開這個端點。

---

# Overlay WebSocket(v1)

Stage 的 HTTP 伺服器(`[stage] overlay_bind`,預設 `127.0.0.1:7884`):

- `GET /overlay/`:靜態檔案,來自 `[stage] overlay_dir`(預設 `apps/overlay/dist`)。OBS browser source 指向 `http://127.0.0.1:7884/overlay/`。
- `GET /overlay/ws`:WebSocket,Stage → overlay 單向推送 JSON。連上時先收到最新的 `status`、`emotion`、`subtitle`(有的話),之後即時推送:

```json
{"type":"status","core":true,"vts":true,"obs":true,"scene":"Game","streaming":true}
{"type":"emotion","name":"happy","intensity":1.0}
{"type":"subtitle","turn":"01JD3W6Q8X0Z5K2M9C4B7N1R3T","text":"早安。","final":false}
{"type":"speaking","state":"started"}
```

`core` 表示 Stage 目前有沒有連上 Core。`subtitle` 的規則同上(同一個 `turn` 的新字幕取代舊的)。

---

# VTube Studio(參考)

Stage 以外掛身分連 VTS Public API(`ws://127.0.0.1:8001`,`[stage.vts] url`),自己實作 JSON API:

- 認證:`AuthenticationTokenRequest`(使用者要在 VTS 按「允許」)→ token 存在 `<data_dir>/vts-token.txt`(預設 `data/stage/vts-token.txt`)→ `AuthenticationRequest`。token 失效時自動重新申請。
- 連上後用 `CurrentModelRequest`、`ExpressionStateRequest`、`HotkeysInCurrentModelRequest`、`InputParameterListRequest` 檢查 `avatar.toml` 的設定(找不到的只會警告;VTS 沒有的參數不注入)。
- 情緒:`avatar.toml` `[emotion]` 的值以 `.exp3.json` 結尾 → `ExpressionActivationRequest`;其他 → hotkey 名稱(`HotkeyTriggerRequest`,名稱會先對照成 hotkey ID)。同一時間只維持一個主表情;表情維持 `emotion_hold_ms`(預設 4 秒),她說話時不會結束,說完至少再留 `after_speech_ms`(預設 1.5 秒),然後回到 `neutral`。`neutral` 是表情檔時休息狀態就開著它;是 hotkey 時(例如 VTS 的「Remove all expressions」)回到休息狀態時觸發它。沒對照到的情緒視為 `neutral`。
- Idle:注入 `FaceAngleX/Y/Z`、`EyeLeftX/Y`、`EyeRightX/Y`,在 `gaze` 目標的姿勢附近緩慢飄動(`[stage.gaze]` 可調每個目標的姿勢與 `idle_amount`)。
