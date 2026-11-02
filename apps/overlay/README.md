# @miyoria/overlay

直播用的 **OBS 瀏覽器來源**:字幕(邊講邊出)、情緒指示、小型狀態 / 請求佇列面板。背景透明、深色極簡,每個有字的區塊都自帶半透明深色底板,所以疊在亮的遊戲畫面上也看得清楚。Vite + TypeScript,沒有框架,build 後約 12 KB。

## 它怎麼拿到資料

連到 Stage 的 overlay 推送(`packages/stage/src/overlay.ts`):

| 訊息 | 用途 |
|---|---|
| `{"type":"subtitle","turn","text","final"}` | 字幕。同一個 `turn` 的 `text` 是越來越長的完整字串(partial),`final: true` 表示這句講完。新的 `turn` 取代舊的。 |
| `{"type":"emotion","name","intensity"}` | 情緒指示(顏色依情緒名稱,`intensity` 調點的深淺)。 |
| `{"type":"speaking","state":"started"\|"stopped"}` | 她在不在說話:說話中字幕不會消失,停下來後才開始倒數。 |
| `{"type":"status","core","vts","obs","scene","streaming"}` | 狀態面板:直播中 / 場景名 / Core、VTS、OBS 連線點。 |
| `{"type":"queue","items":[…]}` | 請求佇列(「接下來」)。`items` 可以是字串,或帶 `title`(也認 `text` / `name` / `song` / `request`…)與 `by`(也認 `user` / `requester`…)的物件;最多顯示 5 筆,多的寫「還有 N 項」。 |

| `{"type":"levels","rms","bands"?}` | 她的聲音音量(0..1,和嘴型同一份、同樣延遲),每個 avatar frame 一次(約 60/s),停下時送一次 `rms: 0`。畫成左側邊緣一排固定不動的橫條(貼齊畫面左緣、前端圓角、半透明):每條只改長度和透明度,中間的跟低頻、上下兩端的跟高頻,顏色跟著情緒點;她開口時淡入、停下時淡出。唱歌時跟著她的人聲。 |

不認得的訊息、壞掉的 JSON 一律略過,不會中斷。WebSocket 斷線會自動重連(0.5 s 起、最長 5 s),Stage 重開不用重新整理 OBS 的來源。

## 用法

```bash
pnpm install        # 在 repo 根目錄(pnpm workspace)
cd apps/overlay
pnpm build          # → apps/overlay/dist(Stage 預設就從這裡服務 /overlay/)
pnpm test           # vitest:訊息解析、reducer、打字機、設定
pnpm dev            # 開發:http://localhost:5173/?demo=1
```

OBS:新增「瀏覽器」來源,網址 `http://127.0.0.1:7884/overlay/`,寬 1920、高 1080。背景本來就是透明的,不需要在 OBS 裡加自訂 CSS。

### Query string

| 參數 | 預設 | 說明 |
|---|---|---|
| `ws` | 跟頁面同一個主機的 `…/overlay/ws`(file:// 開啟時 `ws://127.0.0.1:7884/overlay/ws`) | 推送位址,只接受 `ws://` / `wss://`。 |
| `show` | `subtitles,emotion,status,queue,wave` | 要顯示哪些部分,逗號分隔。例如 `?show=subtitles,queue`。沒有任何有效名稱時視為預設。 |
| `cps` | `14` | 打字機基本速度(每秒字數,2~200)。字幕來得比顯示快時會自動加速追上;`200` = 不做打字效果。 |
| `scale` | `1` | 整體縮放(0.4~3)。1 是以 1080p 為準,版面隨畫面寬高等比,720p / 4K 看起來一樣。 |
| `demo` | 關 | `?demo=1` 播一段內建的假資料,不用連 Stage,設計和預覽用。 |
| `debug` | 關 | 推送斷線時在左下角顯示 "feed offline"(預設不顯示,避免上了直播畫面)。 |

## 行為細節

- **打字機**:整行文字從第一個 frame 就排好版(還沒打到的字是透明的),所以字不會在打的過程中跳行。以 code point 計算,不會把 emoji 拆開。字幕修正(同 turn 的文字前綴改變)時,只重打有變的部分。
- **字幕消失**:`final` 之後,等打完、她停止說話,再停留 `2.2 秒 + 每字 55 ms`(上限 9 秒)後淡出。沒有 `final` 又 8 秒沒更新、也不在說話,視為殘留,淡出。
- **字型**:用系統字型(Segoe UI Variable / 微軟正黑體 / Noto Sans TC)。中文字型檔太大,不內嵌;OBS 所在的 Windows 都有。
- 動態:字幕底板淡入 + 輕微上移;情緒點換色;直播中的紅點慢慢呼吸。`prefers-reduced-motion` 時全部關掉。

## 結構

```
src/feed.ts        訊息型別、parseMessage、reduce(純函式,有測試)
src/typewriter.ts  打字機步進、code point 工具、停留時間(純函式,有測試)
src/config.ts      query string(有測試)
src/emotion.ts     情緒名稱 → 顏色(同亮度同彩度,只轉色相)
src/connection.ts  WebSocket 重連
src/view.ts        DOM、rAF 迴圈、字幕計時
src/demo.ts        ?demo=1 的假資料
src/style.css      版面與視覺
```
