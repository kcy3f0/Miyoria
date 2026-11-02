# @miyoria/sandbox

模組 `sandbox`:讓 DeepSeek-chan 在**用完即丟、不能連外的 Docker 容器**裡執行她自己寫的程式(Python / Node),保存她寫的腳本(工具工作區),以及管理她提出的自寫工具(`tool.propose`)。設計見 [`docs/design/autonomy.md`](../../docs/design/autonomy.md) §7、§8.3(階段 F)。

> 這個模組是 **opt-in**:`[modules.sandbox]` 要寫 `enabled = true` 才會啟動(沒有這一節 = 關閉)。它目前**沒有註冊任何 LLM 工具**:`code.run`、`tool.propose` 是高風險能力,要等階段 A 的閘門(`ActuatorRegistryKey`)接上才會開放給她用,見文末「接到閘門」。

## 服務

| Key | 型別 | 內容 |
|---|---|---|
| `SandboxKey` | `Sandbox` | `run()`、`health()`、`tools`(工具工作區) |
| `ProposedToolsKey` | `ProposedTools` | 自寫工具的儲存與生命週期(需要 `SettingsStore`) |

```ts
const sandbox = ctx.services.require(SandboxKey);
const result = await sandbox.run(
  { language: "python", code, files: [{ path: "in.csv", content }], stdin, timeout_ms: 10_000 },
  { signal },
);
// → { run_id, language, exit_code, stdout, stderr, stdout_truncated, stderr_truncated,
//     files_out: [{ path, size, encoding: "utf8" | "base64", content }], files_out_truncated,
//     duration_ms, killed_reason: "timeout" | "aborted" | "output_limit" | "memory" | null }
```

- `network` 只支援 `"none"`。型別接受 `{ allow: [...] }`,但目前一律回 `SandboxError("network_unsupported")`(見「網路白名單」)。
- 無法執行時丟 `SandboxError`(`kind`:`unavailable`、`busy`、`invalid_request`、`invalid_path`、`network_unsupported`、`image_unavailable`、`docker_failed`、`closed`…)。程式自己的錯誤不是例外,看 `exit_code` / `stderr`。
- `health()` 用 `docker version` 檢查 daemon;Docker 沒開時模組是 **degraded**(不會 crash),`run()` 丟 `unavailable`,下次使用時重新檢查(`health_ttl_ms`)。

### 一次執行的流程

1. 驗證請求(大小上限、逾時上限、檔名)→ 確認 Docker 可用 → 取得並行名額(`max_concurrent`,等待中超過 `max_queued` 回 `busy`)。
2. 映像檔不在本機就先 `docker pull`(在計時開始**之前**;`docker run` 用 `--pull never`)。
3. 建立 `<root>/runs/<run id>/code`(程式,唯讀掛到 `/code`)與 `.../work`(輸入檔,讀寫掛到 `/work`)。
4. `docker run`(參數見下),程式從 stdin 讀輸入。牆鐘逾時、呼叫端中止、輸出超量時以**容器名稱** `docker kill`;CLI 5 秒內沒結束就砍掉 CLI 並 `docker rm -f`。
5. 收集 `/work` 中新增或改過的一般檔案(有數量與大小上限),刪掉 `code/`,`work/` 保留給最近 `keep_runs` 次。
6. 啟動時移除這個實例(同一個 root)殘留的容器(`label=miyoria.sandbox.instance=<root 的雜湊>`)並清掉舊的執行資料夾。

### `docker run` 參數

```
docker run --rm -i --name miyoria-sbx-<run id>
  --label miyoria.sandbox=1 --label miyoria.sandbox.instance=<hash> --label miyoria.sandbox.run=<run id>
  --pull never --log-driver none
  --network none
  --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m
  --mount type=bind,source=<root>/runs/<id>/work,target=/work
  --mount type=bind,source=<root>/runs/<id>/code,target=/code,readonly
  [--mount type=bind,source=<root>/profiles/<profile>/tools,target=/tools,readonly]
  --workdir /work --user 65534:65534 (或 Linux/macOS 上非 root 的主機 uid:gid)
  --cap-drop ALL --security-opt no-new-privileges --ipc none --hostname sandbox
  --memory 256m --memory-swap 256m --cpus 1 --pids-limit 128
  --ulimit fsize=16777216 --ulimit nofile=256:256 --init
  --env HOME=/tmp --env TMPDIR=/tmp --env LANG=C.UTF-8
  python:3.12-slim python3 -I -B -u /code/main.py      (Node:node:24-slim node /code/main.mjs)
```

數值都可在 `[modules.sandbox.limits]` 調整。程式碼**永遠不會出現在命令列**(寫成檔案再唯讀掛載),CLI 用 `spawn(docker, args, { shell: false })` 執行,不經過任何 shell。

### 工具工作區

`sandbox.tools`:每個 profile 一個持久資料夾 `<root>/profiles/<profile>/tools`,放她自己寫、想留下來的腳本(`save` / `list` / `read` / `remove`,名稱 `^[a-z][a-z0-9_-]{0,47}$`,副檔名 `.py` / `.mjs`)。只有主機端會寫入;執行時加 `mount_tools: true` 才會**唯讀**掛到 `/tools`(例如 `sys.path.insert(0, "/tools")`)。跟每次執行的暫存資料夾完全分開。

### 自寫工具(`tool.propose`)

`ProposedTools`(存在 `SettingsStore`,key `sandbox:tool:<name>`):

```
propose(name, description, language, code, args_schema) → pending(version 1)
approve(name, { reviewer, version })  pending → approved   ← 必須指定版本:審核的就是那一版
reject(name, { reviewer, version, note }) pending → rejected
propose(同名)                          → pending(version + 1;原本的核准失效)
invoke(name, args)                     只限 approved;args 依 args_schema 驗證,以 JSON 從 stdin 傳入,
                                       在沙箱裡跑(network none);code 的 sha256 跟紀錄不符就拒絕
approvedSpecs()                        給階段 A 註冊成 LLM 工具用的 { name, description, parameters }
```

`args_schema` 必須是 `type: "object"` 的 JSON Schema(用 `z.fromJSONSchema` 驗證)。事件:`sandbox.tool.proposed`、`sandbox.tool.reviewed`、`sandbox.tool.removed`、`sandbox.run.finished`(`custom` 事件,payload 不含程式碼與輸出)。

## 安全審查

### 威脅模型

- **程式碼是不可信的。** 寫程式的是 LLM,而 LLM 的輸入包含不可信的聊天、語音辨識、遊戲聊天、網頁與圖片描述。要假設攻擊者能讓她寫出**任何程式**(prompt injection),包括故意的惡意程式:讀檔、偷密鑰、連外、挖礦、塞爆磁碟、fork bomb、試圖逃出容器。
- **輸出也是不可信的。** stdout、stderr、輸出檔回到她的上下文時是**資料**,可能夾帶下一段 prompt injection;階段 A 要把它放在 user role 的不可信資料區塊(§8.2),不能放進 system。
- 沙箱要保護的是:主機檔案與密鑰(`.env`、`miyoria.toml`、資料庫、Discord / LLM token)、主機網路與區網、主機資源、其他執行的資料。

### 容器擋下了什麼

| 攻擊 | 防護 |
|---|---|
| 讀主機檔案 / 密鑰 | 只掛載這次的 `work/`、`code/`(唯讀)與選用的 `tools/`(唯讀);沒有 `-v` 主機目錄、沒有 Docker socket |
| 從環境變數偷密鑰 | `docker run` 不轉送任何主機環境變數;容器只拿到 `HOME` / `TMPDIR` / `LANG`(加上映像檔自己的 `ENV`)。連 Docker CLI 本身都只拿到白名單(`PATH`、`DOCKER_HOST`…),Miyoria 的密鑰不在它的環境裡 |
| 連外、打區網、打 Core API | `--network none`:只有 loopback,DNS 也查不到(整合測試驗證) |
| 改系統檔、留後門 | `--read-only` 根目錄;`/tmp` 是 `noexec` 的 tmpfs;容器每次重建(`--rm`) |
| 提權 | 非 root `--user`、`--cap-drop ALL`、`no-new-privileges`、Docker 預設 seccomp、`--ipc none` |
| 資源耗盡 | `--memory`(無 swap)、`--cpus`、`--pids-limit`(fork bomb)、`--ulimit fsize/nofile`、牆鐘逾時、輸出上限(超過 `kill_output_bytes` 直接殺)、並行名額 |
| 用檔名逃出工作區 | 輸入檔名逐段檢查(拒絕 `..`、絕對路徑、磁碟代號、`\`、`:`(含 NTFS ADS)、控制字元、Windows 保留名稱、結尾的點或空白、大小寫重複),再確認解析後仍在 `work/` 內;以 `wx` 寫入,不覆寫 |
| 用輸出檔讀主機檔 | 收集輸出時用 `lstat`,只讀一般檔案;symlink、FIFO、裝置一律略過(容器裡做 `ln -s /etc/passwd` 不會被讀回;整合測試驗證);有深度與數量上限;容器結束後才收集,沒有競態 |
| 用參數注入 Docker 旗標 | 映像檔名、容器名、使用者、label、env 都用正規表示式檢查(不能以 `-` 開頭);`--mount` 的路徑若含 `,` 或 `"` 會以 CSV 引號包起來 |
| 審核後偷換程式 | 核准綁定版本號;再次 propose 會回到 pending;執行前比對 sha256 |

### Docker Desktop / WSL2 的剩餘風險

- **容器不是 VM。** 所有容器共用 Docker Desktop 那台 WSL2 utility VM 的 Linux 核心。核心漏洞或 runc / containerd 漏洞可以逃出容器;逃出後在 VM 裡,而 Docker Desktop 的 VM 能存取 Windows 磁碟(`/mnt/host/c`),等於拿到你的使用者檔案。保持 Docker Desktop 更新;更高要求可改用 gVisor(`--runtime runsc`,Docker Desktop 預設沒有)或 Hyper-V 隔離的 VM。
- **Docker daemon 等於 root。** 能用 Docker CLI 的程式(包括 Miyoria 本身)就能完全控制主機。沙箱只透過 CLI 下固定格式的指令,但 Miyoria 程序被攻破時這層保護就沒了。
- **磁碟。** `/work` 在主機磁碟上,沒有配額:單檔被 `fsize`(預設 16 MiB)限制,但在逾時內寫很多檔案仍可能用掉數 GB。`keep_runs` 之後會清掉。要更嚴格可把 `root` 放在有配額的磁碟。
- **映像檔供應鏈。** 預設用 Docker Hub 的官方 `python:3.12-slim`、`node:24-slim` 標籤。標籤會變;要可重現就在設定裡釘 digest(`python:3.12-slim@sha256:…`),代價是要自己更新安全修補。
- **側通道與資訊。** 容器看得到 CPU 型號、核心版本、時間;CPU 時間測量類的側通道沒有防。`--network none` 下仍能透過輸出內容把資料帶出去——但能帶出去的只有她自己放進去的東西(沙箱裡沒有密鑰)。
- **Windows 掛載語意。** 容器建立的 FIFO 在 Windows 端連 `lstat` 都會失敗(會被略過,標成 `files_out_truncated`);檔案權限在 Windows 端沒有意義。Linux / macOS 主機上用 `user = "auto"`(主機 uid)才清得掉容器寫的子目錄。
- **Core 跑在容器裡(`deploy/`)時不建議開。** 沙箱需要主機的 Docker daemon,等於要把 `/var/run/docker.sock` 掛進 Core 容器(Core 被攻破 = 主機 root);而且 bind mount 的來源路徑是由主機 daemon 解析,`root` 必須是主機上也存在的同一個路徑。建議在主機上原生跑 Core 時才開沙箱。
- **OOM 判斷是推測。** exit 137 且不是沙箱殺的就回報 `memory`;程式自己 `kill -9` 自己也會被當成 `memory`。

### 為什麼密鑰永遠不會進容器

1. 容器的環境變數是程式裡寫死的三個值(`CONTAINER_ENV`),沒有 `--env-file`、沒有不帶值的 `-e NAME`(那會從 CLI 環境複製)。
2. Docker CLI 程序本身用過濾後的環境啟動(`dockerCliEnv`),Miyoria 的 `LLM_API_KEY`、`DISCORD_BOT_TOKEN`、`MIYORIA_API_TOKEN` 等根本不在它的環境裡,即使未來誤加 `-e` 也帶不過去(單元測試與整合測試都驗證)。
3. 唯一的讀寫掛載是全新的 `runs/<id>/work`;設定檔、`.env`、資料庫都不在任何掛載的目錄下。
4. 程式碼與參數不經過 shell,所以不會被展開成 `$(cat .env)` 之類的東西。

### 網路白名單(尚未實作)

規劃:建一個 `--internal` 的 user-defined network(沒有對外路由),再起一個同時接 internal 與 bridge 的 egress proxy 容器(只放行白名單網域的 HTTP CONNECT),沙箱容器只接 internal network 並設 `HTTP(S)_PROXY`。非 HTTP 流量與 DNS 全擋。在那之前 `network` 一律 `"none"`;模型可呼叫的 `code.run` 參數也**沒有** `network` 欄位(`CodeRunArgsSchema`),即使之後支援白名單,也要由閘門的設定決定,不由模型決定。

## 接到閘門(階段 A 要做的事)

`capabilities.ts` 已經準備好:

- `SANDBOX_CAPABILITIES`:`code.run`、`tool.propose` 兩個能力,`risk: "high"`、說明與 zod 參數 schema(`CodeRunArgsSchema`、`ToolProposalSchema`)。
- `sandboxHandlers({ sandbox, tools })`:閘門放行後呼叫的 handler(解析不可信參數、強制 `network: "none"`、回傳精簡的 `summarizeRun` 結果)。

階段 A 要:

1. 在 `ActuatorRegistry` 註冊這兩個能力(用上面的 handler),principal 帶進 `requester`(會記在 `proposed_by`)。
2. 依 §8.1:高風險 → 她自己的審核呼叫(`review` 用途,只看結構化請求與程式碼,不看聊天原文),有疑慮才轉交擁有者;頻率與預算上限;稽核紀錄。
3. 自寫工具的核准:審核呼叫或擁有者呼叫 `ProposedTools.approve(name, { reviewer, version })`;面板 / Discord 按鈕顯示程式碼與 `code_sha256`。
4. 把 `approvedSpecs()` 註冊成 LLM 工具(建議名稱加前綴,例如 `her_<name>`,避免跟內建工具撞名),呼叫時同樣經過閘門,再 `ProposedTools.invoke()`;聽 `sandbox.tool.reviewed` / `removed` 事件更新註冊。
5. 執行結果放進不可信資料區塊(§8.2)。

## 設定

見 `miyoria.example.toml` 的 `[modules.sandbox]` 與 `src/config.ts`(每個欄位都有預設值)。

## 測試

- `pnpm --filter @miyoria/sandbox test`:單元測試用注入的假 `DockerRunner`,不需要 Docker。
- `test/docker.integration.test.ts` 會真的跑容器;偵測不到 Docker daemon(或設 `MIYORIA_SKIP_DOCKER_TESTS=1`)時自動跳過。第一次會下載映像檔(在作者的機器上 `python:3.12-slim` 約 9 秒、`node:24-slim` 約 3 秒)。
