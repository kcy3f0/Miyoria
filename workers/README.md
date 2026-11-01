# Miyoria 推論 Worker(ASR / TTS)

`miyoria-speech` 的 `http-worker` provider 對應的 GPU 推論服務。協定在 [`docs/protocols/voice-link.md`](../docs/protocols/voice-link.md)「推論 Worker HTTP 介面」,這裡的三個服務都照那份契約實作。

| 目錄 | 服務 | 預設埠 | 說明 |
|---|---|---|---|
| `asr/` | `POST /asr`、`GET /health` | 8001 | `ASR_BACKEND=sensevoice`(sherpa-onnx,CPU,附情緒 / 事件標記)或 `qwen3`(Qwen3-ASR,GPU) |
| `tts/` | `POST /tts`、`GET /health`、`GET /voices`、`POST /voices/reload` | 8002 | Qwen3-TTS,聲音由 `VOICES_DIR` 註冊成可重複使用的 clone prompt |
| `fake/` | 兩個端點都有 | 8000 | 不需要 GPU 的假 worker(固定文字 / 正弦波「聲音」),用來做端對端測試 |
| `tests/` | pytest | | 契約測試(預設打 fake,也可以打真的 worker) |

```
workers/
├── asr/   server.py  tags.py  requirements*.txt  Dockerfile
├── tts/   server.py  text_split.py  design_voice.py  requirements.txt  Dockerfile
├── fake/  fake_server.py  requirements.txt
├── tests/ conftest.py  test_contract.py  test_text_split.py  test_asr_tags.py
├── voices/   # 你的聲音:<name>/ref.wav + ref.txt(不進 git)
├── models/   # SenseVoice 模型目錄(不進 git)
└── docker-compose.yml
```

ASR / TTS 的輸出入都是「原始模型文字」:繁簡轉換(OpenCC `s2tw`)由 Rust 端負責,worker 不做。

---

## 0. 先用 fake worker 跑通整條線(不需要 GPU)

```bash
cd workers
python -m venv .venv
.venv/Scripts/pip install -r fake/requirements.txt      # Windows;WSL / Linux 用 .venv/bin/pip
.venv/Scripts/python fake/fake_server.py                 # http://127.0.0.1:8000(PORT=9000 可改埠)
```

把 ASR 和 TTS 的 `url` 都指到 `http://127.0.0.1:8000` 就能測 Miyoria 的語音管線。fake 的行為:

- `/asr`:回固定文字(環境變數 `FAKE_ASR_TEXT` 可改),`duration_ms` 是上傳音檔的真實長度。
- `/tts`:每個非空白字元 60 ms 的正弦波(音高由字決定、`emotion` 會改變音高),24 kHz,每句串流一次。可用聲音 `deepseek-chan`、`default`(`FAKE_VOICES` 可改);`FAKE_TTS_DELAY_MS=300` 模擬合成延遲。

跑測試(只需 fastapi / httpx / pytest):

```bash
cd workers
.venv/Scripts/python -m pytest                     # 37 個測試,打 in-process 的 fake

# 用同一份契約測試檢查「真的」worker:
WORKER_ASR_URL=http://127.0.0.1:8001 WORKER_TTS_URL=http://127.0.0.1:8002 \
  .venv/Scripts/python -m pytest tests/test_contract.py
```

---

## 1. 環境:原生 Windows vs WSL2 / Docker

| | 原生 Windows | WSL2 / Docker(建議) |
|---|---|---|
| SenseVoice(sherpa-onnx,CPU) | 沒問題 | 沒問題 |
| Qwen3-ASR(transformers) | 可以跑,用 SDPA | 可用 FlashAttention 2 |
| Qwen3-ASR(vLLM 後端,唯一支援串流 ASR) | 不能 | 可以 |
| Qwen3-TTS | 可以跑,用 SDPA(VRAM 多一些、可能慢一些) | 可用 FlashAttention 2 |
| FlashAttention 2 | 幾乎裝不起來 | 可以(要編譯,見下) |

WSL2 的 CUDA 用 Windows 的 NVIDIA 驅動,**WSL 裡不要另外裝顯卡驅動**。模型和聲音檔請放在 WSL 的 Linux 檔案系統(`~/miyoria/...`),不要從 `/mnt/c/...` 讀(I/O 很慢)。

### 1a. 原生(Windows 或 WSL2 都適用)

Python 3.11+(`tts/design_voice.py` 用到 `tomllib`)。Windows 把 `bin` 換成 `Scripts`。

**ASR — SenseVoice(CPU)**

```bash
cd workers
python -m venv .venv-asr && .venv-asr/bin/pip install -r asr/requirements-sensevoice.txt

# 下載模型(約 1 GB 壓縮檔,內含 fp32 + int8;int8 約 230 MB)
mkdir -p models && cd models
curl -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2
tar xf sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2 && cd ..

cd asr
ASR_BACKEND=sensevoice \
ASR_MODEL=../models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17 \
  ../.venv-asr/bin/python server.py                     # http://127.0.0.1:8001
```

**ASR — Qwen3-ASR(GPU)**

```bash
python -m venv .venv-asr-qwen
.venv-asr-qwen/bin/pip install torch --index-url https://download.pytorch.org/whl/cu128   # 一定要先裝 CUDA 版
.venv-asr-qwen/bin/pip install -r asr/requirements-qwen3.txt
# WSL2 可選:  pip install -U flash-attn --no-build-isolation   /   pip install -U "qwen-asr[vllm]"

cd asr
ASR_BACKEND=qwen3 ASR_QWEN_SIZE=0.6B ../.venv-asr-qwen/bin/python server.py   # 第一次會自動下載約 2 GB
# 本機模型:ASR_MODEL=/path/to/Qwen3-ASR-0.6B ;vLLM:ASR_QWEN_BACKEND=vllm ASR_VLLM_GPU_MEM=0.25
```

**TTS — Qwen3-TTS**

```bash
python -m venv .venv-tts
.venv-tts/bin/pip install torch --index-url https://download.pytorch.org/whl/cu128
.venv-tts/bin/pip install -r tts/requirements.txt
# WSL2 可選:  MAX_JOBS=4 pip install -U flash-attn --no-build-isolation

cd tts
VOICES_DIR=../voices TTS_DEFAULT_VOICE=deepseek-chan ../.venv-tts/bin/python server.py   # http://127.0.0.1:8002
# 第一次會自動下載 Qwen/Qwen3-TTS-12Hz-1.7B-Base(約 4–5 GB);小一點:TTS_MODEL=Qwen/Qwen3-TTS-12Hz-0.6B-Base
```

啟動時會一次載入模型、把 `VOICES_DIR` 底下每個聲音建成 clone prompt、再暖機合成一句(同時確定輸出取樣率)。Log 看到 `voices: deepseek-chan` 才算就緒。

### 1b. Docker Compose

需要 Docker Desktop(WSL2 backend)+ NVIDIA 驅動。

```bash
cd workers
# SenseVoice 的模型照 1a 下載到 ./models/ ,然後:
docker compose up --build                              # asr(sensevoice) + tts
ASR_BACKEND=qwen3 docker compose up --build            # 換成 Qwen3-ASR(也可寫進 workers/.env)
```

- `asr` → `127.0.0.1:8001`,`tts` → `127.0.0.1:8002`,**只綁 loopback**(worker 沒有認證,不要對外開)。
- 兩個服務都保留 GPU 0;映像用 CUDA 12.8 runtime 基底、非 root 使用者(uid 10001)。
- Volume:`./models`(唯讀)→ `/models`、`./voices` → `/voices`、`../profiles`(唯讀)→ `/profiles`、`hf-cache` 存 Hugging Face 下載(重建映像不用重抓)。
- 每個後端要各自 build(`ASR_BACKEND` 是 build arg;映像 tag 是 `miyoria-asr:<backend>`)。
- FlashAttention 2:`TTS_BASE_IMAGE=nvidia/cuda:12.8.1-cudnn-devel-ubuntu24.04 TTS_FLASH_ATTN=1 docker compose build tts`(要 nvcc,編譯很久;不開就自動用 SDPA)。ASR 同理 `ASR_FLASH_ATTN=1`(Dockerfile 的 `BASE` 要換成 devel)。
- 映像尚未在這台機器上實際 build 過(沒有下載任何依賴);第一次 build 如果 pip 版本衝突,以 `qwen-asr` / `qwen-tts` 上游說明為準調整 `requirements*.txt`。

---

## 2. VRAM 預期(4070 SUPER 12 GB)

> **這些是依模型大小估的數字,還沒實測。**實測請用 `spikes/speech-bench`(在開著遊戲 + OBS 的狀態下量),worker 的 `/health` 也會回報 `vram_allocated_mb`(僅 PyTorch 配置的部分)。

| 元件 | 權重 | 實際約佔 | 備註 |
|---|---|---|---|
| ASR SenseVoice-Small int8 | 約 230 MB | **GPU 0**,RAM 約 0.5–1 GB | CPU 跑;延遲看 `ASR_THREADS` |
| ASR Qwen3-ASR-0.6B(transformers, bf16) | 約 1.2–2 GB | 約 2–3 GB | |
| ASR Qwen3-ASR-1.7B | 約 3.5–4.5 GB | 約 5–6 GB | 0.6B 不夠準才考慮 |
| ASR Qwen3-ASR(vLLM) | | 預先配置 `ASR_VLLM_GPU_MEM` × 全卡(預設 0.25 ≈ 3 GB) | 不吃遊戲的餘裕,先算好比例 |
| TTS Qwen3-TTS-1.7B-Base(bf16) | 約 4–5 GB | 約 5–7 GB | 長句 / 同時多個請求會再多 |
| TTS Qwen3-TTS-0.6B-Base | 約 2 GB | 約 3–4 GB | 品質要實測 |
| `design_voice.py`(1.7B VoiceDesign) | 約 4–5 GB | 約 5–7 GB | **只在挑聲音時跑**;跑之前先停 TTS worker |

DECISIONS 的預算:遊戲 + OBS baseline + ASR + TTS ≤ 約 11 GB。1.7B TTS + Qwen3-ASR-0.6B 大約 8–10 GB,遊戲很吃 VRAM 時改用 SenseVoice(CPU)或 TTS 0.6B。

---

## 3. TTS 的串流模式與 `instruct`(務必看)

### 串流:**句子級**(不是真串流)

`qwen-tts` 套件(2026-11-01 查)**沒有文件化的串流 API**,只有整段的 `generate_*`。所以 worker 這樣做:

1. 用 `。！？!?…` 和換行把文字切句(`tts/text_split.py`;太短的合併、超過 80 字的在逗號處切;`TTS_MIN_SENTENCE_CHARS` / `TTS_MAX_SENTENCE_CHARS` 可調)。
2. 第一句合成完就開始回傳 PCM;回傳的同時已經在合成下一句(預取一句),所以只要 RTF < 1,後面的句子不會斷。
3. **首包延遲 = 第一句的整句合成時間**,不是官方宣稱的 97 ms。回應標頭 `X-Tts-First-Audio-Ms` 會告訴你實測值;Core 端「第一句先出聲」(R4)就靠這個。想壓低首包就讓 LLM 的第一句短一點。
4. 啟動時會掃描安裝的 `qwen-tts` 有沒有 `stream` 相關方法,記錄在 log 和 `/health` 的 `stream_probe`,**但不會自動使用**(沒驗證過就不敢用)。如果未來版本有真串流,在 `tts/server.py` 的 `Engine.synth` 與 `tts()` 的 `body()` 換掉即可,HTTP 介面不變。
5. 第一句失敗會回正常的 4xx/5xx JSON;串流中途失敗會中斷 chunked 連線(client 會看到錯誤,而不是把截斷的音訊當成完整)。
6. 所有 GPU 呼叫用同一把鎖序列化;同時兩個請求會以「句」為單位交錯。Client 斷線後最多浪費一句已經在跑的合成。

### `instruct` / `emotion`

只有支援指令控制的模型才吃 `instruct`(DECISIONS「TTS 選型」):

| `TTS_MODEL` | mode | `voice` | `instruct` / `emotion` |
|---|---|---|---|
| `…-Base`(預設) | `clone` | `VOICES_DIR` 裡的聲音名稱 | **忽略**(情緒只能靠文字語意) |
| `…-CustomVoice` | `custom_voice` | 內建 speaker 名稱 | 套用 `instruct` |
| `…-VoiceDesign` | `voice_design` | 選填;聲音目錄裡的 `instruct.txt` 當基底描述 | `instruct` 接在基底描述後面 |

`emotion` 欄位只是資訊;Miyoria 送來的 `instruct` 已經是 `voice.toml` `[emotion.instruct]` 對應好的指令,worker 不再自己查表。`/health` 的 `instruct_supported` 會告訴 Core 目前的模型吃不吃。`custom_voice` 和 `voice_design` 兩個模式**還沒用真的模型跑過**(只有 clone 路徑有照 spike 寫法)。

---

## 4. 設計 / 挑選 DeepSeek-chan 的聲音

流程:VoiceDesign 依文字描述生出幾個候選 → 你聽、挑一個 → 固定成 clone 的參考音(`VOICES_DIR/deepseek-chan/ref.wav` + `ref.txt`)→ TTS worker 用 Base 模型複製它。描述寫在 `profiles/deepseek-chan/voice.toml` 的 `[design]`(`instruct`、`sample_text`、`language`),想調音色就改那裡。

```bash
cd workers/tts          # 用 .venv-tts;跑之前先停 TTS worker(VRAM)
../.venv-tts/bin/python design_voice.py generate deepseek-chan --n 8
#   → workers/voices/deepseek-chan-candidates/cand_00_seed1000.wav … + 同名 .txt(= sample_text)+ manifest.json
#   8 個聽起來一樣?加  --gen-kwargs '{"do_sample": true, "temperature": 0.9, "top_p": 0.95}'
#   想換 seed 範圍:--seed 2000;臨時改描述:--instruct "..." --text "..."

# 聽完挑第 3 個(複製成 voices/deepseek-chan/ref.wav + ref.txt)
../.venv-tts/bin/python design_voice.py pick deepseek-chan 3
# 也可以自己複製兩個檔案(ref.txt 必須是 ref.wav 實際說的內容,pick 會用候選的 .txt)

curl -X POST http://127.0.0.1:8002/voices/reload        # 已在跑的 worker 不用重啟
```

- 預設路徑:`--profiles-dir` = repo 的 `profiles/`(環境變數 `PROFILES_DIR`),`--voices-dir` = `workers/voices`(`VOICES_DIR`)。Docker 內:`docker compose run --rm tts python design_voice.py generate deepseek-chan`(compose 已掛 `/profiles` 和 `/voices`)。
- 評分建議:中日混說(「baka!」「うるさい」)自不自然、音色是否清亮偏高又帶點傲氣、clone 之後跟候選聽起來是否一致。
- 挑好之後 `voices/deepseek-chan/ref.wav` 約 3–10 秒、乾淨無背景音就夠。**`voices/` 在 git 之外**(`workers/.gitignore`);repo 根目錄 `.gitignore` 目前忽略的是 `profiles/*/voice/*.wav`,之後若要把參考音放進 profile,記得確認它不會被誤提交。
- 沒有 `ref.txt` 的聲音會退回只用 speaker embedding(`x_vector_only_mode`),品質較差,啟動 log 會警告。

---

## 5. 接上 Miyoria

在 Miyoria 設定檔的 `[speech]` 區段:

```toml
[speech.asr.local]
kind = "http-worker"
url = "http://127.0.0.1:8001"
# timeout_secs = 20            # 選填

[speech.tts.local]
kind = "http-worker"
url = "http://127.0.0.1:8002"
voice = "deepseek-chan"        # 預設聲音;請求沒指定 voice 時用
# timeout_secs = 30            # 串流的閒置逾時;冷啟動的第一句可能要幾秒,別設太小

[speech]
asr_chain = ["local"]
tts_chain = ["local"]
```

沒有 GPU 時,把兩個 `url` 都改成 `http://127.0.0.1:8000` 指向 fake worker。

---

## 6. curl 冒煙測試

> Windows 的 Git Bash / PowerShell 用 `curl` 直接塞中文 JSON 可能因為編碼出錯(`There was an error parsing the body`)。**在 Windows 上請把 JSON 寫進 UTF-8 檔案,用 `--data-binary @req.json`**;WSL / Linux 可以直接內嵌。

**健康檢查**

```bash
curl -s http://127.0.0.1:8001/health      # {"status":"ok","model":"...","device":"cpu","backend":"sensevoice"}
curl -s http://127.0.0.1:8002/health      # {"status":"ok","model":"Qwen/Qwen3-TTS-...","mode":"clone","sample_rate":24000,"streaming":"sentence",...}
curl -s http://127.0.0.1:8002/voices
```

**TTS**(先做,產生音檔再給 ASR 用)

```bash
cat > req.json <<'EOF'
{"text":"哼,你終於來了喔?我才、才沒有在等你呢。好啦,今天要做什麼?",
 "language":"Chinese","emotion":"embarrassed","voice":"deepseek-chan"}
EOF
curl -sS -D - -X POST http://127.0.0.1:8002/tts -H 'Content-Type: application/json' \
     --data-binary @req.json -o out.pcm
# 預期標頭:HTTP 200、content-type: audio/L16; rate=24000; channels=1、x-sample-rate: 24000、
#          transfer-encoding: chunked、x-tts-streaming: sentence、x-tts-first-audio-ms: <第一句延遲>

# PCM 轉 WAV 來聽(任選一個)
ffmpeg -f s16le -ar 24000 -ac 1 -i out.pcm out.wav
python -c "import wave;w=wave.open('out.wav','wb');w.setnchannels(1);w.setsampwidth(2);w.setframerate(24000);w.writeframes(open('out.pcm','rb').read())"
```

**ASR**

```bash
curl -sS -X POST http://127.0.0.1:8001/asr -F "audio=@out.wav" -F "language=zh"
# {"text":"…","language":"zh","emotion":"neutral","audio_events":[],"duration_ms":4120}   (SenseVoice)
# {"text":"…","language":"zh","duration_ms":4120}                                          (Qwen3-ASR)
```

任何取樣率 / 聲道數的 WAV 都可以(worker 自己轉 16 kHz 單聲道)。錯誤一律是 4xx / 5xx 加 `{"error":"..."}`。

---

## 7. ASR 細節

- **SenseVoice**:語言在啟動時固定(`ASR_LANGUAGE`,預設 `auto`,對中日英夾雜最安全),所以請求的 `language`、`prompt` 會被忽略。`emotion` 取 `neutral|happy|sad|angry|fearful|disgusted|surprised`(模型說不出來就省略),`audio_events` 取 `bgm|applause|laughter|cry|sneeze|breath|cough|sing`(一般語音的 `Speech` 標記會濾掉)。標記從 sherpa-onnx 結果的 `lang/emotion/event` 欄位解析,也容錯處理仍留在文字裡的 `<|...|>`。
- **Qwen3-ASR**:`language` 轉成模型的語言名稱(`zh`→`Chinese`,`auto`/未知→自動偵測),回應的 `language` 轉回短碼。`prompt` 只有在安裝的 `qwen-asr` 的 `transcribe()` 有 `context` 參數時才會傳入,否則忽略。沒有 `emotion` / `audio_events`。
- 並行:解碼 / 重取樣在執行緒池裡平行跑,模型呼叫用鎖序列化;事件迴圈不會被推論卡住。預設最長 60 秒音檔(`ASR_MAX_AUDIO_SECONDS`)、32 MB 上傳(`ASR_MAX_UPLOAD_MB`),超過回 413。
- 這裡的 ASR 是「整段辨識」。Qwen3-ASR 的串流模式(vLLM)這一版沒有接,HTTP 契約本身也是整段上傳。

---

## 8. 疑難排解

| 症狀 | 原因 / 處理 |
|---|---|
| 啟動就 `missing .../model.int8.onnx` | `ASR_MODEL` 要指到解壓後的 SenseVoice 資料夾(內含 `model.int8.onnx` + `tokens.txt`) |
| Windows 裝到 CPU 版 torch | 先 `pip install torch --index-url https://download.pytorch.org/whl/cu128` 再裝 `qwen-asr` / `qwen-tts` |
| `flash_attn` 裝不起來 | 不用裝;`*_ATTN=auto` 找不到就用 SDPA。要強制:`TTS_ATTN=sdpa` / `ASR_ATTN=sdpa` |
| TTS 回 503 `no voices registered` | `VOICES_DIR/<name>/ref.wav` 不存在或目錄名稱錯;改完用 `POST /voices/reload` |
| TTS 回 404 `unknown voice` | `voice` 要等於 `VOICES_DIR` 底下的資料夾名稱(`*-candidates` 資料夾不會被註冊) |
| OOM | 換 `TTS_MODEL=…-0.6B-Base`、ASR 換 SenseVoice;或先關掉遊戲量 baseline;不要同時跑 `design_voice.py` |
| 聲音在句子之間有小爆音或停頓 | 句子級串流的已知限制:模型每次輸出各自帶開頭 / 結尾;停頓太明顯就調大 `TTS_MIN_SENTENCE_CHARS` 讓句子長一點 |
