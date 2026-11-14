# Local `llama.cpp` Inference & Model Management

**Application:** LLMCP: Large Language Model Control Portal  
**Purpose:** Verified behavior for local GGUF discovery, inference, memory placement, and eviction.

## 1. Runtime and discovery

LLMCP requires a separately installed compatible `llama-server` executable, or
`llama` with its `serve` subcommand. At startup, the application attempts to
start a loopback llama.cpp router on port 8080 or reuse a compatible server
already there. With the Llama app, start Llama before LLMCP; if LLMCP cannot
detect it, start Llama and retry startup. A separate router must register the selected model
itself; its model directory may differ from LLMCP's. LLMCP does not bundle
llama.cpp or download model weights. See the root README for installation checks.

The model scanner searches `./models` (including bounded subdirectories). Chat
GGUFs, embedding GGUFs, and GLM-OCR GGUFs are listed separately;
vision projectors are not chat models. `/api/native/models` reports those local
files and any models reported by the configured loopback server. A listing is
discovery only: it does not mean that model is loaded. Weights must be placed in
`./models` by the operator.

## 2. Chat model lifecycle and memory placement

- Opening or refreshing the web app does not load the main chat model.
- On a chat turn, after retrieval preparation, `/api/chat/stream` loads the
  selected local GGUF if it is not already served. **Load Active Model** can
  also start it manually. Further turns reuse the running server while it stays
  loaded.
- The app-managed router uses the saved model-specific GPU-layer settings.
  An external server controls its own hardware configuration. Neither guarantees all
  weights fit in VRAM or that a GPU is available. Actual VRAM use and any
  CPU-resident weights depend on the llama.cpp build, selected model,
  GPU/backend, and available memory. LLMCP samples total NVIDIA GPU memory
  usage via `nvidia-smi` once per second, but does not measure memory use by
  individual models. CPU-only inference is available through the GPU-layer
  setting.
- The idle timeout is supplied by model settings and the `MODEL_TTL_SECONDS`
  environment setting; consult `server/config/env.ts` and the stored engine
  settings for the effective value. While a chat stream is active, eviction is
  deferred and streamed chunks invoke the lightweight in-memory refresh hook;
  after the stream ends, the idle timer schedules unload. **Unload** requests
  immediate unload of a model from the LLMCP-managed router, leaving the router running.
- If a compatible external llama.cpp server is already serving the requested
  model on port 8080, LLMCP can reuse it. LLMCP does not
  own or stop external processes, so it cannot promise their memory is released.

The application-level idle timer is the eviction mechanism; the main server
launch arguments use `--models-preset` (`models.ini` with `ctx-size`, `threads`,
`n-gpu-layers`, `flash-attn`, and `--models-max 1`) rather than llama.cpp's
`--ttl`. Per-turn reasoning budgets are passed natively via
`reasoning_budget_tokens` and `thinking_budget_tokens` (`0` when reasoning is
turned `Off`, or the configured integer `thinkingBudget` up to `maxTokens - 128`
when enabled). A process that LLMCP did not start is not killed by LLMCP. At
90% or higher of the configured maximum context length (`contextSize`, for
example `8192` tokens), LLMCP compacts the active prompt context budget (`75%`
of `contextSize`) and uses `selectActiveWindowMessageIds` +
`ContextOffloadManager` to embed older conversation turns in batches with the
selected CPU Nomic model (covering both turns beyond 39 messages and turns
evicted earlier by token overflow). Context pressure is measured from token
length rather than GPU VRAM percentage because loading a model bumps VRAM
automatically.

## 3. Separate auxiliary models

Embedding and OCR models are not loaded into the main chat server:

- **Embeddings:** When neural retrieval or context-pressure offload runs, LLMCP
  starts a temporary CPU-only llama.cpp server (`-ngl 0`, up to `8` CPU threads
  by default via `AUXILIARY_SERVER_DEFAULTS.maxCpuThreads`), sends embedding
  requests, then stops that server immediately. Chat memory and File Repo
  retrieval require the selected Nomic model; missing models or failed
  model-backed requests produce explicit errors instead of falling back to
  deterministic retrieval. Vectors are persisted in `.local-data/octo-vector-db.json`,
  while the embedding process itself is never kept warm between calls.
- **GLM-OCR:** For PDFs and supported image attachments, `ocrPages.ts` renders
  PDF pages (`1.5x` scale) and flattens images onto opaque `#ffffff` white
  backgrounds before sending them to a temporary CPU-only GLM-OCR server (`-ngl 0
  --no-mmproj-offload`, up to `8` CPU threads) when a unique compatible
  model/projector pair is present under `models`. Its temporary server is stopped
  immediately after each OCR request. Missing models or failed pages are reported
  as explicit errors.
- **Kokoro-82M TTS (Worker-Isolated):** When speech playback is triggered, `server/tts/kokoroTtsEngine.ts` dispatches synthesis to a dedicated Node.js worker thread (`server/tts/kokoroTtsWorker.mjs`) with bounded ONNX CPU threads (`AUXILIARY_MAX_THREADS`) so Express/Vite HTTP and WebSocket loops never stall. The browser player (`src/hooks/useTtsPlayer.ts`) reuses a single `HTMLAudioElement` across chunks and signals `hasMoreChunks` so short idle TTLs (such as `10s`) hold `>= 60s` mid-utterance and unload cleanly after the final chunk.
- **Pre-Flight Token Calibration:** On the first turn of a newly loaded chat model (`samples === 0`), `server/llamacpp/tokenEstimator.ts` calls `POST /tokenize` once on `llama.cpp` for exact prompt token calibration before first-turn budget fitting, then refines via `usage.prompt_tokens` on subsequent rounds.

## 4. Inference and model endpoints

| Method | Endpoint | Purpose |
| :--- | :--- | :--- |
| `GET` | `/api/native/models` | Lists discovered chat, embedding, and OCR models, with chat-model loaded status. |
| `GET` | `/api/native/status` | Reports loopback reachability, discovered models, and LLMCP's active-model state. |
| `POST` | `/api/native/scan-gguf` | Scans local model files and updates discovered model metadata. |
| `POST` | `/api/native/model-configs` | Saves per-model `contextSize`, `gpuLayers`, `threads`, and `flashAttention`, rebuilding the managed router preset. |
| `POST` | `/api/native/load` | Starts or reuses the selected chat model in the router. |
| `POST` | `/api/native/unload` | Unloads the active LLMCP-managed chat model while keeping the router ready. |
| `POST` | `/api/engine/ttl` | Updates the configured idle timeout (`modelTtlSeconds`). |
| `GET` | `/api/runtime/status` | Reports router state, required-model checks, GPU VRAM telemetry, `contextPressure`, and `ContextOffloadManager` status. |
| `GET` / `POST` | `/api/runtime/router` (`/retry`) | Queries or retries startup of the built-in loopback llama.cpp router. |
| `POST` | `/api/chat/stream` | Loads/reuses the chat model, enforces `webSearchEnabled` and `reasoning_budget_tokens`, and streams SSE completions and tool rounds. |

`/api/native/status` reports model and router state, not hardware placement.
The separate runtime status reports total NVIDIA GPU memory use and whether
the prompt budget was adjusted. Use llama.cpp and operating-system tools to
inspect individual model placement and resource use.
