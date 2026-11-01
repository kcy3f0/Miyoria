# Miyoria

全能 AI waifu:常駐在 Discord 聊天、加入語音聽大家講話並自然插話、有記憶和好感度,也能以 VTuber 形式直播玩遊戲。整個系統由可以獨立啟停的子系統組成,用 TypeScript 擴充套件和 MCP 往外延伸。

- 後端:Rust(Core / Stage / Worker 節點,可分機部署,server 端可以用 Docker)
- 前端與擴充:TypeScript(管理面板、OBS overlay、`@miyoria/sdk`)

## 文件

- [架構設計](docs/ARCHITECTURE.md):節點拓撲、kernel / 子系統模型、agent、記憶、社交、佇列、擴充、語音、直播、遊戲
- [技術決策與風險](docs/DECISIONS.md):技術選型、ADR、風險、待確認問題
- [Roadmap](docs/ROADMAP.md):Phase 0–8 與每個階段的完成條件
- [第一個角色:DeepSeek-chan](profiles/deepseek-chan/persona/identity.md):傲嬌鯨魚娘(草稿)

## 快速開始

```bash
cargo build
cargo run -- init      # 填 LLM base URL / API key / 模型 id、Discord token
cargo run -- doctor    # 檢查連線
cargo run -- chat      # 在終端機跟她聊天
cargo run -- core      # 啟動 Discord bot
```

### 語音(Phase 2)

1. 啟動 ASR / TTS worker:見 [workers/README.md](workers/README.md)(沒有 GPU 可以先用 `workers/fake`)
2. `cargo run -- core`
3. 在直播機啟動 self 帳號語音節點:見 [apps/voice-node/README.md](apps/voice-node/README.md)(`VOICE_LINK_TOKEN` 要跟 core 的 `.env` 一樣)
4. 在 Discord 打 `/join`

### 其他節點與工具

- `cargo run -- stage`:直播機上的 Stage 節點(VTube Studio、OBS、overlay),見 [docs/protocols/stage-link.md](docs/protocols/stage-link.md)
- 管理面板:`cd apps/panel && pnpm install --ignore-workspace && pnpm build`,之後 core 會在 http://127.0.0.1:7878/ 提供
- 擴充套件:`cargo run -- ext new my-ext`、`cargo run -- ext dev`
- Minecraft:[extensions/minecraft/README.md](extensions/minecraft/README.md)
- 部署與維運:[docs/OPERATIONS.md](docs/OPERATIONS.md)

> 目前狀態:Phase 0–8 的程式都寫完了(見 [Roadmap](docs/ROADMAP.md)),Rust 測試 556 個全過;**尚未用真的 Discord、DeepSeek、語音模型、VTube Studio、OBS、Minecraft 實測**。
