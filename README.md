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

> 目前狀態:Phase 1(文字聊天 MVP)進行中。
