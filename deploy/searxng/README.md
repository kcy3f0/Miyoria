# SearXNG:她的網路搜尋

`web_search` 只打 DuckDuckGo 的 HTML 版時,連查兩三次就會被它的機器人偵測擋下(202 加驗證頁)。這裡在本機跑一個 SearXNG:每次搜尋同時問 Google、Bing、Brave、DuckDuckGo、Startpage、Mojeek、維基百科,哪一家跳驗證就暫停那一家,其他家照樣回結果。不用註冊、不用信用卡。

```sh
docker compose -f deploy/searxng/compose.yaml up -d
curl "http://127.0.0.1:8888/search?q=test&format=json"
```

然後在 `miyoria.toml`:

```toml
[modules.web]
searxng_url = "http://127.0.0.1:8888"
```

- 只綁 `127.0.0.1`,別台電腦連不到。容器設了 `restart: unless-stopped`,Docker Desktop 開著它就會自己起來。
- Core 先問 SearXNG;它沒開、出錯或查不到東西時,改問 DuckDuckGo(兩次至少隔 `ddg_gap_ms`,被擋過就休息 `ddg_cooldown_s`)。失敗原因會記在 Core 的 log(`a web search backend failed`)。
- 某一家被擋時 SearXNG 不會報錯,只是結果少一點。看哪幾家出事:瀏覽器開 `http://127.0.0.1:8888/stats/errors`。
- 映像檔 `searxng/searxng`(約 270MB),設定在 `settings.yml`(`use_default_settings`,只改了 JSON 輸出、關掉公開站用的限流、選引擎)。
- `miyoria doctor` 會檢查設定的位址連不連得到。
