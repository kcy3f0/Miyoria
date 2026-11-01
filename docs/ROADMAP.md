# Roadmap

> 每個 phase 結束時都要有**實際能用的東西**。順序依你說的重點排:先讓她在 Discord 文字頻道活起來,再加語音,最後才是直播與遊戲。架構細節見 [ARCHITECTURE.md](ARCHITECTURE.md)。

## Phase 0:地基與技術驗證(spikes)

先把最大的不確定性消掉,再開始寫正式的程式碼。

- [x] Monorepo 骨架:Cargo workspace、pnpm workspace、CI(fmt / clippy / test)、`.editorconfig`
- [ ] 授權(待決定)
- [ ] **Spike:Discord self 帳號**(程式已備好:`spikes/voice-node`,待你用小帳號執行):候選 self-bot 函式庫能不能在 DAVE 加密下分別接收每個人的音訊、送出音訊、推 Go Live(風險 R1);同一個伺服器裡 bot 帳號和 self 帳號同時在線
- [ ] **Spike:ASR 評測**(程式已備好:`spikes/speech-bench`):SenseVoice-Small vs Qwen3-ASR-0.6B / 1.7B(Whisper turbo 當參考),用 Discord 真實錄音(台灣腔、夾日英、遊戲用語),量準確率、每段延遲、VRAM
- [ ] **Spike:TTS 評測**(程式已備好:`spikes/speech-bench`):Qwen3-TTS(Base 複製、VoiceDesign → Clone)vs GPT-SoVITS(CosyVoice、IndexTTS2 有空再測),在 4070S 上跟遊戲同時跑,量首包延遲、即時率、VRAM、中日混說與情緒表現
- [ ] **Spike:DeepSeek-chan 的聲音**:用 Qwen3-TTS VoiceDesign 依 `voice.toml` 的描述生成多個候選,挑一個固定成參考音
- [ ] **Spike:VTS 嘴型**:匯入 DeepSeek-chan 模型,列出它的 expression / 參數,從音訊注入 `MouthOpen`,確認同步效果
- [x] **Spike:LLM 抽象**:決定自己寫薄 trait + OpenAI 相容 provider(`miyoria-llm`、`miyoria-llm-openai`)
- [ ] 寫下評測結果,更新 DECISIONS.md 的 🧪 項目

**完成條件**:所有 🧪 項目有結論;repo 能 build、CI 綠燈。

## Phase 1:Kernel + 文字聊天 MVP

- [x] `miyoria-types`、`miyoria-kernel`(Module、Supervisor、事件匯流排、service registry、設定與 JSON Schema)
- [x] `miyoria-store`(記憶體 + Postgres、migrations)、`deploy/docker-compose.yml`(Postgres 部分尚未對真資料庫測過)
- [x] `miyoria-llm`(OpenAI 相容供應者 + DeepSeek 專屬處理:推理內容過濾、前綴快取友善的 prompt 順序;依用途路由、成本記錄)
- [x] `miyoria-profile`(載入、驗證、執行期修改人格段落;所有資料帶 `profile_id`)+ 把 `profiles/deepseek-chan/` 定案
- [x] `miyoria-agent`:Stimulus、Conversation Session(working memory)、TurnCoordinator(debounce / 合併)、Attention 第一、二層、Expression Parser(文字部分)
- [x] `miyoria-scheduler`:`text` lane
- [x] `miyoria-discord`:文字收發、輸入中、反應、rate limit(尚未連真的 Discord 測)
- [x] `miyoria-commands` 框架 + `/ping`、`/admin module ...`
- [x] `/mode`、`/activeness`、`/persona show`(設定存進 DB,重開還在)
- [x] 工具呼叫迴圈(`ToolRegistry`、觸發者權限檢查、內建 `react`)
- [x] CLI:`init`、`doctor`、`core`、`chat`(REPL)、`module list`、`profile validate`
- [x] CLI `status`、`module list/enable/disable/restart`、`decisions`、`events`、`persona show/set`(透過 Admin API)
- [x] Decision Trace 以事件發佈(`agent.decision`)
- [x] Decision Trace 存進 DB(`miyoria decisions` 可查)

**完成條件**:她在 Discord 有自己的個性,會判斷要不要回、不會洗版;可以用 CLI 和指令開關子系統。

## Phase 2:語音

- [x] `apps/voice-node`(TS):self 帳號登入、進出語音、每人 PCM 串流、播放音訊;用 [Voice Link 協定](protocols/voice-link.md)(WebSocket)接 Core,Phase 6 換成 Node Link
- [x] 雙帳號整合:bot 收 `/join`、self 帳號執行;`voice:*` lane 經 `VoiceSink` 播放;self 掉線時語音降級、文字照常
- [x] `miyoria-speech`:ASR / TTS trait、fallback chain;provider:`http-worker`、OpenAI 相容(雲端備援)、GPT-SoVITS
- [x] `workers/`:ASR(SenseVoice / Qwen3-ASR)與 TTS(Qwen3-TTS,逐句串流)的 FastAPI worker、Docker、聲音設計工具、假 worker
- [x] `miyoria-voice`:每人能量 VAD + 斷句、ASR、轉繁體、幻聽過濾、Voice Room 成員
- [x] 語音版 Attention(更保守)+ 逐句送 TTS + `voice` lane + barge-in(被打斷就丟掉那一輪剩下的句子)
- [x] 語音同意流程(`/voice consent`、進頻道公告;預設 opt-out)
- [x] `/join`、`/leave`、`/voice mode`、`/voice consent`
- [x] 延遲事件(`voice.latency`,可用 `miyoria events 'voice.*'` 看)
- [x] 端到端測試(假語音節點 + 假 worker + 假 LLM):講完到開口約 0.74 秒
- [ ] **實測**:真的 Discord(self 帳號 + DAVE)、真的 ASR / TTS 模型、真的 DeepSeek
- [ ] Silero VAD(目前是能量 VAD,吵雜環境可能需要)
- [ ] ASR 部分結果(partial)— 目前是整段辨識

**完成條件**:她在語音頻道聽得懂大家在講什麼,偶爾自然地插話;延遲中位數 ≤ 2.5 秒。(待實測)

## Phase 3:記憶、社交、權限

- [ ] Episodic / Semantic / Self 記憶 + consolidation 背景工作 + 混合檢索 + 隱私範圍
- [ ] `/memory show / forget / export`
- [ ] `miyoria-social`:Person / Account、`/link`、Relationship、Appraisal、防刷
- [ ] Mood 模型
- [ ] Initiative Engine(主動發話)+ 預算
- [ ] `miyoria-auth`:RBAC、權限節點、Discord 角色對應、稽核紀錄
- [ ] 成本預算與自動降級

**完成條件**:她記得人、記得發生過的事,對不同人態度不同,會主動找人聊天;權限控管完整。

## Phase 4:Admin API + Panel v1

- [x] `miyoria-api`:REST + SSE 事件串流、bearer token(`miyoria init` 產生)、typed client
- [ ] OpenAPI、Discord OAuth2 登入
- [ ] `packages/api-client` 自動產生
- [ ] Panel(impeccable,深色極簡):總覽、子系統、Decision Trace、Persona 編輯 + Playground、記憶瀏覽、人與關係、權限、日誌與花費
- [ ] CLI 改成透過 API 操作正在跑的 Core

**完成條件**:不用碰設定檔就能管理她的一切。

## Phase 5:擴充系統 + MCP

- [ ] `miyoria-ext-host`:manifest、JSON-RPC、生命週期、權限、熱重載
- [ ] `@miyoria/sdk`(TS)+ 由 Rust 型別產生的 protocol 型別
- [ ] Contribution points:tools、commands、event handlers、module、providers
- [ ] `miyoria-mcp`:MCP client(工具權限政策);可選 MCP server
- [ ] CLI:`ext new / dev / install / list`
- [ ] 範例擴充(天氣、網路搜尋)、Panel 擴充管理頁

**完成條件**:用 TS 寫一個新子系統或工具,`miyoria ext dev` 就能熱載入;MCP 工具可以安全地開放給她用。

## Phase 6:Stage — VTuber 化

- [ ] `miyoria-node`:Node Link(gRPC)、配對、capabilities、斷線重連
- [ ] `miyoria stage`:VTS client(表情、嘴型、頭部 / 視線)、OBS client、音訊輸出
- [ ] split 部署設定檔;self voice node 改用 Node Link
- [ ] Go Live:OBS 本機串流 → self voice node → Discord Go Live;`/stream start` 一併開關
- [ ] Overlay(字幕、佇列、狀態)
- [ ] 第二個平台 adapter:直播聊天室(Twitch / YouTube / Bilibili,依你的選擇)
- [ ] `/stream start / stop / scene`

**完成條件**:她能以 VTuber 樣子開播,講話時嘴型、表情同步,讀直播聊天室並回應。

## Phase 7:遊戲

- [ ] Game Adapter 協定(SDK 型別 + 宿主)
- [ ] `extensions/minecraft/mod`:Fabric 橋接模組(Baritone + AltoClef,先固定 1.21.1),本機 WebSocket 提供狀態、事件、動作、截圖
- [ ] `extensions/minecraft/adapter`:TS game adapter(`observe()` 摘要、`events()` 推送、高階動作)
- [ ] OBS 直接擷取她的遊戲視窗
- [ ] 備案:mineflayer 路線(fork minecraft-mcp-server)
- [ ] 雙速遊戲迴圈 + 實況評論
- [ ] Request Queue 完整版:觀眾請求、公平排序、投票模式、overlay 顯示、`/queue` 指令
- [ ] `/game start / stop / goal`

**完成條件**:她能直播玩 Minecraft,邊玩邊實況,觀眾可以點單、投票影響她的行動。

## Phase 8:強化與維運

- [ ] OpenTelemetry + Prometheus、Grafana dashboard 範例
- [ ] 備份 / 還原、資料匯出
- [ ] Docker 映像檔發佈、部署文件
- [ ] 負載與長時間穩定性測試(連續直播 6 小時以上)
- [ ] WASM 擴充(可選)
- [ ] 多角色支援(可選)

## 後續可以考慮

更多遊戲 adapter、Telegram / LINE adapter、唱歌(歌聲合成)、記憶視覺化、她自己寫日記 / 發社群貼文、影像理解(看觀眾貼的圖)。
