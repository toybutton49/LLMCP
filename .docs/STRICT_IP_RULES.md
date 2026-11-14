# Architecture Guardrails & The Golden Rules

**Location:** `./.docs/STRICT_IP_RULES.md`  
**Application:** LLMCP: Large Language Model Control Portal  
**Automated Test Enforcement:** `dev/tests/architecture-hygiene.test.ts`, `dev/tests/audit-regressions.test.ts`, `dev/tests/context-offload.test.ts`, `dev/tests/tools-and-web.test.ts`  
**Mandate:** Authoritative engineering rules across all domains.

---

## The Golden Rules

### 1. The Four Octopus Components
- **The Brain:** Main LLM in `llama.cpp` (`src/orchestrators/index.ts`, `server/llamacpp/*`) handling reasoning (`reasoning_budget_tokens` / `thinking_budget_tokens`) and autonomous tool selection.
- **Embedding & Vector DB:** Model-backed retrieval requires the selected, discovered local Nomic embedding model (`src/utils/memory/octoVectorDatabase.ts`, `.local-data/octo-vector-db.json`). Missing or failing models produce explicit errors rather than deterministic fallbacks. Vector probes apply origin role multipliers (`persistent_rule`: 1.25x, `user`: 1.15x, `tool_verified`: 1.10x vs `assistant_synthesis`: 0.70x), tag records with CUIDs, and purge aborted turns.
- **The 10 Tentacles:** Modular feature managers in `src/orchestrators/*.ts` (Chat, Intake, Knowledge, Memory, Context, Tools, Inference, Analytics, Storage, Logging).
- **Tools:** API endpoints and callable tools (`agent_file_ops`, `precision_calculator`, `system_context`, and `web_search`, which defaults to `On` per session and can be toggled `Off`).

### 2. Never Reload the Model on UI Refresh
Opening or refreshing the browser tab must never load the model into GPU memory. The model loads strictly JIT on prompt submission (`POST /api/chat/stream`) or manual click in Settings.

### 3. Never Use Regular Expressions
Avoid `RegExp`, `/pattern/`, `.match()`, `.replace(/.../)`, `.split(/.../)`, and character classes (`[...]`, `[^...]`) across `src/`, `server/`, and `dev/`. All text parsing and GBNF grammars must use deterministic programmatic loops, string scans, or explicit BNF literal tokens.

### 4. Never Exceed 600 Lines Per File
Every `.ts` and `.tsx` file in `src/`, `server/`, and `dev/` must strictly be 600 lines or fewer.

### 5. Consolidate Read-Only File Repo Inspection into One Tool
Consolidate all model-callable File Repo, symbol/security lexical analysis, and memory-probe operations into one unified read-only tool: **`File Repo Inspector, Auditor & Memory Prober`** (`id: 'agent_file_ops'`). It exposes no destructive write, edit, delete, or move actions to the model.

### 6. Never Drop the Trailing User Message
History compaction in `normalizeConversationHistory` must never drop or truncate the most recent user turn.

### 7. Never Spawn Subprocesses on Streamed Tokens
During streaming and `<think>` reasoning, update the idle timer in memory (`refreshActiveTtlTimer`). Never spawn shell commands per token chunk.

### 8. Never Duplicate Tool Outputs in Prompts
When a tool turn finishes with `role: 'tool'`, do not duplicate the output text back into system instructions.

### 9. Never Pre-Trigger Tools with Keyword Matches
Do not guess tool calls via simple string matching. Expose schemas to the model and let the AI Brain decide autonomously.

### 10. Never Depend on External Cloud Wrappers
LLMCP runs 100% locally on built-in `llama.cpp` using models placed in the root `./models` folder.

### 11. Never Allow Unbounded Tool Loops
Cap tool iterations at 4 rounds per turn (`MAX_AGENT_TOOL_ROUNDS = 4`) and track call signatures to prevent repeat loops.

### 12. Never Use Emojis, Em-Dashes, Yellow/Amber Colors, or Text Wordmarks
- Use Lucide icons instead of emojis.
- Use standard hyphens (`-` or `--`) instead of em-dashes.
- Use the signature Salmon (`#f27261`) and clean grayscale palette (no yellow/amber utilities).
- Use the official Octopus icon logo from `public/assets/logos/llmcp-octopus.jpg` across the app; zero glowing text wordmarks.

### 13. The User is the Principal Systems Architect
The human user is the sole Systems Architect and sovereign owner of product design, engineering architecture, and roadmap priorities. The coding assistant implements instructions deterministically without overriding architectural mandates or imposing unsolicited refactors.

### 14. Never Execute `git push`
Git deployment, remote pushes, release staging, and branch publishing are strictly reserved for the Systems Architect. The coding assistant handles local files, automated tests, and local builds only.

### 15. Strict Local Containment & Security Boundaries
All filesystem tool operations must stay within designated local workspace boundaries. Zero path traversal and zero SSRF to internal/cloud metadata addresses (`169.254.169.254`).

### 16. Zero Runtime Data Leaks & Single Root README
Maintain a single root `README.md` (never create subdirectory READMEs). Track only the clean default `.local-data/llmcp-db.json`, `.local-data/file-repo/.gitkeep`, and the three Git LFS auxiliary weight files (`nomic-embed-text-v1.5.Q8_0.gguf`, `GLM-OCR-Q8_0.gguf`, `mmproj-GLM-OCR-Q8_0.gguf`), while keeping uploaded files, `.local-data/octo-vector-db.json`, `.test-data/`, exported snapshots, and chat `.gguf` weights gitignored.

### 17. Zero Hardcoded Runtime Values & Token-Based Context Pressure
Centralize all runtime, hardware, generation, RAG, memory-probe, telemetry, auxiliary server, and OCR defaults in `src/data/runtimeDefaults.ts` and `server/config/env.ts`. Measure context pressure strictly from active context token length (`>= 90%` of `contextSize`), never GPU VRAM percentage, compacting the active budget to `75%` and batch-embedding evicted turns (both `> 39` turns and token-overflow-evicted turns via `selectActiveWindowMessageIds`) with CPU Nomic embeddings.
