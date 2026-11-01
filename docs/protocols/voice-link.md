# Voice Link 協定(v1)

Self voice node(`apps/voice-node`,TS)和 Core 的 `voice.link` 模組之間的連線。Phase 6 會換成 Node Link(gRPC);在那之前用這個 WebSocket 協定。

- **方向**:voice node 主動連到 Core:`ws://<core>:7879/voice-link`(位址由 `[modules."voice.link"] bind` 設定)。
- **訊框**:文字訊框是 JSON(都有 `type` 欄位);二進位訊框是音訊。
- **音訊格式**:一律 **PCM s16le、單聲道**。收音固定 16 kHz;播放的取樣率由 `play_start.sample_rate` 指定,voice node 負責轉成 Discord 要的 48 kHz 立體聲。

## 連線與認證

1. Node 連上後 5 秒內送出:
   ```json
   {"type":"hello","version":1,"token":"<VOICE_LINK_TOKEN>","node":"voice-node",
    "self_account":{"platform":"discord","id":"<self 帳號 user id>"}}
   ```
2. Core 回 `{"type":"welcome","session":"<ulid>"}`。token 錯誤時用 close code `4401` 關閉;版本不符用 `4400`。
3. 同一個 `self_account` 只允許一條連線,新的連線會取代舊的(舊的用 `4409` 關閉)。
4. 心跳:Core 每 15 秒送 `{"type":"ping"}`,node 回 `{"type":"pong"}`;45 秒沒回應就斷線。

## Core → Node

| type | 欄位 | 說明 |
|---|---|---|
| `join` | `guild`, `channel?`, `user_id?` | 進語音。給 `channel` 就進那個頻道;只給 `user_id` 就進那個人目前所在的頻道(node 看得到 voice state) |
| `leave` | `guild` | 離開該伺服器的語音 |
| `play_start` | `play`(u32), `guild`, `sample_rate` | 開始一段播放;接著用二進位訊框送音訊 |
| `play_end` | `play` | 這段音訊送完了。Node 播完緩衝裡的音訊後回 `playback` `finished` |
| `play_stop` | `play`, `fade_ms` | 立刻停止(插話 / barge-in),淡出 `fade_ms` 毫秒 |
| `ping` | | |

二進位 `0x02`(播放音訊):`[0x02][play: u32 LE][PCM s16le 單聲道 …]`。

## Node → Core

| type | 欄位 | 說明 |
|---|---|---|
| `joined` | `guild`, `channel` | 已進入語音頻道 |
| `left` | `guild`, `reason?` | 已離開(被踢、頻道刪除、`leave`…) |
| `voice_state` | `guild`, `channel`, `participants[]` | 進頻道時送一次,之後成員有變動就送。`participants` 每筆:`user_id`, `display_name`, `is_self`, `muted`, `deafened` |
| `speaking` | `guild`, `user_id`, `speaking`(bool) | Discord 的說話開始 / 結束訊號 |
| `stream_open` | `stream`(u32), `guild`, `channel`, `user_id`, `display_name`, `sample_rate`(16000) | 某人開始說話,開一條音訊串流 |
| `stream_close` | `stream` | 這個人停止說話(Discord 停止送封包);可以當作斷句的提示 |
| `playback` | `play`, `state`(`started` / `finished` / `interrupted` / `failed`), `error?` | 播放狀態 |
| `error` | `message` | 非致命錯誤(例如進頻道失敗) |
| `pong` | | |

二進位 `0x01`(收音):`[0x01][stream: u32 LE][PCM s16le 單聲道 16 kHz …]`,建議每 20 ms 一個訊框(640 bytes 的 PCM)。

**規則**

- Node **不送自己帳號的音訊**,也不送 bot 帳號的音訊。
- 沒同意被收音的使用者,由 Core 過濾(node 照送)。
- Node 一次只播一段;新的 `play_start` 進來時,如果前一段還沒結束,就排在它後面。

---

# 推論 Worker HTTP 介面(v1)

`workers/` 底下的 ASR / TTS 服務(Python),對應 `miyoria-speech` 的 `http-worker` provider。

## ASR:`POST /asr`

- 請求:`multipart/form-data`,欄位 `audio`(WAV,PCM s16le 單聲道,任意取樣率)、`language`(可選)、`prompt`(可選)。
- 回應:
  ```json
  {"text":"早安","language":"zh","emotion":"happy","audio_events":["laughter"],"duration_ms":1234}
  ```
  `emotion` 和 `audio_events` 是可選欄位(SenseVoice 有,Qwen3-ASR 沒有)。

## TTS:`POST /tts`

- 請求(JSON):
  ```json
  {"text":"哼,才不是在等你呢。","language":"Chinese","emotion":"annoyed","instruct":"不耐煩、拖長音","voice":"deepseek-chan"}
  ```
- 回應:`200`,`Content-Type: audio/L16; rate=24000; channels=1`,body 是**串流**的原始 PCM s16le(chunked transfer)。標頭 `X-Sample-Rate` 一定要有。Worker 應該在產生第一段音訊後就開始送。
- `voice` 是 worker 端註冊好的聲音名稱(例如由參考音檔建立的 clone prompt)。

## 共通

- `GET /health` → `{"status":"ok","model":"...","device":"cuda:0"}`
- 錯誤用 4xx / 5xx 加上 `{"error":"..."}`。
