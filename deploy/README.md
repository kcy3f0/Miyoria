# deploy

本機開發用的 PostgreSQL 17 + pgvector。

## 啟動

```sh
cp deploy/.env.example deploy/.env   # 記得改密碼
docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml ps   # 等 STATUS 變成 healthy
```

- 只綁在 `127.0.0.1:5432`,不會對外開放;要換 port 就改 `.env` 的 `POSTGRES_PORT`。
- 資料存在名為 `miyoria_pgdata` 的 volume,`down` 不會刪資料;要清空就 `down -v`。
- `vector` 擴充由 Miyoria 第一次啟動時的 migration 建立,不需要手動處理。

## DATABASE_URL

依 `.env` 的值組成:

```
DATABASE_URL=postgres://miyoria:change-me@127.0.0.1:5432/miyoria
```

不想裝資料庫時可以用 `DATABASE_URL=memory://`,資料只存在記憶體,重啟就沒了。

## 測試

`miyoria-store` 的 PostgreSQL 測試只在有設定 `MIYORIA_TEST_DATABASE_URL` 時才會跑:

```sh
MIYORIA_TEST_DATABASE_URL=postgres://miyoria:change-me@127.0.0.1:5432/miyoria cargo test -p miyoria-store
```

測試每次都用新的 id,可以跟開發資料共用同一個資料庫。
