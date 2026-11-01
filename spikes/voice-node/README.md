# Spike:Discord self 帳號語音節點(風險 R1 / R2 / R9)

Phase 0 的第一個 spike。要回答的問題只有一個:**在 Discord 語音 E2EE(DAVE)之下,self 帳號能不能「分別」收到每個人的音訊、送出音訊、推 Go Live?**

> ⚠️ Self-bot 違反 Discord 服務條款,帳號可能被封。這是擁有者明確選擇承擔的風險(DECISIONS ADR #9、R2)。
> **只用專用的小帳號**,不要用主帳號;spike 期間這個帳號不發文字訊息、不回指令。

## 先講結論(來自實際安裝的套件型別與原始碼,還沒連線實測)

| 函式庫(版本) | 收音(每人分開) | 送音 | Go Live | DAVE |
|---|---|---|---|---|
| `discord.js-selfbot-v13` 3.7.1 / fork `@lng2004/discord.js-selfbot-v13` 3.7.2 **內建語音** | ✅ `VoiceReceiver.createStream(user, { mode: 'pcm' })`,用 SSRC 對應 user id | ✅ `playAudio()` | 有 `createStreamConnection()`(舊式 UDP) | ❌ **完全沒有 DAVE 程式碼**,只有傳輸層加密(`aead_aes256_gcm_rtpsize` / `xchacha20`) |
| `@dank074/discord-video-stream` 7.0.0 | ❌ **只送不收**:WebRTC track 只做 encrypt / send,沒有任何接收 API;而且 `joinVoice()` 固定 `self_deaf: true` | ✅(跟著影片送) | ✅ H264 / H265,`Encoders.nvenc()` | ✅ 用 `@snazzah/davey` 加密音訊和影片 |
| `@discordjs/voice` 0.19.2 + selfbot 的 `guild.voiceAdapterCreator` | ✅ `receiver.subscribe(userId)` 每人一條 Opus 串流,`receiver.speaking` 有 start / end,`ssrcMap` 有 user id ↔ SSRC | ✅ `AudioPlayer` | ❌ | ✅ 用 `@snazzah/davey` 加解密(`max_dave_protocol_version`、MLS、transition 都有) |

所以 spike 的做法是:

- **收音 / 播放**:selfbot 帳號登入 gateway,語音連線交給 `@discordjs/voice`(selfbot 函式庫本身就有 `voiceAdapterCreator`,註解寫明是給 `@discordjs/voice` 用的)。內建語音保留成對照組(`*_BACKEND=selfbot`)。
- **Go Live**:用 `@dank074/discord-video-stream`。它 peer-depend 的是 fork `@lng2004/discord.js-selfbot-v13`(不是原版),所以整個 spike 都用這個 fork。
- **同時收音 + Go Live**(Phase 2 真正需要的):dvs 自己進語音會自我拒聽,所以另外做了 `GOLIVE_VOICE=hybrid`:語音 session 由 `@discordjs/voice` 持有,只把 session id 借給 dvs 開 Go Live 的 stream 連線。這有動到 dvs 的私有欄位,屬於實驗性質,能不能動要實測。

## 安裝

需求:Node ≥ 22.4(你有 24)、pnpm 9、PATH 上有 ffmpeg(要有 `libopus`;Go Live 的音量控制要 `libzmq`。你現在的 gyan.dev essentials build 兩個都有,也有 `h264_nvenc` / `hevc_nvenc` / `av1_nvenc`)。

```bash
cd spikes/voice-node
pnpm install --ignore-workspace   # 這個 spike 有自己的 lockfile,不動 root 的
pnpm typecheck
pnpm report                       # @discordjs/voice 的依賴報告,確認有 opusscript 和 @snazzah/davey
cp .env.example .env              # 然後填 .env
```

原生依賴說明:`@snazzah/davey`、`@lng2004/node-datachannel`、`node-av`、`sharp`、`zeromq` 都有 Windows x64 的預編譯檔。`package.json` 的 `pnpm.onlyBuiltDependencies` 只放行必要的 install script;`node-av` 的 postinstall 只是另外下載一份 ffmpeg 執行檔,我們用系統的 ffmpeg,所以不需要。Opus 解碼用純 WASM 的 `opusscript`(不用編譯);之後要省 CPU 可以換 `@discordjs/opus`。

## 設定 `.env`

- `DISCORD_SELF_TOKEN`:**擁有者自己的專用小帳號** token,自己放進 `.env`。`.env` 已被 `.gitignore` 排除,不要 commit、不要貼到任何地方。
- `DISCORD_GUILD_ID` / `DISCORD_VOICE_CHANNEL_ID`:Discord 設定 → 進階 → 開發者模式,然後右鍵複製 ID。
- 其他選項見 `.env.example` 裡的註解。

建議開一個測試用伺服器,只邀你自己、朋友和這個小帳號。依 ARCHITECTURE §10.1,**錄音前先跟頻道裡的人講清楚**;錄到的 WAV 只放本機(`recordings/` 已被忽略)。

## 執行

### 1. `pnpm receive`:每人分開收音

```bash
pnpm receive                          # RECEIVE_BACKEND=djs(預設,有 DAVE)
RECEIVE_BACKEND=selfbot pnpm receive  # 對照組:內建語音,沒有 DAVE
```

- 加入頻道(不拒聽、自己靜音),每個人每段話寫一個 `recordings/{userId}_{yyyyMMdd-HHmmss-SSS}.wav`(48 kHz、16-bit,預設下混成單聲道),並在 `recordings/index.jsonl` 追加一行 metadata(使用者、長度、封包數、解碼錯誤數、從「開始講話」到第一個封包的時間)。
- 終端機會印:`[ssrc] user … -> audio ssrc …`、`[speak] START/STOP <userId>`、`[voice] ready { transportEncryption, daveProtocolVersion, daveSessionReady, voicePrivacyCode, connectedClients }`、`[dave] transitioned`,每 30 秒一次 `[status]`。
- `daveProtocolVersion ≥ 1` 且 `daveSessionReady: true` = DAVE 協商成功。`voicePrivacyCode` 可以跟 Discord 客戶端「語音隱私碼」對照,一樣就代表真的在同一個 E2EE 群組裡。
- 注意:Discord 靜音時不送封包,所以 WAV 裡的長停頓會被壓縮掉。拿去做 ASR 評測沒問題;要對時間軸時看 `index.jsonl` 的 `startedAt`。
- 這些 WAV 就是 `spikes/speech-bench` 的測試資料(見那邊的 README)。

### 2. `pnpm play`:播放音檔(模擬 TTS)

```bash
PLAY_FILE=path/to/line.wav pnpm play
```

每輪播兩次:`ffmpeg`(把檔名交給函式庫,現場開 ffmpeg 轉碼)和 `raw`(先解成 48k PCM,用 `StreamType.Raw` 餵進去,最接近之後 TTS 串流的路徑)。印出 `startupMs`(`play()` → 第一個 Opus frame 準備好)。這是**本機**延遲;到聽眾耳朵的網路延遲要用耳朵 / 錄影對照(例如用手機錄下你按 Enter 和聽到聲音的時間差)。`PLAY_BACKEND=selfbot` 是內建語音對照組。

### 3. `pnpm golive`:Go Live 推流

```bash
GOLIVE_INPUT=sample.mp4 pnpm golive                       # 本機影片(GOLIVE_LOOP=1 可無限循環,方便量資源)
GOLIVE_INPUT=rtmp://127.0.0.1:1935/live/miyoria pnpm golive   # 等 OBS 推流
GOLIVE_INPUT="srt://127.0.0.1:9000?mode=listener" pnpm golive
GOLIVE_VOICE=hybrid pnpm golive                           # 同時收音(印 speaking START/STOP)+ Go Live
```

OBS 設定:
- **RTMP**:設定 → 串流 → 服務「自訂」,伺服器 `rtmp://127.0.0.1:1935/live`,串流金鑰 `miyoria`。先啟動 `pnpm golive`(ffmpeg 會 `-listen 1` 當 RTMP server),再在 OBS 按「開始串流」。
- **SRT**:伺服器填 `srt://127.0.0.1:9000?mode=caller`。
- 輸出:編碼器 NVENC H.264、**關鍵影格間隔 1 秒**、**B-frames 0**、CBR。

編碼相關(R9):
- `GOLIVE_ENCODER=nvenc`(預設)→ `h264_nvenc` / `hevc_nvenc`,`GOLIVE_NVENC_PRESET=p1`~`p7`(p1–p3 延遲最低,p4 平衡)。NVENC 是獨立的硬體區塊,不太吃遊戲的 3D 效能;OBS 自己也在用同一塊,兩邊同時編碼要看 `enc%`。
- `GOLIVE_ENCODER=software` → x264/x265 `superfast` + `zerolatency`(吃 CPU,當對照)。
- `GOLIVE_HWACCEL_DECODE=1` → `-hwaccel auto`,輸入用 NVDEC 解碼。
- `GOLIVE_NO_TRANSCODE=1` → **直接轉送 OBS 已經編好的 H.264,不再編一次**(R9 的理想做法)。OBS 一定要照上面設 1 秒關鍵影格、0 個 B-frame,否則畫面會花。
- `GOLIVE_GPU_MONITOR=1` 每 2 秒跑 `nvidia-smi dmon -s u`,印 `sm%`(3D/CUDA)、`enc%`(NVENC)、`dec%`(NVDEC)。Node 行程 CPU 每 10 秒印一次;**ffmpeg 子行程的 CPU 請看工作管理員**。
- DAVE:每 15 秒印 `{ voiceDaveReady, voiceDaveVersion, streamDaveReady, streamDaveVersion }`(dvs 的 voice 連線和 stream 連線各自有 DAVE session)。`DEBUG=conn,conn:dave` 會印 dvs 的 MLS 交握細節。

## 要記錄的東西(結果寫回 DECISIONS.md R1 / R9)

**收音(`receive`)**
- [ ] `djs` 後端:`daveProtocolVersion` 是多少?`daveSessionReady` 有沒有變 true?`voicePrivacyCode` 跟 Discord 客戶端顯示的一不一致?
- [ ] **每人分開的串流?** 兩三個人同時講話時,是不是每個人各自一個 WAV、檔名是正確的 user id?有沒有串音、漏掉的人?
- [ ] WAV 聽起來正常嗎?`index.jsonl` 的 `decodeErrors` 是不是 0?(DAVE 解密失敗時會是一堆 decode error 或沒有封包)
- [ ] 有人中途加入 / 離開頻道時(DAVE 會做 MLS transition),收音會不會斷?斷多久?
- [ ] `firstPacketMs`(開始講話 → 第一個封包)大概多少?
- [ ] `selfbot` 對照組:連得上嗎?會不會被語音伺服器踢掉(close code 4017 之類)?收到的音是正常的還是雜訊?

**播放(`play`)**
- [ ] 其他人聽得到嗎、音質正常嗎?(DAVE 下送出去的音必須加密,聽不到通常就是 DAVE 沒好)
- [ ] `ffmpeg` vs `raw` 的 `startupMs`;體感的端到端延遲。

**Go Live(`golive`)**
- [ ] 大家看得到 Go Live 嗎?實際解析度 / fps(Discord 觀看端右鍵 → 串流資訊,或 Nitro 限制的影響)。
- [ ] 本機影片、RTMP、SRT 三種輸入哪些能用?OBS → Discord 的畫面延遲大概幾秒?
- [ ] `nvenc` vs `software`、`NO_TRANSCODE=0/1`:ffmpeg CPU%、`sm% / enc% / dec%`、VRAM;**開著遊戲 + OBS 時**遊戲 fps 有沒有掉。
- [ ] `streamDaveReady` 是 true 嗎?
- [ ] `GOLIVE_VOICE=hybrid`:推流的同時 `[speak] START/STOP` 還會出現嗎?(會的話,一個節點同時收音 + Go Live 的架構就成立)

**其他**
- [ ] 跑 spike 期間官方 bot 帳號同時在同一個伺服器在線,有沒有互相影響。
- [ ] 小帳號有沒有被要求驗證 / 被警告。

## 已知限制 / 之後可能要補的

- dvs 7.0.0 沒有收音、而且強制拒聽 → 如果 `hybrid` 不行,Phase 2 要 fork dvs(拿掉 `self_deaf: true`、在 WebRTC audio track 上加接收 + `davey` 解密),或請上游支援。
- 內建語音沒有 DAVE → 如果 Discord 已經對一般語音頻道強制 DAVE,`selfbot` 後端預期會失敗,這正是對照組要證明的。
- `@discordjs/voice` 是給 bot 用的,搭 user 帳號是靠 selfbot 函式庫的 adapter;語音 gateway 對 user 帳號的行為若有差異(例如要求 WebRTC 而不是 UDP),會在 `receive` / `play` 直接失敗,記下錯誤訊息即可。
- 這些都不是繞過任何東西:只是用擁有者自己的帳號 token 登入,跟官方客戶端一樣參與 DAVE 加密。
