# 部署與維運手冊

這份文件講「怎麼把 Miyoria 跑起來並維持運作」:選部署型態、第一次設定、啟動各節點、Discord 設定、升級、備份、日誌、安全與疑難排解。架構背景見 [ARCHITECTURE.md](ARCHITECTURE.md) §1、§16。

> 狀態:Phase 1(文字)、Phase 2(語音)已實作。Stage 節點(`miyoria stage`)、管理面板(`apps/panel`)、overlay 還沒有,對應的段落標示「之後」,埠號和 compose 設定先預留好。

## 目錄

1. [節點與埠](#1-節點與埠)
2. [部署型態](#2-部署型態)
3. [第一次設定](#3-第一次設定)
4. [啟動各個節點](#4-啟動各個節點)
5. [Discord 設定](#5-discord-設定)
6. [升級](#6-升級)
7. [備份與還原](#7-備份與還原)
8. [日誌](#8-日誌)
9. [安全檢查表](#9-安全檢查表)
10. [疑難排解](#10-疑難排解)

---

## 1. 節點與埠

| 節點 | 怎麼跑 | 在哪 | 對外埠(預設) |
|---|---|---|---|
| **Core** | `miyoria core`(原生或 Docker) | 直播機或 server | `7878` Admin API(CLI / 面板)、`7879` voice link(voice node 連進來)、`7882` stage link(之後) |
| **PostgreSQL** | `deploy/docker-compose.yml` | 跟 Core 同一台 | `5432`(只綁 127.0.0.1) |
| **Self voice node** | `apps/voice-node`(Node ≥ 22) | 直播機(跟 ASR/TTS、OBS 同一台最好) | 不開埠,主動連 Core 的 7879 |
| **ASR / TTS worker** | `workers/`(Python,GPU) | 有 GPU 的機器 | `8001` ASR、`8002` TTS(只給 Core 用,不要對外) |
| **Stage**(之後) | `miyoria stage`(原生,不放 Docker) | 直播機 | 主動連 Core 的 7882 |

節點一律**主動往外連** Core,所以直播機在 NAT 後面不用做任何 port forwarding。

**所有埠預設都只綁 `127.0.0.1`。7878 / 7879 / 7882 永遠不要直接開到公網**(見 [§9](#9-安全檢查表))。

## 2. 部署型態

### A. All-in-one(一台機器全包)

開發或自己小規模使用。全部跑在直播機(Windows)上。

| 在直播機上 | 怎麼跑 |
|---|---|
| Postgres(可省略,用 `memory://` 就不保存) | `docker compose -f deploy/docker-compose.yml up -d postgres` |
| Core | `cargo run --release -- core` |
| ASR / TTS worker | 見 [workers/README.md](../workers/README.md)(沒有 GPU 先用 `workers/fake`) |
| Voice node | `cd apps/voice-node && pnpm start` |

所有 URL 都是預設的 `127.0.0.1`,不用改任何位址。

### B. Split:Core 在 server,語音與 Stage 在直播機(目標型態)

Core + Postgres 在 server(Docker),直播機跑 worker、voice node、Stage。Discord 語音音訊在直播機上直接進 ASR、TTS 直接出,不繞 server 一圈。

```
直播機(Windows)                               Server(Linux, Docker)
┌──────────────────────────┐   voice link     ┌─────────────────────────┐
│ voice node ──────────────┼──── ws/wss ────▶ │ Core :7879              │
│ ASR :8001 / TTS :8002 ◀──┼── HTTP(經 tunnel)│  ├ Admin API :7878       │
│ Stage(之後)─────────────┼── ws/wss ────▶   │  └ Postgres :5432        │
└──────────────────────────┘                  └─────────────────────────┘
```

重點:

- Core 要呼叫直播機上的 ASR / TTS,所以 server 必須連得到那兩個埠。**不要把 8001/8002 開到公網**,走 Tailscale / WireGuard:Core 的 `ASR_URL=http://<直播機 tailnet IP>:8001`、`TTS_URL=http://<直播機 tailnet IP>:8002`,worker 啟動時用 `HOST=<tailnet IP>`(或只綁 tailnet 網卡)。
- 想少做網路設定,用 **B'**(下一節):語音推論也放 server。
- voice link 跨網路要走加密,見 [§9](#9-安全檢查表)。

Server 上:

```bash
git clone <repo> miyoria && cd miyoria
cp deploy/.env.example deploy/.env        # 改 POSTGRES_PASSWORD(只用字母數字 - _ .)
# 在專案根目錄產生 .env 與 miyoria.toml:可以在任何機器跑 `miyoria init` 再把 .env 複製過來,
# 或直接手動從 .env.example 建立,token 用 `openssl rand -hex 32` 產生
docker compose -f deploy/docker-compose.yml --profile core up -d --build
docker compose -f deploy/docker-compose.yml --profile core ps      # 等 core 變成 healthy
```

`core` 服務由 [`deploy/Dockerfile.core`](../deploy/Dockerfile.core) 建出來,使用 [`deploy/miyoria.docker.toml`](../deploy/miyoria.docker.toml) 當設定(容器內監聽 0.0.0.0,宿主機端只映射到 `127.0.0.1`)。要改設定,複製那個檔案,在 `deploy/.env` 設 `MIYORIA_CONFIG_FILE=<路徑>`。

### B'. Split + 語音在 server

server 有 NVIDIA GPU 時,ASR / TTS(Linux 可用 vLLM-Omni)跟 Core 放同一台,直播機只跑 Stage 和 voice node,12 GB VRAM 留給遊戲和 OBS。步驟見 [deploy/speech/README.md](../deploy/speech/README.md)。Core 容器連同機器上的 worker 用 `host.docker.internal`(compose 已加 `extra_hosts`),或在根目錄 `.env` 設 `ASR_URL` / `TTS_URL`。

只有 voice link 要跨機器:收音每位說話者約 256 kbps 上傳、TTS 約 384 kbps 下載。

### C. Cloud-voice

Core 在 server,ASR / TTS 用雲端供應者(`miyoria.toml` 的 `[speech.*]` 改 `kind = "openai"` 等),直播機只跑 Stage(和 voice node)。不需要 GPU,延遲與費用取決於供應者。

### 選哪個?

| 情況 | 建議 |
|---|---|
| 先試試看、開發 | A |
| 想讓她 24 小時待在 Discord 文字頻道,但直播機不是常開 | B(Core 在 server,語音只在直播時才開) |
| server 有好 GPU | B' |
| 沒有 GPU | C(或 A 搭配 SenseVoice CPU ASR + 雲端 TTS) |

## 3. 第一次設定

需求:Rust stable(`rust-toolchain.toml` 會自動選)、Docker(要 Postgres 或 Core 容器時)、Node ≥ 22 + pnpm 9(voice node)。

```bash
cargo build --release                  # 或開發時 cargo build
cargo run --release -- init            # 互動式精靈
cargo run --release -- doctor          # 檢查連線
cargo run --release -- profile validate
cargo run --release -- chat            # 在終端機跟她聊天,不需要 Discord
```

`miyoria init` 會:

- 寫 `miyoria.toml`(從 `miyoria.example.toml`)和 `.env`(秘密放這裡,不進 git);
- 詢問 LLM base URL / API key / 模型 id、Discord bot token、你的 Discord user id(擁有者);
- 自動產生 `MIYORIA_API_TOKEN` 和 `VOICE_LINK_TOKEN`;
- 資料庫二選一:`memory://`(重啟就沒了,先試用)或 Postgres。

`miyoria doctor` 檢查設定檔、profile、LLM、Discord、資料庫連線。每次改完設定、換機器、升級後都先跑一次。

### 資料庫

```bash
cp deploy/.env.example deploy/.env            # 改 POSTGRES_PASSWORD
docker compose -f deploy/docker-compose.yml up -d postgres
docker compose -f deploy/docker-compose.yml ps    # 等 healthy
```

根目錄 `.env` 設:

```
DATABASE_URL=postgres://miyoria:<密碼>@127.0.0.1:5432/miyoria
```

migration 在 Core 第一次連上資料庫時自動執行,`vector` 擴充也是那時建立,不需要手動處理。

> `deploy/.env`(給 docker compose 用:資料庫密碼、埠)和根目錄 `.env`(給 Miyoria 用:LLM key、Discord token、各種 token)是兩個不同的檔案。Core 容器會自動把 `DATABASE_URL` 換成 compose 網路上的 `postgres:5432`,所以根目錄 `.env` 可以保留給宿主機用的 `127.0.0.1` 位址。

## 4. 啟動各個節點

### Core

原生:

```bash
cargo run --release -- core        # 或 ./target/release/miyoria core
```

Docker:

```bash
docker compose -f deploy/docker-compose.yml --profile core up -d --build
docker compose -f deploy/docker-compose.yml --profile core logs -f core
docker compose -f deploy/docker-compose.yml --profile core down       # 停止(資料 volume 保留)
```

只想要資料庫、Core 自己用 `cargo run`:不加 `--profile core`,只會啟動 `postgres`。

Core 起來之後,用 CLI 操作(CLI 讀 `miyoria.toml` 的 `[modules.api]` 連 `127.0.0.1:7878`;Core 在 server 時,先 `ssh -L 7878:127.0.0.1:7878 <server>` 或走 Tailscale):

```bash
miyoria status                  # 各模組狀態、LLM 用量
miyoria module list             # enable / disable / restart <id> 可以單獨啟停子系統
miyoria decisions               # 她為什麼回話或沉默
miyoria events 'agent.*'        # 即時事件
miyoria persona show
```

### Voice node(直播機)

```bash
cd apps/voice-node
pnpm install --ignore-workspace
cp .env.example .env            # 填 SELF_TOKEN、VOICE_LINK_URL、VOICE_LINK_TOKEN
pnpm start                      # 或 pnpm build && pnpm start:dist
```

- `VOICE_LINK_TOKEN` 必須跟 Core 的 `.env` 一樣。
- `VOICE_LINK_URL`:同機 `ws://127.0.0.1:7879/voice-link`;跨機用 `ws://<tailnet-ip>:7879/voice-link` 或 `wss://voice.example.com/voice-link`。
- 啟動後在 Discord 打 `/join`,她就會進你所在的語音頻道。詳細設定見 [apps/voice-node/README.md](../apps/voice-node/README.md)。
- 長期運行建議用行程管理員:Windows 用工作排程器「登入時執行」或 NSSM,Linux 用 systemd / pm2。`Ctrl+C` / SIGTERM 會先離開語音頻道再結束。

### 推論 worker

見 [workers/README.md](../workers/README.md)。最短路徑:

```bash
cd workers
python -m venv .venv && .venv/Scripts/pip install -r fake/requirements.txt   # Linux: .venv/bin/pip
.venv/Scripts/python fake/fake_server.py       # 沒有 GPU 時先用這個,http://127.0.0.1:8000
```

真的 worker:SenseVoice ASR(`:8001`)、Qwen3-TTS(`:8002`),或 `workers/docker-compose.yml`(需要 NVIDIA container toolkit)。Core 端用 `ASR_URL` / `TTS_URL`(根目錄 `.env`)指到它們。檢查 worker 是否符合協定:

```bash
WORKER_ASR_URL=http://127.0.0.1:8001 WORKER_TTS_URL=http://127.0.0.1:8002 python -m pytest tests/test_contract.py
```

### Stage 與管理面板(之後)

Stage 要直接碰 VTube Studio / OBS / 遊戲,所以原生在直播機執行,不放 Docker,啟動方式之後補上(`miyoria stage`)。管理面板是靜態檔,由 Core 提供:build 好 `apps/panel/dist` 後,用 `--build-arg PANEL_DIST=apps/panel/dist`(compose:`deploy/.env` 設 `PANEL_DIST=apps/panel/dist`)把它放進 Core 映像檔。

## 5. Discord 設定

她用**兩個帳號**:官方 bot 帳號負責文字與指令;self 帳號只負責語音。

### 官方 bot 帳號(文字 + 指令)

1. 到 <https://discord.com/developers/applications> 建立 Application,在 **Bot** 頁籤新增 bot,複製 token 放進 `.env` 的 `DISCORD_BOT_TOKEN`。
2. **Bot → Privileged Gateway Intents** 打開 **Message Content Intent**。沒開的話 gateway 會拒絕連線,模組會一直失敗。
3. **OAuth2 → URL Generator** 勾 scope `bot` 與 `applications.commands`,權限:View Channels、Send Messages、Send Messages in Threads、Read Message History、Add Reactions。用產生的網址邀請進伺服器。
4. 在 Discord 打開開發者模式(設定 → 進階),對自己按右鍵「複製使用者 ID」,填到 `MIYORIA_OWNER_ID`(擁有者權限)。
5. 想讓 slash command 立刻生效,把伺服器 id 填進 `miyoria.toml` 的 `[modules."platform.discord.bot"] command_guilds`;留空是全域註冊,最多要等一小時。
6. 用 `miyoria doctor` 確認 token 有效,`miyoria module list` 看 `platform.discord.bot` 是 running。

### Self 帳號(語音)

- **用專用小帳號,不要用主帳號。** Self-bot 違反 Discord 服務條款,帳號可能被封,風險由擁有者自行承擔(ARCHITECTURE §11.2)。
- 把 self 帳號加進她要待的伺服器,並給語音頻道的「檢視頻道」「連線」「說話」權限。
- user token 只放在 voice node 所在機器的 `apps/voice-node/.env`(`SELF_TOKEN`),**不要**放進 Core 的設定,也不要貼到任何地方。
- 收音前要讓頻道裡的人知道她在聽(`[modules.voice] consent`:`opt-out` 預設收音、可退出;`opt-in` 同意後才收)。

### 管理面板的 Discord 登入(選用)

面板預設用 admin token 登入;開了這個之後,也可以按「使用 Discord 登入」(token 照樣能用,CLI 一直用 token)。

1. 在同一個 Application 的 **OAuth2** 頁籤:**Client ID** 就是 Application ID,填 `.env` 的 `DISCORD_CLIENT_ID`;按 **Reset Secret** 取得 **Client Secret**,填 `DISCORD_CLIENT_SECRET`。
2. **OAuth2 → Redirects** 新增 redirect URL,例如 `http://127.0.0.1:7878/api/auth/oauth/callback`。
3. 在 `miyoria.toml` 打開 `[modules.api.discord_oauth]`(見 `miyoria.example.toml`),`redirect_uri` 填**一模一樣**的網址,重啟 Core。`miyoria` 日誌會出現 `Discord login for the panel is on`。
4. 用瀏覽器開**跟 redirect_uri 同一個 origin** 的面板網址(上例就是 `http://127.0.0.1:7878/`,不是 `localhost:7878`):登入用的 cookie 只屬於那個 origin。開發時用 Vite(`pnpm dev`)就另外登記 `http://localhost:5178/api/auth/oauth/callback`、把 `redirect_uri` 改成它,並用 `http://localhost:5178` 開面板;Vite 的 proxy 會轉給 Core。

誰能登入:

- `[modules.auth] owners` 裡的擁有者,以及**全域**指派了 `admin` 角色的人(`*` / `admin.*` 已包含 `admin.panel.access` 與 `admin.panel.write`)。其他人會看到「沒有管理面板權限」。
- 開放給其他角色:`/admin perm allow role:moderator node:admin.panel.access scope:global`(唯讀,修改類按鈕會停用),要能修改再加 `node:admin.panel.write`。面板檢查時沒有伺服器 / 頻道,所以只算 `scope:global` 的指派與覆寫。
- 拿掉角色或權限後幾秒內生效,已登入的人會被送回登入畫面。登入 session 預設 7 天(`session_days`),存在資料庫(只存 token 的雜湊),Core 重啟不會掉;登出會立刻刪掉。

從別台機器用面板:cookie 和 token 都會走明文 HTTP,所以要嘛走 Tailscale(`redirect_uri` 用 tailnet 位址,例如 `http://100.x.y.z:7878/api/auth/oauth/callback`,並把 `[modules.api] bind` 綁到那個位址),要嘛放在 https 反向代理後面(`redirect_uri = "https://panel.example.com/api/auth/oauth/callback"`,cookie 自動加上 `Secure`)。無論哪種,Developer Portal 的 redirect、`redirect_uri` 和你在瀏覽器開的網址三者要一致。

## 6. 升級

**原則:先備份,再升級,升級後跑 `doctor`。**

```bash
scripts/backup.sh                           # Windows: scripts\backup.ps1
git pull
```

原生 Core:

```bash
cargo build --release
miyoria doctor
# 重啟 core(Ctrl+C 後再 cargo run --release -- core,或你的行程管理員)
```

Docker Core:

```bash
docker compose -f deploy/docker-compose.yml --profile core up -d --build   # 重建映像檔並換掉容器
docker compose -f deploy/docker-compose.yml --profile core logs -f core
```

- 資料庫 migration 在 Core 啟動時自動往前套用。**migration 不會自動回退**,要降版就是「還原備份 + 換回舊版映像檔」。
- 想保留舊版可回退:升級前 `docker tag miyoria-core:local miyoria-core:previous`,出問題時在 `deploy/.env` 設 `MIYORIA_IMAGE=miyoria-core:previous`,`up -d` 時不加 `--build`。
- voice node:`git pull && cd apps/voice-node && pnpm install --ignore-workspace && pnpm build`,再重啟。Core 與 voice node 的協定版本不符會用 close code `4400` 拒絕連線,兩邊要一起升級。
- 設定檔有新欄位時,對照 `miyoria.example.toml` 手動合併(`miyoria init` 不會覆寫你的 `miyoria.toml` 除非你同意)。
- Postgres 大版本(例如 17 → 18)升級不能直接換 image tag:先備份,用新版 image 開一個新 volume,再還原。

## 7. 備份與還原

### 要備份什麼

| 項目 | 位置 | 怎麼備份 |
|---|---|---|
| 資料庫(記憶、好感、決策紀錄、persona 歷史) | compose 的 `pgdata` volume | `scripts/backup.sh` / `scripts\backup.ps1` |
| 設定與秘密 | 根目錄 `.env`、`miyoria.toml`、`deploy/.env` | 手動複製到安全的地方(**不要進 git、不要上傳到公開處**) |
| 角色 profile | `profiles/` | 在 git 裡;但 `profiles/*/avatar/model/` 與 `voice/*.wav` 因授權不進 git,要另外備份 |
| 聲音檔 | `workers/voices/` | 手動備份 |

### 備份

```bash
scripts/backup.sh                    # -> backups/miyoria-YYYYMMDD-HHMMSS.dump
scripts/backup.sh --keep 30          # 保留最新 30 份(預設 14,0 = 全部保留)
scripts/backup.sh --dir /mnt/nas     # 寫到別處(環境變數 BACKUP_DIR / BACKUP_KEEP 也可以)
```

```powershell
scripts\backup.ps1
scripts\backup.ps1 -Keep 30 -Dir D:\nas
```

腳本用 `pg_dump -Fc`(壓縮的 custom format)從 compose 的 `postgres` 容器匯出,先寫成 `.partial` 驗證能讀才改名,所以不會留下壞檔。`backups/` 已被 `.gitignore` 排除。需要 `postgres` 服務正在執行。

定期備份:

```cron
# Linux crontab -e:每天 03:30
30 3 * * * cd /srv/miyoria && scripts/backup.sh --keep 30 >> backups/backup.log 2>&1
```

```powershell
# Windows 工作排程器(每天 03:30)
schtasks /Create /SC DAILY /ST 03:30 /TN "Miyoria Backup" /TR "pwsh -NoProfile -File C:\path\to\miyoria\scripts\backup.ps1 -Keep 30"
```

**備份要放到另一台機器或雲端**(`rsync`、`rclone`、NAS),同一顆硬碟上的備份擋不住硬碟故障。

### 還原

**會取代資料庫目前的內容。**

```bash
scripts/restore.sh backups/miyoria-20260101-033000.dump
scripts/restore.sh --latest          # 最新一份
scripts/restore.sh --yes <檔案>       # 不問確認(給自動化用)
```

```powershell
scripts\restore.ps1 backups\miyoria-20260101-033000.dump
scripts\restore.ps1 -Latest
```

- 如果 Core 在 Docker 裡跑,腳本會先停掉它、還原完再啟動;原生跑在宿主機的 Core 要你自己先停。
- 還原用 `--clean --if-exists --single-transaction`:失敗會整個回滾,不會留下半套資料。
- 換新機器:裝好 Docker、`up -d postgres`、複製 `deploy/.env` 與根目錄 `.env`、還原備份、再啟動 Core。
- **還原演練**:至少做過一次(例如在另一台機器或另一個 compose 專案名稱下還原),才算有備份。

## 8. 日誌

Rust 端用 `tracing`,層級由環境變數 `RUST_LOG` 控制,沒設時用 `miyoria.toml` 的 `[core] log`(預設 `info,miyoria=debug`)。

```bash
RUST_LOG=info cargo run --release -- core                         # 安靜
RUST_LOG=info,miyoria=debug cargo run --release -- core           # 預設
RUST_LOG=info,miyoria_voice=trace,miyoria_speech=debug ... core   # 查語音管線
RUST_LOG=warn,miyoria_discord=debug ... core                      # 只看 Discord adapter
```

crate 名稱的 `-` 在 `RUST_LOG` 裡要寫成 `_`。

Docker:

```bash
docker compose -f deploy/docker-compose.yml --profile core logs -f core
docker compose -f deploy/docker-compose.yml --profile core logs --since 1h core
docker compose -f deploy/docker-compose.yml logs -f postgres
```

在 `deploy/.env` 設 `RUST_LOG=...` 再 `up -d` 就能改容器內的層級。Docker 預設的 json-file 日誌沒有大小上限,長期運行建議在 `/etc/docker/daemon.json` 設 `"log-driver": "local"` 或 `"log-opts": {"max-size": "20m", "max-file": "5"}`。

不用看 log 也能知道她在想什麼:

```bash
miyoria decisions -l 50      # 最近的 attention 決策:回話或沉默,以及原因
miyoria events 'agent.*'     # 即時事件串流(依 topic 過濾)
miyoria status               # LLM 用量(token、費用)
```

Voice node 的層級用它的 `LOG_LEVEL`(`error|warn|info|debug`);`debug` 會印出 `@discordjs/voice` 與 DAVE 的細節。Worker 的日誌在各自的終端機(或 `docker compose logs`)。

## 9. 安全檢查表

上線前逐項確認:

- [ ] **Token 都是隨機長字串**:`MIYORIA_API_TOKEN`、`VOICE_LINK_TOKEN` 由 `miyoria init` 產生(或 `openssl rand -hex 32`);`POSTGRES_PASSWORD` 不是 `change-me`。
- [ ] **秘密不進 git**:`.env`、`deploy/.env`、`miyoria.toml`、`secrets.toml` 都在 `.gitignore`;`git status` 看不到它們。Docker 映像檔不含 `.env`(`deploy/Dockerfile.core.dockerignore` 已排除),不要把映像檔推到公開 registry 前自行 `docker history` 檢查。
- [ ] **全部綁 127.0.0.1**:`docker compose ... ps` 的 PORTS 欄看到的是 `127.0.0.1:7878->7878/tcp`,不是 `0.0.0.0:`。原生 Core 的 `[modules.api] bind`、`[modules."voice.link"] bind` 維持 `127.0.0.1:...`。`miyoria.docker.toml` 裡的 `0.0.0.0` 只是容器內部的位址,對外與否由 compose 的 `ports:` 決定,不要把 `ports:` 的 `127.0.0.1:` 前綴拿掉。
- [ ] **7878 / 7879 / 7882(以及 8001 / 8002 / 5432)沒有直接開到公網**:防火牆(`ufw`、雲端 security group)對這些埠預設全擋。Docker 發布的埠會繞過 `ufw`,所以更要靠 `127.0.0.1` 綁定而不是靠防火牆。
- [ ] **跨機器連線有加密**:
  - **Tailscale / WireGuard(最簡單)**:`bind` 改成 server 的 tailnet IP(compose 的 `ports:` 也改成 `<tailnet-ip>:7879:7879`),voice node 用 `VOICE_LINK_URL=ws://<tailnet-ip>:7879/voice-link`。tailnet 內部流量本身已加密。
  - **wss 反向代理**:Caddy / nginx 把 `wss://voice.example.com/voice-link` 轉到 `127.0.0.1:7879`,voice node 用 `wss://...`。Admin API 同理(要從遠端用面板時),且不要在代理上放寬 `Authorization` 檢查。
  - SSH tunnel 也行:`ssh -L 7878:127.0.0.1:7878 <server>`。
  - 面板開了 Discord 登入時,遠端只用 https 或 tailnet 位址,且 `redirect_uri` 跟瀏覽器網址一致(見 [§5](#管理面板的-discord-登入選用))。
  - voice link 與 Admin API 本身是**明文** HTTP/WebSocket,token 和語音都看得到;不加密就不能跨網路。
- [ ] **Self 帳號 token**(`SELF_TOKEN`)只存在 voice node 那台機器的 `.env`,權限只有你自己的使用者可讀(Linux:`chmod 600 .env`)。
- [ ] **Discord bot 權限最小化**:邀請連結只勾上面列的權限,不要給 Administrator。
- [ ] **容器已降權**:Core 容器以非 root(uid 10001)執行、唯讀根檔案系統、`cap_drop: ALL`、`no-new-privileges`。Linux 上若 `profiles/` 不是這個 uid 擁有,用 `deploy/.env` 的 `MIYORIA_UID` / `MIYORIA_GID` 換成自己的,不要 `chmod 777`。
- [ ] **備份有加密或放在受信任處**:dump 內含所有人的對話記憶。
- [ ] **收音同意**:語音頻道有公告她在聽;`[modules.voice] consent` 設定符合你的社群規則;預設不存音訊。
- [ ] **成本煞車**:LLM 供應者後台設用量上限;用 `miyoria status` 定期看用量。
- [ ] **面板權限**:只有需要的角色有 `admin.panel.access` / `admin.panel.write`;`DISCORD_CLIENT_SECRET` 跟其他秘密一樣只放 `.env`。
- [ ] Token 外洩時:立刻到 Discord Developer Portal Reset Token / 換 self 帳號密碼,重新產生 `MIYORIA_API_TOKEN` / `VOICE_LINK_TOKEN`(刪掉 `.env` 裡那行再跑 `miyoria init`,或手動改),重啟所有節點。

## 10. 疑難排解

先做這三件事:`miyoria doctor`、看 log(§8)、`miyoria module list`。

| 現象 | 可能原因 / 做法 |
|---|---|
| `docker compose up` 說 `set POSTGRES_PASSWORD in deploy/.env` | 還沒建 `deploy/.env`:`cp deploy/.env.example deploy/.env`。用 `-f deploy/docker-compose.yml` 時,compose 讀的是 **deploy/** 底下的 `.env`。 |
| `--profile core` 說 `env file ...\.env not found` | 根目錄還沒有 `.env`:先跑 `miyoria init`(或手動建立)。 |
| `core` 容器一直重啟 / unhealthy | `logs core` 看原因。常見:`[modules.api] token is empty`(根目錄 `.env` 沒有 `MIYORIA_API_TOKEN`)、`cannot bind`(宿主機埠被佔用,在 `deploy/.env` 改 `API_PORT` 等)、`DATABASE_URL` 密碼含特殊字元(`@ : / %` 會讓 URL 解析失敗,改用字母數字密碼)。 |
| `core` 容器讀不到 `/profiles/...`、權限錯誤 | Linux:`profiles/` 擁有者不是 uid 10001。設 `MIYORIA_UID=$(id -u)`、`MIYORIA_GID=$(id -g)`。 |
| Core 連不到宿主機上的 ASR / TTS(容器內) | worker 要綁 `0.0.0.0` 或 docker bridge 位址才連得到(只綁 `127.0.0.1` 的 worker 容器內看不到);或把 `ASR_URL` / `TTS_URL` 設成別台的位址。 |
| `miyoria status` 說沒有設定 `MIYORIA_API_TOKEN` | 根目錄 `.env` 缺這一行;CLI 和 Core 要讀到同一個 token。 |
| `miyoria status` 連不上 | Core 沒在跑;或 Core 在遠端而沒有 tunnel(`ssh -L 7878:127.0.0.1:7878`);或 `[modules.api] bind` 不是 127.0.0.1:7878。 |
| 面板按「使用 Discord 登入」後 Discord 說 `Invalid OAuth2 redirect_uri` / 回來又是登入畫面 | Developer Portal 的 Redirects 沒有登記跟 `redirect_uri` 一模一樣的網址;或瀏覽器開的面板 origin(例如 `localhost`)跟 `redirect_uri`(`127.0.0.1`)不同,cookie 落在另一個 origin。登入畫面寫「沒有管理面板權限」就是帳號缺 `admin.panel.access`(見 [§5](#管理面板的-discord-登入選用))。 |
| `platform.discord.bot` 一直 failed | 沒開 Message Content Intent;或 token 錯 / 被 reset;`miyoria doctor` 會指出。 |
| Slash command 沒出現 | 全域註冊要等最多一小時;開發時填 `command_guilds`。Bot 邀請時要有 `applications.commands` scope。 |
| Voice node 印 `bad token` 後結束(close code 4401) | `VOICE_LINK_TOKEN` 跟 Core 的不一樣(注意 Core 容器吃的是根目錄 `.env`)。 |
| Voice node 結束,close code 4400 | Core 與 voice node 版本不符,兩邊都升級到同一版。 |
| Voice node 結束,close code 4409 | 同一個 self 帳號被另一個 voice node 取代了,確認沒有重複啟動。 |
| Voice node 一直重連 | `VOICE_LINK_URL` 不對,或 Core 的 7879 沒有發布出來(`docker compose ps`);跨機器時 Tailscale 沒連上。指數退避最長 30 秒。 |
| 她進語音但沒反應 | 用 `RUST_LOG=info,miyoria_voice=debug,miyoria_speech=debug` 看 log:ASR 有沒有收到、`ASR_URL` 對不對、worker `/health` 是否回 200(`curl http://127.0.0.1:8001/health`)。 |
| 語音延遲很高 | TTS 沒用真串流(看 worker `/health` 的 `streaming`);GPU 記憶體被遊戲吃光;跨網路的 voice link 延遲過大(改用 B')。 |
| 備份腳本說 `cannot reach the Docker daemon` | Docker Desktop / dockerd 沒啟動。 |
| 備份腳本說 `postgres service is not running` | `docker compose -f deploy/docker-compose.yml up -d postgres`。 |
| 還原後 Core 報 migration 錯誤 | 備份是比較新的版本做的,Core 比較舊:用同版或更新的 Core。 |
| 想完全重來 | `docker compose -f deploy/docker-compose.yml --profile core down -v` 會**刪掉資料庫與 Core 資料 volume**。先 `scripts/backup.sh`。 |
| 磁碟被 Docker 吃滿 | `docker system df`;`docker image prune`、`docker builder prune`;設定日誌輪替(§8)。 |
