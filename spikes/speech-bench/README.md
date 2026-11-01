# Spike:ASR / TTS 評測(4070 SUPER 12GB)

對應 ROADMAP Phase 0 的「ASR 評測」「TTS 評測」「DeepSeek-chan 的聲音」三個 spike,以及 DECISIONS.md 的「ASR 選型」「TTS 選型」。

| 檔案 | 作用 |
|---|---|
| `asr_bench.py` | SenseVoice-Small(sherpa-onnx)vs Qwen3-ASR-0.6B / 1.7B(Whisper large-v3-turbo 當參考)。每段話的延遲、RTF、VRAM、OpenCC 正規化後的 CER,輸出 CSV + 總表 |
| `tts_bench.py` | Qwen3-TTS:`design`(依 `voice.toml` 生成候選參考音)、`clone`(用選定的參考音合成固定測試句)、`emotions`(VoiceDesign + 情緒指令)、`sovits`(可選:GPT-SoVITS api_v2 client) |
| `bench_common.py` | 共用:讀音檔 / 重取樣、OpenCC、CER、nvidia-smi VRAM 取樣 |
| `requirements/*.txt` | 每個模型一個,**各自一個 venv**(依賴互相衝突) |

## 為什麼 SenseVoice 用 sherpa-onnx(不用 funasr)

正式版的 SenseVoice 會在 Rust Core 裡用 sherpa-onnx(C API / ONNX Runtime,CPU)跑(DECISIONS:「sherpa-onnx,Rust 原生、CPU 就能跑」)。在 bench 裡用同一個 runtime、同一份 int8 模型,量到的延遲和準確度可以直接套用到正式版;funasr 要 PyTorch,會跟 Qwen 的 torch 版本打架,量到的也不是我們會部署的東西。sherpa-onnx 也會回傳 SenseVoice 的語言 / 情緒 / 事件標記(CSV 的 `lang` / `emotion` / `event` 欄)。

## 環境:Windows 原生 vs WSL2

- **FlashAttention 2 在 Windows 原生幾乎裝不起來**:官方沒有 Windows wheel,自己編要 MSVC + CUDA Toolkit + 跟 torch 版本完全對上,常常編好幾個小時還失敗;社群預編譯 wheel 要剛好對到 Python / torch / CUDA 三個版本。
- **vLLM 只支援 Linux**:`qwen-asr` 的 vLLM 後端(最快、也是唯一支援串流 ASR 的後端)在 Windows 原生不能用。
- 所以**建議在 WSL2(Ubuntu)跑 Qwen 系列**,正式的 worker 也規劃跑在 WSL2 / Docker(DECISIONS「TTS 選型」)。Windows 的 NVIDIA 驅動會自動把 CUDA 給 WSL2,WSL 裡不要另外裝顯示卡驅動。
- 只想在 Windows 原生先試:兩支腳本都能不用 FlashAttention(`--attn sdpa`,`tts_bench.py` 預設 `auto` 會自動退回 SDPA),只是 VRAM 會多一些、可能慢一些。SenseVoice(sherpa-onnx)和 faster-whisper 在 Windows 原生沒問題。
- 上游建議 Python 3.12;3.11 應該也能用(本 spike 的程式碼只需要 3.11,用到 `tomllib`)。

### 建 venv(Git Bash / WSL 都一樣,Windows 把 `bin` 換成 `Scripts`)

```bash
cd spikes/speech-bench

# SenseVoice(CPU,Windows 原生 OK)
python -m venv .venv-sensevoice && .venv-sensevoice/bin/pip install -r requirements/sensevoice.txt

# Qwen3-ASR(建議 WSL2)— 先裝 CUDA 版 torch,不然 Windows 會裝到 CPU 版
python -m venv .venv-qwen-asr
.venv-qwen-asr/bin/pip install torch --index-url https://download.pytorch.org/whl/cu128
.venv-qwen-asr/bin/pip install -r requirements/qwen-asr.txt
.venv-qwen-asr/bin/pip install -U flash-attn --no-build-isolation   # 可選,WSL2
.venv-qwen-asr/bin/pip install -U "qwen-asr[vllm]"                 # 可選,WSL2,要用 --qwen-backend vllm 才需要

# Qwen3-TTS(建議 WSL2)
python -m venv .venv-qwen-tts
.venv-qwen-tts/bin/pip install torch --index-url https://download.pytorch.org/whl/cu128
.venv-qwen-tts/bin/pip install -r requirements/qwen-tts.txt
MAX_JOBS=4 .venv-qwen-tts/bin/pip install -U flash-attn --no-build-isolation   # 可選

# Whisper turbo 參考組(可選)
python -m venv .venv-whisper && .venv-whisper/bin/pip install -r requirements/whisper.txt
```

在 WSL2 裡,資料請複製到 Linux 檔案系統(例如 `~/miyoria-bench/data`),不要直接讀 `/mnt/c/...`(I/O 很慢,會干擾延遲量測)。

## 模型下載(大約大小,以 Hugging Face / release 頁面為準)

| 模型 | 取得方式 | 大約大小 |
|---|---|---|
| SenseVoice-Small(sherpa-onnx) | 手動下載 `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2`(k2-fsa/sherpa-onnx 的 GitHub release `asr-models`,或更新的版本)解壓到 `models/` | 壓縮檔約 1 GB(含 fp32 + int8);`model.int8.onnx` 約 230 MB |
| Qwen3-ASR-0.6B | 第一次執行自動下載 `Qwen/Qwen3-ASR-0.6B` | 約 2 GB |
| Qwen3-ASR-1.7B | 自動下載 `Qwen/Qwen3-ASR-1.7B` | 約 4–5 GB |
| Qwen3-TTS-12Hz-1.7B-VoiceDesign | 自動下載 | 約 4–5 GB |
| Qwen3-TTS-12Hz-1.7B-Base | 自動下載 | 約 4–5 GB |
| Qwen3-TTS-12Hz-0.6B-Base(可選) | 自動下載 | 約 2 GB |
| Whisper large-v3-turbo(faster-whisper) | 自動下載 | 約 1.6 GB |

Hugging Face 快取在 `~/.cache/huggingface`;要離線用可以先 `huggingface-cli download …` 再把本機路徑傳給 `--model` / `--qwen-06b` / `--qwen-17b`。

## 準備測試語料(用 Spike 1 的錄音)

1. 跟朋友在測試伺服器的語音頻道玩一場(**先講好要錄音**),用 `spikes/voice-node` 的 `pnpm receive` 錄。每個人每段話會變成 `recordings/{userId}_{時間}.wav`(48 kHz 單聲道)。內容要包含:台灣腔、夾日文 / 英文、遊戲用語、多人搶話、笑聲。
2. 挑 50–100 段複製到 `spikes/speech-bench/data/utts/`(`data/` 已被忽略,不會進 git)。bench 會自動把 48k 重取樣成 16k。
3. 對每段寫參考逐字稿 `data/utts/<同檔名>.txt`(UTF-8,一行)。用繁體中文;日文用假名寫(例如「うるさい」而不是漢字),英文照原樣。標點、空白、全半形、繁簡差異在算 CER 時都會被正規化掉。沒有 `.txt` 或空白的就只量速度不算 CER。
4. 錄音含有朋友的聲音,只放本機,評測完就刪(ARCHITECTURE §10.1)。

## 執行 ASR 評測

**請在開著遊戲(和 OBS)的狀態下跑**,這樣 VRAM 和延遲才是真實情況。

```bash
# SenseVoice(CPU)
.venv-sensevoice/bin/python asr_bench.py run --model sensevoice --audio-dir data/utts \
  --sensevoice-dir models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17 --threads 4

# Qwen3-ASR 兩個尺寸(transformers 後端;WSL2 加 --attn flash_attention_2)
.venv-qwen-asr/bin/python asr_bench.py run --model qwen3-asr-0.6b --model qwen3-asr-1.7b --audio-dir data/utts
# vLLM 後端(WSL2;注意它會先吃掉 --vllm-gpu-mem 比例的 VRAM)
.venv-qwen-asr/bin/python asr_bench.py run --model qwen3-asr-0.6b --qwen-backend vllm --vllm-gpu-mem 0.25 --audio-dir data/utts

# Whisper 參考組
.venv-whisper/bin/python asr_bench.py run --model whisper-turbo --audio-dir data/utts

# 合併成一張表(任何一個 venv 都可以)
.venv-sensevoice/bin/python asr_bench.py summarize results/
```

輸出:`results/asr_<model>_<時間>.csv`(每段話一行:`latency_ms`、`rtf`、`torch_peak_mb`、`text_raw`、`text_zh_tw`、`cer`、SenseVoice 的 `emotion` / `event`)、同名 `.json`(載入時間、權重大小、nvidia-smi 的 baseline / peak)、`results/asr_summary.md`。

欄位說明:
- `latency_ms`:一段話送進去到拿到文字(CUDA 有同步,前 `--warmup` 次不算)。這是**離線整段辨識**的延遲;串流 ASR(只有 vLLM 後端)會更早有 partial,正式版會用,但 Phase 0 先比整段。
- `torch peak MiB`:`torch.cuda.max_memory_allocated`(只對 transformers 後端有意義)。
- `GPU Δ MiB`:nvidia-smi 量到的整張卡 peak − 開始前的 baseline,也就是「在遊戲之上多吃了多少」;sherpa-onnx(CPU)應該接近 0。

## 執行 TTS 評測 / 決定 DeepSeek-chan 的聲音

```bash
# Mode A:依 profiles/deepseek-chan/voice.toml 的 [design] 生成 8 個候選
.venv-qwen-tts/bin/python tts_bench.py design --n 8
#   → out/design/cand_XX_seedNNNN.wav(+ 同名 .txt 是 sample_text)。聽完挑一個。
#   如果 8 個聽起來一模一樣,加 --gen-kwargs '{"do_sample": true, "temperature": 0.9, "top_p": 0.95}'

# Mode B:用挑好的那個當參考音,合成固定的測試句(中文 + baka! / hentai! / うるさい! + 遊戲用語 + 情緒句)
.venv-qwen-tts/bin/python tts_bench.py clone --ref out/design/cand_03_seed1003.wav
.venv-qwen-tts/bin/python tts_bench.py clone --ref out/design/cand_03_seed1003.wav --size 0.6B

# 情緒控制對照:VoiceDesign + voice.toml 的 [emotion.instruct]
.venv-qwen-tts/bin/python tts_bench.py emotions

# Mode C(可選):你自己跑 GPT-SoVITS 的 api_v2.py 時
.venv-qwen-tts/bin/python tts_bench.py sovits --url http://127.0.0.1:9880 --ref /path/on/server/ref.wav --ref-text "…"
```

- 自訂測試句:`--lines my_lines.tsv`(每行 `情緒<TAB>語言<TAB>文字`,或只有文字)。
- **首包延遲(TTFA)**:qwen-tts 的 README(2026-11-01 查)說模型支援串流,但 Python 套件**沒有文件化的串流 API**(只有整段的 `generate_*`;vLLM-Omni 目前也只有離線推論)。所以 Qwen3-TTS 的 `ttfa_ms` = 整句延遲,是**上限**,表上標 `upper bound`。腳本啟動時會掃描安裝的版本有沒有 stream 相關的方法並印出來,有的話要再手動驗證。官方宣稱的 97 ms 首包在這裡量不到。GPT-SoVITS 的 `sovits` 模式是用它的 `streaming_mode` 實際量第一個音訊封包。
- 挑好參考音後的位置:`voice.toml` 的 `[clone] ref_audio = "voice/ref.wav"`。⚠️ **注意 root `.gitignore` 目前忽略的是 `personas/*/voice/*.wav`,但資料夾實際叫 `profiles/`**,所以放進 `profiles/deepseek-chan/voice/` 的檔案現在**不會**被忽略。修好 root `.gitignore` 之前,參考音先留在 `spikes/speech-bench/out/`(已忽略),用 `--ref` 指過去。
- 主觀評分建議另外記:中日混說自不自然、「baka!」之類的日文發音、情緒有沒有出來、clone 之後音色跟候選一不一致。

## 哪些數字決定預設(寫回 DECISIONS.md)

**ASR**(DECISIONS「ASR 選型」):
- **選 Qwen3-ASR**:0.6B 在開著遊戲時 **每段話延遲 ≤ 300 ms**(看 `p90 ms`,`p90≤300ms` 欄)、**VRAM 放得下**、而且**準確度明顯比較好**。
  - VRAM 放得下:遊戲 + OBS 的 baseline + ASR 的 `GPU Δ` + TTS 的 `GPU Δ` ≤ 約 11 GB(12 GB 留 1 GB 餘裕)。
  - 「明顯」建議標準:CER 比 SenseVoice 低 ≥ 3 個百分點,或相對低 ≥ 20%(例如 15% → 12% 以下)。
  - 這時 SenseVoice 可以留在 CPU 上專門做情緒 / 笑聲(看 CSV 的 `emotion` / `event` 準不準)。
- **留 SenseVoice**:Qwen3-ASR 太吃 GPU、延遲超標,或 CER 差距不大。
- 1.7B 只有在 0.6B 準確度不夠、而 VRAM 還有空間時才考慮;Whisper turbo 只當參考。

**TTS**(DECISIONS「TTS 選型」):
- `clone` 模式的 RTF(要 < 1 才來得及即時講)、整句延遲、`GPU Δ`;短句(「嗯……讓我想一下。」)的延遲最接近首包體感。
- 加上 ASR 的 VRAM 一起看能不能跟遊戲共存;1.7B 塞不下就看 0.6B-Base 的品質能不能接受。
- 情緒:Base 沒有 instruct,`emotions` 模式聽起來差很多的話,代表要「自己的聲音 + 情緒」可能得走官方 fine-tuning,或改用 GPT-SoVITS 對照。
