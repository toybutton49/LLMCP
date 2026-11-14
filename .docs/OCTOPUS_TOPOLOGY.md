# Octopus Topology & Component Map

**Application:** LLMCP: Large Language Model Control Portal  
**Purpose:** Map the feature orchestrators, model processes, and concrete routes.

## 1. Runtime topology

```text
Browser application
  ├─ 1 Chat       ├─ 4 Memory      ├─ 7 Inference
  ├─ 2 Intake     ├─ 5 Context     ├─ 8 Analytics
  ├─ 3 Knowledge  ├─ 6 Tools       ├─ 9 Storage
  └───────────────┴───────────────┴─ 10 Logging
                         │
                         ▼
Local server
  ├─ POST /api/chat/stream ── on-demand main chat model (llama.cpp)
  ├─ Retrieval/OCR routes ─── temporary auxiliary CPU-only model processes
  ├─ Tool routes ──────────── local tool handlers
  ├─ Workspace routes ─────── local JSON persistence and model management
  └─ Runtime telemetry ────── NVIDIA VRAM sampling and prompt-budget adjustment
```

The ten orchestrators are application modules, not ten mandatory server-side
stages. The browser prepares and records much of a turn; `chatRoutes.ts`
handles live inference, server-side memory probing, and model-requested tools.
The server attempts to start or reuse the llama.cpp router at startup, but the main model
is loaded for inference or manual load, not on page refresh. Embedding and OCR
processes are separate and temporary. Model placement and timeout behavior
follow the active model settings and runtime configuration; see
[NATIVE_INFERENCE.md](./NATIVE_INFERENCE.md).

## 2. Component reference

| # | Component | Source | Responsibility / verified route |
| :---: | :--- | :--- | :--- |
| 1 | **Chat** | `src/orchestrators/chatOrchestrator.ts` | Session/message lifecycle and reasoning extraction; `POST /api/chat/stream`. |
| 2 | **Intake** | `src/orchestrators/intakeOrchestrator.ts` | Prompt cleanup and token estimation; called during browser turn preparation. |
| 3 | **Knowledge** | `src/orchestrators/knowledgeOrchestrator.ts`, `server/routes/vaultAndFileRoutes.ts` | Document/File Repo search and mutations; `POST /api/rag/query`, `/api/vault/query`, `/api/filerepo/scan`, `/api/filerepo/write`. |
| 4 | **Memory** | `src/orchestrators/memoryOrchestrator.ts`, `server/routes/memoryProbeRoute.ts` | Memory facts and semantic probes; `POST /api/memory/probe`, local database routes. |
| 5 | **Context** | `src/orchestrators/contextOrchestrator.ts` | Context composition, history compaction, and estimated token budget; browser turn preparation and `/api/chat/stream`. |
| 6 | **Tools** | `src/orchestrators/toolOrchestrator.ts`, `server/tools/` | Tool schema preparation and concrete local, calculator, and web tool execution. |
| 7 | **Inference** | `src/orchestrators/inferenceOrchestrator.ts`, `server/llamacpp/`, `server/routes/chatRoutes.ts` | Request payloads, main model process lifecycle, SSE, and tool loop; `/api/chat/stream`, `/api/native/*`. |
| 8 | **Analytics** | `src/orchestrators/analyticsOrchestrator.ts` | Calculates workspace usage metrics; separate server modules provide GPU and runtime telemetry. |
| 9 | **Storage** | `src/orchestrators/storageOrchestrator.ts`, `server/db/localDatabase.ts` | Creates/parses workspace snapshots; the server persists workspace data in a local JSON database and handles encrypted snapshots. |
| 10 | **Logging** | `src/orchestrators/loggingOrchestrator.ts`, `server/config/logger.ts` | Separate client and server bounded log buffers; `GET /api/logs`, `POST /api/logs/client`. |

### Model and auxiliary workers

| Component | Source | Behavior |
| :--- | :--- | :--- |
| Centralized defaults | `src/data/runtimeDefaults.ts`, `server/config/env.ts` | Single source of truth for ports, context sizes, sampling, thinking budgets, RAG cutoffs, pressure thresholds, auxiliary CPU thread caps (`8`), and OCR limits. |
| Main chat model | `server/db/cryptoAndModels.ts`, `server/llamacpp/llamaRouter.ts`, `server/llamacpp/llamaCppTtl.ts` | Discovers chat GGUF files under `./models`; manages/reuses loopback `llama.cpp` router, enforces `reasoning_budget_tokens`, and schedules post-stream idle TTL unload. |
| Octo embeddings | `server/llamacpp/embeddingRetrieval.ts`, `server/llamacpp/octoMemoryRetrieval.ts` | Uses the selected Nomic GGUF in a temporary CPU-only server (`maxCpuThreads: 8`) for File Repo, directive, and offloaded-turn retrieval; missing or failing models report explicit errors. |
| Attachment OCR | `server/routes/attachmentOcr.ts`, `server/routes/ocrPages.ts`, `server/routes/glmOcr.ts` | Renders PDF (`1.5x` scale) and image pages onto opaque `#ffffff` backgrounds and runs a temporary CPU-only GLM-OCR server with its matching `mmproj`. Saves original file plus `<file>.ocr.txt`. |
| Local TTS worker | `server/tts/kokoroTtsEngine.ts`, `server/tts/kokoroTtsWorker.mjs`, `server/routes/ttsRoutes.ts` | Synthesizes `24 kHz` WAV speech offline via Kokoro-82M ONNX inside a dedicated worker thread with bounded CPU threads (`AUXILIARY_MAX_THREADS`) and multi-chunk TTL protection. |
| Network & scripts | `server/config/networkAccess.ts`, `scripts/start-llmcp.ps1`, `scripts/clean-data.ts` | Permits loopback, RFC1918 LAN, and Tailscale (`100.64.0.0/10` / `*.ts.net`) while blocking public IPs and DNS rebinding; operational scripts live in `scripts/`. |
| Runtime telemetry & offload | `server/llamacpp/gpuTelemetry.ts`, `server/llamacpp/runtimeTelemetry.ts`, `server/llamacpp/contextOffloadManager.ts`, `server/llamacpp/tokenEstimator.ts` | Samples NVIDIA VRAM with `nvidia-smi`, calibrates token budgets via `/tokenize` + `usage.prompt_tokens`, and measures BPE-aware context token length against `contextSize`; at `>= 90%`, compacts prompt budget to `75%` and batch-embeds older turns. |

## 3. Concrete local tools

The server exposes read-only File Repo inspection (`agent_file_ops`),
deterministic arithmetic (`precision_calculator`), system context
(`system_context`), and SSRF-guarded web search/fetching (`web_search`) through
route and tool-handler modules. Tool execution is never pre-triggered via
keyword matching: the model requests an authorized exposed tool, and the server
executes it within bounded output limits. `web_search` starts enabled by default
per chat (`webSearchEnabled: true`) and can be toggled `Off` per session (from
the Chat Composer pill, Tools popover, or Tools & Plugins tab) to completely
omit `web_search` schemas and disable automatic web grounding.
