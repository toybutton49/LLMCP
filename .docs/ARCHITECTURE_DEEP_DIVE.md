# LLMCP Architecture Deep Dive

**Application:** LLMCP: Large Language Model Control Portal  
**Core principle:** The local language model handles inference; the application
manages chat, context, retrieval, tools, persistence, and diagnostics around it.

## 1. Runtime overview

```text
Browser
  ├─ Chat/session state and 10 feature orchestrators
  ├─ Retrieval preparation and context budgeting
  └─ POST /api/chat/stream
          │
          ▼
Local Node server
  ├─ Chat route: memory probe, model lifecycle, SSE, tool loop
  ├─ llama.cpp router (startup or reuse attempted at server startup, loopback)
  │    └─ Main chat model loaded on a chat turn or manual request
  ├─ Temporary CPU llama.cpp servers for embeddings / GLM-OCR
  └─ Local JSON/vector storage, tools, and diagnostics
```

LLMCP requires a separately installed compatible `llama-server` or `llama
serve` runtime. It does not bundle llama.cpp or fetch model weights. The model
scanner discovers files in `./models`; discovery does not load them. Chat
models load when a chat turn reaches inference (or when **Load Active Model**
is selected). The server attempts to start or reuse the router at startup, but opening or
refreshing the browser does not load the main model.

Automatic chat loading requests maximum GPU layer offload (`-1` by default from
`src/data/runtimeDefaults.ts`); manual model configuration in **Settings >
Model** can pass model-specific `contextSize`, `gpuLayers`, `threads`, and
`flashAttention` settings via `models.ini` router presets. This does not guarantee
all model weights fit in VRAM or even that a compatible GPU backend is
available. The server samples total NVIDIA GPU memory usage with `nvidia-smi`
once per second for runtime telemetry, while context pressure is measured from
BPE-aware active context token length against the configured `contextSize` (for
example, `8192` tokens) rather than VRAM usage (since loading a model bumps VRAM
automatically). At 90% or higher of maximum context tokens, LLMCP compacts the
active prompt context budget to 75% of `contextSize` and uses
`selectActiveWindowMessageIds` + `ContextOffloadManager` to embed older
conversation turns in batches with the selected CPU Nomic model -- covering both
turns beyond the 39-message ceiling and turns evicted earlier by token overflow.
This does not unload the chat model or free VRAM, and it does not depend on
`nvidia-smi`. Actual VRAM and CPU RAM use depend on the local llama.cpp build,
model, hardware, and configuration. CPU-only inference is available through the
GPU-layer setting. See [NATIVE_INFERENCE.md](./NATIVE_INFERENCE.md) for the
verified model lifecycle and placement details.

The chat-model idle timeout comes from model settings and the
`MODEL_TTL_SECONDS` environment setting. Active streams defer eviction and
streamed chunks invoke the lightweight in-memory refresh hook; after a stream
completes, LLMCP schedules an application-managed idle timer. An external
compatible llama.cpp server may be reused, but LLMCP does not own or stop
external processes.

## 2. Chat turn and auxiliary model behavior

1. The browser checks router and model readiness (`/api/runtime/status`),
   computes active window message IDs via `selectActiveWindowMessageIds`,
   prepares neural File Repo (`/api/rag/query`) and archived-turn/directive
   memory retrieval (`/api/memory/probe`), budgets context, and sends the turn
   to `/api/chat/stream`.
2. When server-side memory probing runs (`prepareProbedMemoryContext`), the
   server probes Octo memory (including evicted turns from the current session
   outside the active token window) with the selected embedding GGUF via a
   temporary CPU-only server (`maxCpuThreads: 8` default), stopping it
   immediately afterward. Missing or failing required models report an explicit
   error instead of switching to deterministic retrieval.
3. The server loads or reuses the main chat GGUF, applies native `llama.cpp`
   thinking limits (`reasoning_budget_tokens` and `thinking_budget_tokens`, or
   `0` when reasoning is `Off`), fits history within the effective context
   budget (`fitConversationToContext`), and streams inference over SSE. The
   stream-active guard prevents idle eviction while generating.
4. Tool rounds are bounded (`maxToolRounds: 4`). Tool execution occurs on the
   local server (`agent_file_ops`, `precision_calculator`, `system_context`, and
   `web_search` when `webSearchEnabled !== false`) and results are returned to
   the model.
5. After the stream ends, the configured idle timer starts (`modelTtlSeconds`),
   and `POST /api/local-db/sync` publishes updated context-length pressure so
   newly evicted turns are indexed on CPU by `ContextOffloadManager`. A manual
   unload requests immediate model unload from the LLMCP-managed router.

Embedding and OCR models are separate from the main chat model. Embedding
retrieval starts a temporary CPU-only server when neural retrieval or context
offload runs. For PDFs (`1.5x` render scale) and supported image attachments,
`ocrPages.ts` composites pages onto opaque white (`#ffffff`) backgrounds before
sending them to a temporary CPU-only GLM-OCR server (`GLM-OCR` + matching
`mmproj`), preventing alpha-channel black-on-black rendering in `stb_image`.
The server stores the original attachment, and the client adds extracted text to
the File Repo as a separate `.ocr.txt` entry. OCR does not itself generate
neural embeddings. See the root README for setup details.

## 3. Ten feature orchestrators

These are real application modules, not ten mandatory server middleware stages.
The browser uses them to prepare and represent a turn; the server chat route
also performs its own inference, memory-probe, and tool-execution work.

1. **Chat** (`src/orchestrators/chatOrchestrator.ts`): session/message lifecycle,
   branching, and reasoning-tag extraction.
2. **Intake** (`src/orchestrators/intakeOrchestrator.ts`): control-character
   cleanup, whitespace normalization, and token estimation.
3. **Knowledge** (`src/orchestrators/knowledgeOrchestrator.ts`): document/File
   Repo indexing and deterministic or precomputed retrieval.
4. **Memory** (`src/orchestrators/memoryOrchestrator.ts`): memory facts,
   directives, candidate extraction, and persona templates.
5. **Context** (`src/orchestrators/contextOrchestrator.ts`): prompt assembly,
   history compaction, retrieval selection, and estimated token budgeting.
6. **Tools** (`src/orchestrators/toolOrchestrator.ts`): tool schemas, custom
   plugins, and tool dispatch support. `web_search` starts enabled by default
   per session (`webSearchEnabled: true`) and can be toggled `Off` per chat
   (from the Chat Composer pill, Tools popover, or Tools & Plugins tab) to omit
   `web_search` schemas and disable web grounding.
7. **Inference** (`src/orchestrators/inferenceOrchestrator.ts`): builds
   llama.cpp-compatible request payloads and parses streaming data. The live
   process lifecycle is implemented under `server/llamacpp/`.
8. **Analytics** (`src/orchestrators/analyticsOrchestrator.ts`): calculates
   usage metrics from workspace state. Separate server modules provide GPU and
   runtime telemetry.
9. **Storage** (`src/orchestrators/storageOrchestrator.ts`): creates and
   parses workspace snapshots. The server is the source of truth for workspace
   data, persists it in a local JSON database, and handles encrypted snapshot
   routes.
10. **Logging** (`src/orchestrators/loggingOrchestrator.ts`): client-side
    structured log buffer; the server has a separate bounded runtime log at
    `/api/logs`.

## 4. Local tool, network, and route handlers

Concrete endpoints and workers include filesystem/File Repo routes,
system context, web grounding, native model management, worker-isolated
Kokoro-82M TTS (`/api/tts/*`), local database sync, and attachment OCR. The
server binds to `0.0.0.0:3000` by default and enforces
`createNetworkAccessMiddleware` (`server/config/networkAccess.ts`) to allow
loopback, RFC1918 private LAN, and Tailscale (`100.64.0.0/10` / `*.ts.net`)
clients while blocking public internet IPs and untrusted `Host` / `Origin`
headers (or `--host 127.0.0.1` for loopback-only). The `llama.cpp` router
remains strictly on loopback (`127.0.0.1:8080`). See `server.ts`,
`server/routes/workspaceRoutes.ts`, `server/routes/chatRoutes.ts`,
`server/routes/ttsRoutes.ts`, and `server-tools.ts` for registration and
execution boundaries.
