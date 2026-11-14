# High-Level Engineering & Architecture Overview (Confidential)

**Location:** `./.docs/HIGH_LEVEL_OVERVIEW.md`  
**Application:** LLMCP: Large Language Model Control Portal  
**Logo Asset:** `public/assets/logos/llmcp-octopus.jpg` (untouched source)  
**Purpose:** High-level overview of application architecture, centralized defaults, API route matrix, and embedding retrieval workflow.

---

## 1. System Topology

1. **Main Brain:** Primary reasoning LLM served via loopback `llama.cpp` (`llama-server` or `llama serve` router mode; `src/orchestrators/index.ts`, `server/llamacpp/*`, `server/routes/chatRoutes.ts`). Enforces native `reasoning_budget_tokens` / `thinking_budget_tokens` (`0` when reasoning is `Off`).
2. **Centralized Runtime Defaults:** All runtime, hardware, generation, RAG, memory-probe, telemetry, auxiliary CPU server, and OCR defaults live in `src/data/runtimeDefaults.ts` and `server/config/env.ts` (zero hardcoded magic literals across components or routes).
3. **Embedding & Vector DB:** Uses a discovered, selected Nomic GGUF (`nomic-embed-text-v1.5.Q8_0.gguf` bundled via Git LFS) for neural File Repo, directive, and archived-turn retrieval through `OctoVectorDatabase` (`src/utils/memory/octoVectorDatabase.ts`, `.local-data/octo-vector-db.json`). Missing or failing required models fail explicitly instead of switching to deterministic fallbacks.
4. **10 Tentacles:** Focused orchestrators in `src/orchestrators/` (Chat, Intake, Knowledge, Memory, Context, Tools, Inference, Analytics, Storage, Logging).
5. **Runtime Monitoring & Token-Window Offload:** Samples NVIDIA GPU memory with `nvidia-smi` once per second for informational telemetry, and measures context pressure strictly from BPE-aware active context token length against configured `contextSize` (default `8192`). The initial 8 GB generation baseline is `1024` reasoning tokens and `2048` response tokens; actual output remains capped by available context and each model's runtime configuration. At `>= 90%` of `contextSize`, LLMCP compacts the active prompt budget to `75%` of `contextSize` and uses `selectActiveWindowMessageIds` + `ContextOffloadManager` to batch-embed older conversation turns (both `> 39`-message history and turns evicted earlier by token overflow) via CPU Nomic without unloading the GPU chat model. Context meters (composer gauge, runtime status, and token analytics) report the shared `estimateActiveWindowUsage` post-trim active window, so usage drops once oldest-first evicted turns move to the vector DB while raw usage keeps driving pressure detection.
6. **Tools:** `agent_file_ops` (read-only File Repo inspector, whole-file reader, exact CSV/log line matcher, symbol/security lexical scanner, and memory prober), `precision_calculator`, `system_context`, and `web_search` (enabled by default per session via `webSearchEnabled: true`, toggleable `Off` per chat).

---

## 2. Vectorized Embed Database Workflow

- **Store:** `.local-data/octo-vector-db.json` with in-memory cache `Map<string, VectorDbRecord>`.
- **Dimensions & Hybrid Ranking:** Configured in **Settings > Knowledge** (`768` default via `RAG_DEFAULTS`) combining dense cosine similarity with lexical matching (`hybridDenseWeight: 0.55` for File Repo, `0.65` for memory probes) and compound-identifier boosting (`ERR_KV_OVERFLOW`, `SIG-HELIOS-OMEGA-55`).
- **Relevance Cutoffs:** Unpinned File Repo chunks and memory probes apply `ragConfig.minScore` (`0.45` default; `0.28` fallback in `MEMORY_PROBE_DEFAULTS`); `pinnedInChat` files and pinned directives bypass the score cutoff.
- **Origin Multipliers (Echo Chamber Guard):**
  - `persistent_rule` (1.25x): Explicit guidelines and user directives.
  - `user` (1.15x): Human operator ground truth.
  - `tool_verified` (1.10x): File and CLI outputs verified by tools.
  - `assistant_synthesis` (0.70x): Down-weighted model outputs to prevent self-reinforcing hallucinations.
- **CUID Tagging & Sentence-Scoped Candidates:** Records are tagged with collision-resistant CUIDs; `extractDiamondMemoryCandidate` isolates only the directive/preference sentence from multi-sentence prompts and ignores retrieval-style `"According to..."` / `"Based on..."` queries.
- **Turn Pruning & Token-Window Offload:** Aborted turns (`*[Generation stopped by operator]*`) are excluded from indexing and probing. Older turns outside `selectActiveWindowMessageIds` (exceeding either `39` messages or the effective token budget) are embedded on CPU by `ContextOffloadManager` and retrieved semantically on later turns.

---

## 3. Core API Routes

### 3.1 Inference, Router & Telemetry
- `GET /api/native/models` & `POST /api/native/scan-gguf`: Discovers chat, embedding, and GLM-OCR GGUFs in `./models`.
- `GET /api/native/status`: Reports router reachability, loaded models, context size, offload layers, and busy state.
- `POST /api/native/model-configs`: Saves hardware settings (`contextSize`, `gpuLayers`, `threads`, `flashAttention`) and updates the managed router preset.
- `POST /api/native/load` & `POST /api/native/unload`: Loads or unloads the active chat model in the managed loopback router.
- `POST /api/engine/ttl`: Updates and refreshes the application-managed idle eviction timer (`modelTtlSeconds`).
- `GET /api/runtime/status`, `GET /api/runtime/router`, & `POST /api/runtime/router/retry`: Reports router readiness, model availability, GPU VRAM telemetry, token-length `contextPressure`, and `ContextOffloadManager` status.
- `POST /api/chat/stream`: SSE chat endpoint; loads model on demand, performs pre-flight `/tokenize` calibration on first turn when available, auto-runs live grounding for detected current factual questions, corrections, explicit searches, and URLs when `webSearchEnabled` is on; injects `# Current Clock & Evidence Priority` only when `webSearchEnabled` is enabled (offline chats rely on `system_context` if time is requested); executes bounded tool rounds, compacts over-budget history, and arms post-stream TTL eviction.
- `GET /api/tts/status`, `POST /api/tts/scan`, & `POST /api/tts/speak`: Local offline Kokoro-82M ONNX text-to-speech (`24 kHz` WAV) executed inside an isolated Node.js worker thread (`server/tts/kokoroTtsWorker.mjs`) with bounded CPU threads (`AUXILIARY_MAX_THREADS`), persistent client `HTMLAudioElement` playback, and multi-chunk TTL floor (`>= 60s` while `hasMoreChunks` is true).

### 3.2 File Repo, OCR & Memory Retrieval
- `GET /api/file-repo/sync` & `POST /api/filerepo/scan`: Syncs `.local-data/file-repo/` metadata and chunks readable files into `octo-vector-db.json`.
- `POST /api/filerepo/write`: Sandboxed file writes for explicit uploads and File Repo operations.
- `POST /api/filerepo/ocr`: Renders multi-page PDFs (`1.5x` scale) and images onto opaque `#ffffff` backgrounds and transcribes them via a temporary multi-thread CPU GLM-OCR server (`maxCpuThreads: 8`), saving the original file and returning text stored as `<file>.ocr.txt`.
- `POST /api/rag/query`, `POST /api/vault/query`, & `POST /api/memory/probe`: Neural Nomic hybrid retrieval across File Repo chunks, directives, and offloaded conversation turns.

### 3.3 Domain Tools
- `GET /api/tools/registry`, `POST /api/tools/call`, & `POST /api/tools/execute`: Dispatches to:
  - **`agent_file_ops`:** Read-only File Repo directory listing, whole-file line-numbered reading, exact CSV/log line matching, lexical symbol/security inspection, and memory probing.
  - **`precision_calculator`:** Deterministic Pratt-parser arithmetic evaluation.
  - **`system_context`:** Local date, time, timezone, OS platform, and runtime inspection.
  - **`web_search` (`web_fetch`, `web_context`):** SSRF-guarded live web search and page extraction (enabled by default per chat, disableable via `webSearchEnabled: false`).

### 3.4 Storage, Diagnostics & Security
- `GET /api/local-db`, `POST /api/local-db/sync`, & `POST /api/local-db/query`: Revision-guarded workspace persistence and structured database explorer queries against `.local-data/llmcp-db.json`, publishing context pressure updates on sync.
- `POST /api/local-db/reset`: Restores clean factory state (`8192` default context ceiling, `0` messages, `0` files).
- `POST /api/local-db/encrypt-export` & `POST /api/local-db/decrypt-import`: AES-256-GCM (`PBKDF2-SHA256-100000`) encrypted snapshot export and full workspace/context-ceiling restoration.
- `GET /api/logs` & `POST /api/logs/client`: Unified client and server structured ring-buffer runtime logs.

---

## 4. Key Engineering Guardrails

- **Line Ceiling:** Every `.ts`/`.tsx` file strictly `<= 600` lines.
- **Zero Regex:** Zero `RegExp`, `/pattern/`, `.match()`, `.split(/.../)`, or character classes across `src/`, `server/`, and `dev/`.
- **Zero Silent Fallbacks:** Missing or failing required models (chat, Nomic embedding, GLM-OCR + projector, Kokoro TTS) fail explicitly with actionable errors.
- **Network Access Policy:** Server binds to `0.0.0.0:3000` by default (`server/config/networkAccess.ts`) permitting loopback, RFC1918 private LAN, and Tailscale (`100.64.0.0/10` and `*.ts.net`) while blocking public internet IPs, metadata addresses, and untrusted `Host` / `Origin` headers. `llama.cpp` remains strictly on loopback (`127.0.0.1:8080`).
- **Scripts Directory:** Operational scripts ([`scripts/start-llmcp.ps1`](../scripts/start-llmcp.ps1), [`scripts/clean-data.ps1`](../scripts/clean-data.ps1), [`scripts/clean-data.ts`](../scripts/clean-data.ts)) live under `scripts/` and resolve the project root automatically regardless of caller working directory.
- **Temporal Evidence Priority:** `# Current Clock & Evidence Priority` is injected only when `webSearchEnabled` is enabled. For time-sensitive external claims, recent successful web/tool results outrank older chat history, memories, summaries, and model knowledge; conflicting or undated results must be reported as uncertain rather than guessed. Offline sessions remain free of ambient clock injection unless `system_context` is invoked.
- **UI Cleanliness:** Zero emojis, standard hyphens (`-` or `--`), zero yellow/amber Tailwind classes, and `document.body` portals for confirmation modals.
- **Branding:** Untouched Octopus icon from `public/assets/logos/llmcp-octopus.jpg` only; zero glowing text wordmarks.
