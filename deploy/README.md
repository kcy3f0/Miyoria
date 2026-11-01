# deploy

Docker 部署:PostgreSQL 17 + pgvector,以及(可選)Core 容器。完整的部署、升級、備份流程見 [docs/OPERATIONS.md](../docs/OPERATIONS.md)。

| 檔案 | 用途 |
|---|---|
| `docker-compose.yml` | `postgres` 服務(預設)+ `core` 服務(compose profile `core`) |
| `Dockerfile.core` | 建 `miyoria` 執行檔的多階段映像檔(cargo-chef 快取、非 root、`/data` volume) |
| `Dockerfile.core.dockerignore` | build 時排除 `.env`、`target/`、`node_modules/` 等 |
| `miyoria.docker.toml` | Core 容器用的設定(內建一份,compose 也會掛進去) |
| `.env.example` | compose 變數(資料庫密碼、埠),複製成 `deploy/.env` |
| `panel-placeholder/` | 管理面板還沒 build 時 `PANEL_DIST` 預設指向的空目錄 |
| `speech/` | 語音辨識 / 合成放在 Linux server 的 compose,見 [speech/README.md](speech/README.md) |

## 只要資料庫(本機開發)

Core 用 `cargo run -- core` 在宿主機跑。

```sh
cp deploy/.env.example deploy/.env   # 記得改密碼
docker compose -f deploy/docker-compose.yml up -d postgres
docker compose -f deploy/docker-compose.yml ps   # 等 STATUS 變成 healthy
```

不加 `--profile core` 時只會啟動 `postgres`,不需要根目錄的 `.env`。

- 只綁在 `127.0.0.1:5432`,不會對外開放;要換 port 就改 `deploy/.env` 的 `POSTGRES_PORT`。
- 資料存在名為 `miyoria_pgdata` 的 volume,`down` 不會刪資料;要清空就 `down -v`。
- `vector` 擴充由 Miyoria 第一次啟動時的 migration 建立,不需要手動處理。

## Core 也放進 Docker(server 部署)

```sh
cp deploy/.env.example deploy/.env   # 改 POSTGRES_PASSWORD(只用字母數字 - _ .)
miyoria init                         # 在專案根目錄產生 .env(LLM key、Discord token、各種 token)
docker compose -f deploy/docker-compose.yml --profile core up -d --build
docker compose -f deploy/docker-compose.yml --profile core ps      # core 要變成 healthy
docker compose -f deploy/docker-compose.yml --profile core logs -f core
```

- 兩個 `.env`:`deploy/.env` 給 compose(資料庫密碼、埠),根目錄 `.env` 給 Miyoria(秘密)。容器內的 `DATABASE_URL` 由 compose 組成,指向 `postgres:5432`。
- 埠一律只綁 `127.0.0.1`:`7878` Admin API、`7879` voice link、`7882` stage link(之後)。別台機器要連,走 Tailscale / SSH tunnel / wss 反向代理(見 OPERATIONS §9),不要改成 `0.0.0.0`。
- `profiles/` 以讀寫掛載到 `/profiles`;`core-data` volume 掛在 `/data`。
- 管理面板:build 好 `apps/panel/dist` 後,在 `deploy/.env` 設 `PANEL_DIST=apps/panel/dist` 再 `--build`。
- 單獨 build 映像檔(在專案根目錄):`docker build -f deploy/Dockerfile.core -t miyoria-core .`
- 容器內的 ASR / TTS 預設連 `host.docker.internal:8001/8002`;在根目錄 `.env` 設 `ASR_URL` / `TTS_URL` 可改。

## DATABASE_URL(Core 在宿主機時)

依 `deploy/.env` 的值組成,寫進根目錄 `.env`:

```
DATABASE_URL=postgres://miyoria:change-me@127.0.0.1:5432/miyoria
```

不想裝資料庫時可以用 `DATABASE_URL=memory://`,資料只存在記憶體,重啟就沒了。

## 備份

`scripts/backup.sh`(Windows:`scripts\backup.ps1`)與對應的 `restore` 腳本,見 [OPERATIONS §7](../docs/OPERATIONS.md#7-備份與還原)。

## 測試

`miyoria-store` 的 PostgreSQL 測試只在有設定 `MIYORIA_TEST_DATABASE_URL` 時才會跑:

```sh
MIYORIA_TEST_DATABASE_URL=postgres://miyoria:change-me@127.0.0.1:5432/miyoria cargo test -p miyoria-store
```

測試每次都用新的 id,可以跟開發資料共用同一個資料庫。
