<p align="center">
  <img src="public/assets/logos/llmcp-octopus.jpg" alt="LLMCP octopus logo" width="180">
</p>

<h1 align="center">LLMCP</h1>

<p align="center">
  <strong>Large Language Model Control Portal</strong><br>
  A private chat workbench for local GGUF models.<br>
  Load a model, add your documents, and get answers that cite the exact passage they came from. Your workspace stays local; web services are contacted only when you use web tools.
</p>

## Why LLMCP

LLMCP (Large Language Model Control Portal) is a self-contained browser app with a built-in llama.cpp server for chatting with models on your own GPU, with offline inference and zero cloud telemetry. The assistant is called **Octopus**. Here is what that gets you.

- **Private by default.** No account or cloud sync. Chats, memories and settings are stored locally; original File Repo files are stored separately on your machine.
- **Answers you can check.** When Octopus uses your documents, it names the file and line range it drew from, so you can verify the claim yourself.
- **Memory that sticks.** Save a directive, preference or fact once. Octopus brings it up when it is relevant, not on every message. Edits and deletes apply everywhere, including the search index.
- **Scanned documents, searchable.** PDFs and images are read by a local GLM-OCR model on your CPU, so a photographed invoice becomes text you can ask questions about.
- **Only relevant context gets in.** A local Nomic embedding model vectorizes memories (past chat context), uploaded files, prompts and responses. A stored item enters the prompt only when its similarity score clears the relevance bar. Ask about the weather and your invoices stay out of the way.
- **Honest failures.** If a required model is missing, LLMCP says so. It never quietly answers with a weaker fallback and pretends nothing happened.
- **No stale state.** The server holds the truth. Reloading the page shows what is actually saved, and two open tabs cannot silently overwrite each other's work.

## What you can do

- **Chat with local models.** In **Settings > Model**, select an auto-discovered chat model, context ceiling (`n_ctx`), idle unload timeout (`TTL`), active persona, sampling, and exact integer or slider token limits (**Reasoning token budget** and **Maximum response tokens**). Per chat, toggle **File Repo**, **Memory**, **Web Search** (enabled by default, disableable per session), **Reasoning** effort (`Low` / `Med` / `High` / `Off`), and optional **Tools**, while monitoring live context usage (`X / maxContext`) in the composer.
- **Attach complex multi-format files.** Upload, drag-and-drop, or paste (`Ctrl+V`) multi-page PDFs, images, CSV/TSV datasets, YAML/JSON configs, and code or Markdown specs directly into Chat or **File Repo**. Inline message editing (`Save Only` or `Save & Resend`), response regeneration, conversation branching, inline rename, chat filtering (`Ctrl+K`), and keyboard shortcuts (`Ctrl+B`, `Ctrl+K`, `Ctrl+,`, `Alt+N`) streamline multi-turn workflows.
- **Manage documents.** In **File Repo**, upload files or sync a server-accessible folder, inspect and pin items, and preview retrieval. Relevant passages can become chat context with citations, and `agent_file_ops` can read full files or match exact CSV/log rows on demand. Use **Settings > Knowledge** to adjust retrieval.
- **Manage memory and personas.** In **Memory & Personas**, create personas with their own instructions and temperature, save sentence-scoped directives from chat candidates, and semantically probe local records.
- **Use tools and plugins.** In **Tools & Plugins** (or the composer **Tools** popover), manage optional tools (`agent_file_ops`, `system_context`, `precision_calculator`), custom plugins, and **Web Search**. Built-in web search starts **On** by default and can be toggled **Off** per chat from the composer pill, Tools popover, or Tools & Plugins tab to omit `web_search` schemas and disable external web grounding.
- **Read documents with OCR.** Multi-page PDFs and images (PNG, JPEG, WebP, BMP, TIFF) are rendered onto white-composited pages and transcribed by a local GLM-OCR model running on CPU threads, then saved to your File Repo alongside `.ocr.txt` transcripts. Uploads can be up to 40 MB and up to 20 pages.
- **Monitor usage.** **Usage & Logs** shows token and latency analytics, active context window compaction, archived-turn indexing status, GPU memory telemetry, and searchable runtime logs.
- **Configure and back up.** **Settings** contains Model, Knowledge, Data & Security, and Diagnostics sections. Export or restore the workspace as plain JSON or as a passphrase-encrypted snapshot (AES-256-GCM with PBKDF2-SHA256), preserving model and context settings.

## Quick start

### What you need

- [Node.js](https://nodejs.org/) 22.13 or newer.
- [Git LFS](https://git-lfs.com/) to fetch the bundled OCR and embedding weights (about 1.58 GB total).
- A compatible chat GGUF model of your choice. Nomic embedding and GLM-OCR weights are included with the repository; you do not need to find them separately. See [Models](#models).

LLMCP serves its interface on `0.0.0.0:3000` by default (accessible on `http://localhost:3000`, your host PC's private LAN IP, and Tailscale `100.64.0.0/10` / `*.ts.net`, configurable via `--port`, `PORT`, `--host`, `HOST`, or Settings) while keeping the built-in llama.cpp router strictly on loopback (`http://127.0.0.1:8080` by default, configurable via `LLAMA_CPP_BASE_URL` or Settings) for on-demand local model loading and inference.
No `.env` file is needed or loaded; app settings are stored in the local workspace database. If an old `.env` selected a custom database or File Repo location, migrate that data before switching to the default locations.

### Start it

1. Clone the repository with Git LFS, then install dependencies:

   ```sh
   git lfs install
   git clone https://github.com/toybutton49/LLMCP.git
   cd LLMCP
   git lfs pull
   npm ci
   ```

   For an existing checkout, run `git lfs install` and `git lfs pull` from the repository directory. Use a Git LFS checkout rather than relying on GitHub's source ZIP, which may contain pointers instead of weights.

2. Copy your **chat model** into the `models` folder (see below). Keep the included OCR and embedding files in place.
3. Start LLMCP:

   ```sh
   npm run dev
   ```

   On Windows you can also run `.\scripts\start-llmcp.ps1`.

4. Open [http://localhost:3000](http://localhost:3000) (or your configured port). In **Settings > Model**, pick your auto-discovered chat model and configure persona or generation settings if desired. **Settings > Knowledge** discovers Nomic embedding and GLM-OCR models in `./models` dynamically (selecting a unique discovered model automatically, or letting you choose when multiple are present) without hardcoding model filenames.

## Models

### Bring your own chat model

Download a compatible chat `.gguf` model and check its license and hardware requirements. Place it under `./models`; it will appear automatically in **Settings > Model**. Chat models and any extra model weights remain gitignored.

### Included OCR and embedding models

These exact files are versioned with the code using Git LFS:

| Purpose | Bundled file | Size | Upstream source |
| --- | --- | --- | --- |
| File and memory retrieval | `models/nomic-embed-text-v1.5.Q8_0.gguf` | 146 MB | [nomic-ai/nomic-embed-text-v1.5-GGUF](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF) |
| Document OCR | `models/GLM-OCR-GGUF/GLM-OCR-Q8_0.gguf` | 950 MB | [ggml-org/GLM-OCR-GGUF](https://huggingface.co/ggml-org/GLM-OCR-GGUF) |
| OCR vision projector | `models/GLM-OCR-GGUF/mmproj-GLM-OCR-Q8_0.gguf` | 484 MB | [ggml-org/GLM-OCR-GGUF](https://huggingface.co/ggml-org/GLM-OCR-GGUF) |

GLM-OCR is a 0.9B-parameter model that runs on the CPU, so OCR does not compete with your chat model for VRAM. OCR accepts PDF and image attachments up to 40 MB. Upstream model licenses remain in effect ([zai-org/GLM-OCR](https://github.com/zai-org/GLM-OCR) MIT; [nomic-embed-text-v1.5](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/blob/main/LICENSE) Apache-2.0) and are separate from LLMCP's MIT license.

If a model file is only a small text file beginning with `version https://git-lfs.github.com/spec/v1`, it is a pointer, not usable weights. Run `git lfs pull` in the repository directory to fetch the pinned files. Once fetched, OCR and embedding inference work offline; there is no startup model download. GitHub LFS storage and download quotas apply when publishing or fetching these assets.

Fresh workspaces start with empty model selections and dynamically select a unique discovered Nomic embedding model or GLM-OCR model/projector pair in `./models`. Existing nonempty model selections are preserved, including missing selections that need your attention. When memory is enabled, chat and File Repo search require the selected Nomic embedding model and report an error if it is missing or fails. OCR reports an error if GLM-OCR or its projector is missing or fails. LLMCP does not silently replace a failed model-backed request with a fallback.

## How LLMCP behaves

- **Clear model status.** Memory search and File Repo search require the selected Nomic embedding model. OCR requires GLM-OCR plus its projector. Missing or failing models produce an error rather than a fallback.
- **Readiness before work.** A banner reports built-in server startup failures and offers an explicit retry. Chat checks the server and chat model before sending; it checks Nomic only when memory or document retrieval is enabled. PDF and image uploads check OCR readiness before reading or sending the file.
- **Web failures are visible.** Web search logs individual provider failures and reports an error if every provider fails instead of substituting local files. When web context includes explicit URLs, a failed page fetch stops the request; an explicitly requested chat verification also stops if grounding fails.
- **Hardware and reasoning settings you control.** Saving global settings in **Settings > Model** rebuilds the router that LLMCP manages and applies model-specific context ceilings, GPU layers, CPU threads, Flash Attention, idle unload `TTL`, and native `llama.cpp` thinking budgets (`reasoning_budget_tokens` / `thinking_budget_tokens`, sending `0` when reasoning is turned `Off`). The defaults (centralized in `src/data/runtimeDefaults.ts`) are full GPU offload and an 8,192-token context. If an external router already owns the configured loopback endpoint, LLMCP tells you it cannot apply hardware settings to that external process.
- **Context-length pressure and token-window offload.** Context pressure measures active context token length (using BPE-aware prose, numeric, and punctuation estimation) against the configured maximum context window (for example, 8,192 tokens) rather than GPU VRAM percentage, because loading a model into VRAM bumps VRAM usage automatically. At 90% or higher of max context, LLMCP compacts the active prompt budget to 75% of max context and uses the selected Nomic model to embed older conversation turns in batches into `.local-data/octo-vector-db.json` -- covering both turns beyond the 39-message window and turns evicted earlier by token overflow -- so evicted turns remain semantically retrievable in later turns. Meanwhile, `nvidia-smi` samples GPU VRAM once per second for informational telemetry when available.
- **Bounded auxiliary work.** OCR and embedding use bounded CPU inference threads (up to 8 threads by default, configurable via `AUXILIARY_MAX_THREADS`). Temporary CPU-only embedding and GLM-OCR servers start on demand when retrieval, context offload, or attachment OCR runs and stop immediately after each request finishes; neither auxiliary process is kept warm between calls. PDF pages and transparent images are composited onto opaque white backgrounds before GLM-OCR transcription so dark text never renders black-on-black, and OCR runs once on upload rather than on every prompt.
- **Your files stay intact.** The File Repo keeps original files separately from its searchable index. For OCR uploads, LLMCP stores the original file and adds the extracted text to the File Repo as a separate `.ocr.txt` entry.
- **Honest status.** The self-test exercises local application logic, but does not load a model or run inference. Confirm model behavior with a real chat before relying on it.

## Data and network

The app server accepts requests from loopback (`localhost` / `127.0.0.1`), private RFC1918 LAN addresses, and Tailscale (`100.64.0.0/10` and `*.ts.net` MagicDNS), blocking public internet IPs and untrusted `Host` / `Origin` headers. Pass `--host 127.0.0.1` (or `HOST=127.0.0.1`) to restrict binding strictly to loopback. A clean default workspace database ships at `.local-data/llmcp-db.json`, and original File Repo files are stored under `.local-data/file-repo/` (`.gitkeep` placeholders preserve the directory structure while uploaded files, backups, and vector indexes remain gitignored). Only the three bundled OCR/embedding weight files are tracked with Git LFS; chat models and other weights under `models/` remain gitignored. Git LFS contacts GitHub when you fetch the bundled weights.

Web search and page fetching contact external services only when you use those tools. Workspace snapshots do not include model weights or original files in the File Repo, so back those up separately.

## License

[MIT](LICENSE)
