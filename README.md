# Miyoria

全能 AI waifu:常駐在 Discord 聊天、加入語音聽大家講話並自然插話、有記憶和好感度,也能以 VTuber 形式直播玩遊戲。整個系統由可以獨立啟停的子系統組成,用 TypeScript 擴充套件和 MCP 往外延伸。

- 全部用 TypeScript(Node 24、pnpm workspace):Core / Stage 節點、self 帳號語音節點、管理面板、OBS overlay、`@miyoria/sdk`;GPU 推論 worker 是 Python(`workers/`)
- 資料預設存 SQLite(Node 內建的 `node:sqlite`,不用裝資料庫);要向量檢索或放 server 時可改 PostgreSQL + pgvector
- 節點之間用 WebSocket + JSON,可分機部署;server 端可以用 Docker

## 文件

- [架構設計](docs/ARCHITECTURE.md):節點拓撲、kernel / 子系統模型、agent、記憶、社交、佇列、擴充、語音、直播、遊戲
- [技術決策與風險](docs/DECISIONS.md):技術選型、ADR、風險、待確認問題
- [Roadmap](docs/ROADMAP.md):Phase 0–8 與每個階段的完成條件
- [部署與維運](docs/OPERATIONS.md):部署型態、Docker、升級、備份、日誌、安全檢查表
- [TS 程式慣例](docs/TS-CONVENTIONS.md):workspace 結構、命名、錯誤、設定、kernel API
- [第一個角色:DeepSeek-chan](profiles/deepseek-chan/persona/identity.md):傲嬌鯨魚娘(草稿)

## 快速開始

需要 Node ≥ 24。在一個空資料夾裡:

```bash
npx miyoria@latest init     # 建立 miyoria.toml、.env 和 profiles/:LLM base URL / API key / 模型 id、Discord token
# 打開 .env,補上還沒填的值(LLM_API_KEY、DISCORD_BOT_TOKEN、MIYORIA_OWNER_ID…)
npx miyoria doctor          # 檢查設定、profile、LLM、Discord、資料庫
npx miyoria chat            # (可選)在終端機跟她聊天,不需要 Discord
npx miyoria core            # 啟動 Core:Discord bot + Admin API,管理面板在 http://127.0.0.1:7878/
```

資料存在 `data/miyoria.db`(SQLite)。之後改設定用 `npx miyoria config`,`npx miyoria --help` 看所有指令。

### 從原始碼開發

```bash
corepack enable             # 用 package.json 指定的 pnpm 9
pnpm install
pnpm dev init               # = miyoria init(tsx 直接跑 packages/cli/src,不用 build)
pnpm dev doctor
pnpm dev:core               # = miyoria core
pnpm test                   # 每個套件的 Vitest;pnpm typecheck、pnpm lint 同理
```

`pnpm dev <指令>` 等於 `miyoria <指令>`。打包成 npm 套件:`pnpm build:web && pnpm --filter miyoria build`(esbuild,輸出 `packages/cli/dist/`),`pnpm release:pack` 會產生 tarball。

### 語音(Phase 2)

1. 啟動 ASR / TTS worker:見 [workers/README.md](workers/README.md)(沒有 GPU 可以先用 `workers/fake`)
2. `miyoria core`
3. 在直播機啟動 self 帳號語音節點:見 [apps/voice-node/README.md](apps/voice-node/README.md)(`VOICE_LINK_TOKEN` 要跟 core 的 `.env` 一樣)
4. 在 Discord 打 `/voice join`(`/help` 會列出你能用的所有指令)

### 其他節點與工具

- `miyoria stage`:直播機上的 Stage 節點(VTube Studio、OBS、overlay),見 [docs/protocols/stage-link.md](docs/protocols/stage-link.md)
- 管理面板:npm 套件已內含;從原始碼用 `pnpm build:web`,之後 core 會在 http://127.0.0.1:7878/ 提供
- 擴充套件:`miyoria ext new my-ext`、`miyoria ext dev`
- Minecraft:[extensions/minecraft/README.md](extensions/minecraft/README.md)
- Docker:[deploy/README.md](deploy/README.md)

> 目前狀態:Phase 0–8 的程式都寫完了,並從 Rust 原型改寫成 TypeScript(Rust 原型留在 git 歷史裡);用假 LLM、假語音節點、假 worker 跑過端到端流程(見 [Roadmap](docs/ROADMAP.md))。**尚未用真的 Discord、DeepSeek、語音模型、VTube Studio、OBS、Minecraft 實測**。
