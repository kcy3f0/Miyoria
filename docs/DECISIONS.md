# 技術決策、風險與待確認問題

> 搭配 [ARCHITECTURE.md](ARCHITECTURE.md) 閱讀。標 **🧪** 的項目要在 Phase 0 用實測決定,目前只是預設候選。

## 1. 技術選型

| 領域 | 選擇 | 理由 / 備案 |
|---|---|---|
| Async runtime | tokio | 生態系標準 |
| HTTP / WS API | axum + utoipa(OpenAPI) | 由 OpenAPI 產生 TS client,Panel 和 CLI 共用 |
| 節點間 RPC | tonic + prost(gRPC 雙向串流) | 有型別、可串流、可傳二進位音訊 |
| DB | PostgreSQL + pgvector,sqlx | 向量 + 全文 + 關聯資料一次搞定;不另外支援 SQLite,避免維護兩套 |
| 中文全文檢索 | 在 Rust 端用 `jieba-rs` 斷詞,存成 `simple` 設定的 `tsvector` | 不需要在 Postgres 裝 zhparser 之類的擴充,Docker 映像檔維持原版 |
| 嵌入模型 | 本地 bge-m3(`fastembed` / `ort`,CPU),可換雲端 | 中日英多語效果好,量不大時 CPU 就夠 |
| Discord bot 帳號 | serenity(Rust,跑在 Core) | 文字、指令;songbird 只當 self 帳號掉線時的備援 |
| Discord self 帳號 🧪 | TS voice node:`discord.js-selfbot-v13` 登入 + **`@discordjs/voice`**(透過 selfbot 的 `voiceAdapterCreator`)收發語音 + `@dank074/discord-video-stream` 負責 Go Live | 讀過套件原始碼:selfbot 內建語音沒有 DAVE;`@discordjs/voice` 有 DAVE 且每人一條串流;video-stream 有 DAVE 但不能收音。同一帳號能否同時收音 + Go Live 待 spike 驗證 |
| 指令 / 設定精靈 | clap + inquire | |
| Prompt 模板 | minijinja | 跟 Jinja2 語法相容,persona 作者容易上手 |
| MCP | rmcp(官方 Rust SDK) | client 與 server 都支援 |
| OBS | obws(obs-websocket v5) | |
| VTube Studio | 自己寫一個薄 client(或評估現有的 `vtubestudio` crate) | API 很小,自己控制比較好處理嘴型時序 |
| 音訊 | cpal(播放)、audiopus / songbird 內建解碼、rubato(重取樣) | |
| VAD | Silero VAD(ONNX,`ort` 或 sherpa-onnx) | |
| ASR 🧪 | 兩個主要候選對打:**SenseVoice-Small**(sherpa-onnx,Rust 原生、CPU 就能跑、附情緒 / 笑聲等事件標記)vs **Qwen3-ASR-0.6B / 1.7B**(2026-01 開源,Apache-2.0,52 種語言與方言、單一模型支援串流與離線、準確度較高,但要 Python + vLLM、吃 GPU)。Whisper large-v3-turbo 當第三選擇;雲端備援 | 判斷標準見下方「ASR 選型」 |
| TTS 🧪 | 首選候選 **Qwen3-TTS**(2026-01 開源,Apache-2.0,0.6B / 1.7B;中日英同一模型;串流首包宣稱 97ms;3 秒聲音複製;VoiceDesign 可以用文字描述「設計」聲音)。對照組 GPT-SoVITS(微調動漫角色聲音最成熟)、CosyVoice、IndexTTS2;雲端備援 | 以獨立 worker 服務接入 |
| 繁簡轉換 | OpenCC(Rust 實作),ASR 輸出與 TTS 輸入都經過 | 多數中文模型偏簡體輸出;她的文字要維持 zh-TW |
| LLM 抽象 🧪 | 自己定義 trait,底層評估 `genai` / `rig` / 直接打 HTTP | 要能精細控制 prompt caching 與串流工具呼叫 |
| Panel | React + Vite + TanStack Query/Router + Tailwind,深色極簡(用 impeccable skill) | 生態最大;如果你偏好 Svelte 可以換 |
| 擴充執行環境 | Node(預設)/ Deno / Bun / 原生執行檔 | 跨行程 JSON-RPC |
| TS 工具 | pnpm workspace、TypeScript strict、Biome(lint + format)、Vitest | |
| Rust 品質 | clippy(pedantic 部分開啟)、rustfmt、cargo-nextest、cargo-deny | |
| 型別共享 | Rust 型別 → `schemars` JSON Schema → 產生 TS 型別(或用 `ts-rs` / `specta`) | 事件與 RPC 型別只定義一次 |

### ASR 選型

Phase 0 用你朋友在 Discord 的真實錄音測(台灣腔中文、夾日英、遊戲用語、多人搶話):

- **選 Qwen3-ASR**:如果 0.6B 在 4070S 上每段話的延遲 ≤ 300ms、跟遊戲 + TTS 一起跑 VRAM 夠用,而且準確度明顯比較好。這時 SenseVoice 可以留在 CPU 上專門做情緒 / 笑聲偵測(可選)。
- **留 SenseVoice**:如果 Qwen3-ASR 太吃 GPU,或準確度差距不大。

### TTS 選型(Qwen3-TTS 的注意事項)

- 有 instruction 控制(用「開心地說」這類文字控制情緒)的是 **CustomVoice / VoiceDesign**;**Base(聲音複製)沒有 instruction 控制**,情緒只能靠文字語意。要「自己的聲音 + 情緒控制」,可能要用官方的 fine-tuning 流程微調。
- **VoiceDesign → Clone** 流程:先用文字描述設計出 Miyoria 的聲音,再拿那段音當複製的參考音。沒有參考音檔的話很適合,也不會有拿真人聲優聲音的授權問題。
- 要 PyTorch + FlashAttention 2,在 Windows 原生安裝很麻煩,建議 worker 跑在 WSL2 / Docker。
- 97ms 是官方宣稱的數字,要在 4070S 上跟遊戲同時跑實測。

## 2. 重要架構決策(ADR 摘要)

1. **Module + 事件匯流排 + service registry**,module 之間不直接依賴。理由:能啟停、能熱換、測試時可以 mock。
2. **節點主動往外連 Core**:直播機在 NAT 後面也能用,server 不需要開額外連入埠給直播機。
3. **擴充套件跨行程**,不用 dylib:Rust 沒有穩定 ABI,dylib 崩潰會拖垮整個 Core;JSON-RPC 讓 TS 成為一等公民。
4. **遊戲用雙速控制**:LLM 只做高階決策與實況,即時操作交給 adapter。
5. **工具權限以觸發者為準**,好感 / 權限不能被對話修改:防 prompt injection 的核心。
6. **記憶有隱私範圍**:跨伺服器共享人格,但不洩漏私人內容。
7. **語音預設不存原始音訊**。
8. **單一執行檔多子指令**(`miyoria core|stage|worker|...`):散佈、版本對齊都簡單;Stage 專用的依賴用 Cargo feature 控制。
9. **Discord 雙帳號、單一大腦**(2026-11-01,擁有者決定並自負風險):bot 帳號負責文字與指令,self 帳號負責語音與 Go Live。兩條連線都不存狀態,資料全部在 Core;Scheduler 依 lane 路由動作。self 連線是可以拔掉的獨立節點,壞了只影響語音與 Go Live。
10. **角色 = profile,模型綁在 profile 上**:Miyoria 是框架,角色是 profile(人格 + LLM + 聲音 + 模型)。所有資料從第一天就帶 `profile_id`,之後加角色不用搬資料。
11. **Minecraft 走客戶端模組**:她開真正的 Minecraft 客戶端,Fabric 橋接模組(Java)以 Baritone(+ AltoClef)提供技能與反射,透過本機 WebSocket 給 TS adapter 用;畫面就是她的遊戲視窗。mineflayer(fork minecraft-mcp-server)當備案。LLM 只下高階目標,不直接操作底層動作。
12. **Profile = 一個完整角色**(人格 + LLM + 聲音 + Live2D);profile 內的人格段落可以在執行期修改(有版本紀錄)。LLM 的用途設定叫 `purposes`(避免跟對話 role、權限 role 混淆)。

## 3. 風險

| # | 風險 | 影響 | 對策 |
|---|---|---|---|
| R1 | **Discord 語音 E2EE(DAVE 協定)**:Discord 已經推行語音端對端加密,self-bot 函式庫收語音、推 Go Live 都要支援 | 語音與 Go Live 卡住 | Phase 0 第一個 spike 就驗證候選函式庫能不能在 DAVE 下分別接收每個人的音訊、送出音訊、推流。不行就評估其他函式庫或自己補 DAVE(`@discordjs/voice` 的實作可參考) |
| R2 | **Self 帳號被封 / 函式庫失效**:self-bot 違反服務條款;Discord 改協定時函式庫常壞 | 語音與 Go Live 停擺 | 用專用小帳號、不用主帳號;self 帳號不發文字、行為保守;掉線時自動降級(文字照常,bot 可用 songbird 接手「只說不聽」);Go Live 同時可推 Twitch / YouTube 當備案。擁有者已知悉並自負風險 |
| R3 | **12GB VRAM 不夠**:遊戲 + OBS 編碼 + ASR + TTS 同時跑 | 卡頓、OOM | LLM 走雲端;ASR 選小模型(SenseVoice-Small 約 1GB 以內);TTS 實測 VRAM;OBS 用 NVENC;必要時 ASR 改在 server CPU 或雲端 |
| R4 | **語音延遲**:split 部署時音訊要在兩台機器間來回 | 對話不自然 | self voice node 跟 ASR/TTS 放同一台直播機;全程串流;第一句先出聲 |
| R9 | **Go Live 吃資源**:self voice node 用 ffmpeg 轉碼,跟遊戲、OBS 搶 GPU / CPU | 卡頓 | 盡量用 NVENC;直接吃 OBS 已編碼的串流避免重複編碼(spike 驗證) |
| R5 | **LLM 成本**:ambient 模式在熱鬧的伺服器會一直判斷 | 帳單爆炸 | 三層 attention(便宜的先篩)、prompt caching、預算硬上限、自動降級 |
| R6 | **人格漂移 / 記憶污染**:被使用者灌輸錯誤事實 | 人格崩壞 | facts 有來源與信心值;self memory 只能由系統寫入;Panel 可以審核 / 回滾 |
| R7 | **範圍太大做不完** | 專案停擺 | 每個 phase 都有可以實際用的成果;先做出「會聊天的 Discord bot」,再加語音 |
| R8 | **語音隱私與法規**:收錄他人語音 | 被檢舉、法律問題 | 公告、使用者同意、預設不存音訊、資料刪除權 |
| R10 | **Minecraft 版本綁定**:Baritone / AltoClef 各自只支援特定版本(AltoClef 目前最高 1.21.1) | 遊戲更新後模組不能用 | 直播用的客戶端固定版本,不跟著自動更新 |
| R11 | **角色名稱用到 DeepSeek 商標** | 公開營利時可能有商標疑慮 | 個人使用沒問題;要公開營利再評估是否改名 |

## 4. 已確認(2026-11-01)

- **LLM**:擁有者自己處理 API;第一個角色用 DeepSeek。預算與模型選擇由擁有者決定。
- **第一個角色**:鯨魚娘 DeepSeek-chan,有點傲嬌的少女。設定在 `profiles/deepseek-chan/`。
- **Live2D 模型**:Kamiya_Ryoko 的免費 DeepSeek-chan 模型。可用於商業內容、可修改,但不可原樣再散佈 → 模型檔只放本機。
- **聲音**:沒有參考音 → 用 Qwen3-TTS VoiceDesign 依描述生成,再固定成 clone 的參考音。
- **第一款遊戲**:Minecraft,走客戶端模組路線(見 ARCHITECTURE §12.4)。
- **直播平台**:目前只做 Discord;Twitch / YouTube 等做成可開關的 platform module,之後再加。
- **說話風格**:不刻意用台灣用語;會自然夾雜 baka、hentai 這類動漫日文。

## 5. 待你確認的問題

這些不會擋住 Phase 0 / Phase 1,但越早決定越好:

1. **Server**:後端要放哪裡(VPS / 家用 server / NAS)?有沒有 GPU?
2. **開源與授權**:要開源嗎?(影響授權選擇,以及能不能用某些模型的權重)
3. **Panel 框架**:預設 React,可以接受嗎?
