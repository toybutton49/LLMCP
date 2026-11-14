# Execution Flows & System Diagrams

**Application:** LLMCP: Large Language Model Control Portal  
**Purpose:** Verified prompt, retrieval, model lifecycle, and tool flows.

## 1. Chat turn

At server startup, LLMCP attempts to start or reuse the llama.cpp router and
begins sampling NVIDIA GPU memory once per second. Starting the router does not
load the main chat model; chat models load on a chat turn or manual request.

```text
[User submits prompt]
       │
       ▼
[Browser intake + readiness + retrieval preparation]
  ├─ Check /api/runtime/status (router, required models, effective token budget)
  ├─ Compute active window IDs via selectActiveWindowMessageIds
  ├─ Optional RAG / File Repo retrieval (/api/rag/query)
  ├─ Octo memory probe for offloaded turns & directives (/api/memory/probe)
  └─ Assemble context and BPE-aware token budget
       │
       ▼
[POST /api/chat/stream]
  ├─ Server probes Octo memory when enabled and not pre-probed
  │    └─ Temporary CPU-only Nomic embedding server (up to 8 threads), then stop
  ├─ Load/reuse selected chat GGUF via loopback router
  ├─ Enforce reasoning_budget_tokens / thinking_budget_tokens & fitConversationToContext
  ├─ Stream llama.cpp response over SSE
  └─ Execute authorized model-requested tools (respecting webSearchEnabled & enabledPluginIds)
       │
       ▼
[Turn complete] ──> [Arm idle TTL timer + sync DB & publish context pressure]
```

Embedding retrieval is separate from main-model inference. Its temporary
CPU-only server is started only when neural retrieval is requested and has
content to process. Chat memory retrieval requires the selected Nomic model.
If the model is missing or its probe fails, the request reports an error
instead of switching to deterministic retrieval.

## 2. Chat model load, memory placement, and eviction

```text
[Browser opened / refreshed]
       │
       ▼
[No main-model process started by page load]
       │
       ├── Optional: Settings -> Load Active Model
       │
       └── Chat prompt reaches /api/chat/stream
                     │
                     ▼
      [Load selected GGUF if not already served]
      [Request GPU offload according to active model settings]
                     │
                     ▼
      [SSE stream active: defer idle eviction]
                     │
                     ▼
      [Stream ends: schedule idle timeout]
          ├─ New turn: reuse warm server
          └─ Timeout / manual unload: stop managed process
```

The idle timeout comes from model settings or `MODEL_TTL_SECONDS`.
GPU-layer settings control the offload request; LLMCP cannot guarantee VRAM
placement or per-model memory use. The server samples total NVIDIA GPU memory
with `nvidia-smi` once per second for telemetry, while context pressure is
measured against maximum context length (`contextSize`, for example `8192`
tokens) rather than VRAM usage. At 90% or higher of maximum context tokens, it
compacts the active prompt context budget (`75%` of `contextSize`) and uses
`selectActiveWindowMessageIds` + `ContextOffloadManager` to embed older
conversation turns in batches with the selected CPU Nomic model -- covering both
turns beyond 39 messages and turns evicted earlier by token overflow. This does
not unload the chat model or free VRAM, and works independently of `nvidia-smi`.
Actual placement depends on the selected model, llama.cpp build/backend,
hardware, and available memory. CPU-only inference is available through the
GPU-layer setting. If LLMCP reuses an external server, it does not own or
terminate that process.

## 3. Separate OCR model flow

```text
[Supported attachment submitted (Upload, Drag & Drop, or Clipboard Paste)]
       │
       └─ Render PDF (1.5x scale) or image pages onto opaque #ffffff canvas/PNG
               └─ Temporary CPU-only GLM-OCR server (up to 8 CPU threads), then stop
                       └─ Original file saved + <file>.ocr.txt added to File Repo
```

The OCR route composites transparent regions onto white (`#ffffff`) so `stb_image`
never renders dark text on black, saves the original attachment in the File Repo,
and returns extracted text. The client adds that text as a separate `.ocr.txt`
File Repo entry. The temporary GLM-OCR process is stopped after the request; it
is not loaded into the chat server.

## 4. Tool dispatch

```text
[Model requests an exposed tool]
       │
       ▼
[Server validates tool name against allowed session schemas and executes handler]
  ├─ agent_file_ops (read-only File Repo read, exact CSV/log line match, audit, memory probe)
  ├─ precision_calculator (deterministic Pratt-parser arithmetic)
  ├─ system_context (local clock, timezone, OS platform, runtime status)
  └─ web_search (enabled by default; omitted when webSearchEnabled === false)
       │
       ▼
[Bounded tool result appended to conversation] ──> [Next inference round]
```

The chat handler bounds the number of tool rounds (`maxToolRounds: 4`) and
bounds tool outputs so multi-tool turns stay within `contextSize`. `web_search`
starts enabled by default (`webSearchEnabled: true`) and can be toggled `Off`
per chat to completely exclude `web_search` schemas and disable web grounding.
