# ADR-001: Prototype A Runtime Architecture

- Status: Superseded by ADR-002
- Date: 2026-07-23
- Decision owner: PocketRAG

This historical prototype decision was replaced by
[`ADR-002`](ADR-002-embedded-local-rag-backend.md). It no longer describes the
PocketRAG runtime.

## Context

PocketRAG is a local desktop application for non-technical users who want to chat
with documents without uploading prompts or document contents to a cloud service.
The primary experience is intentionally small:

1. Choose a local folder before runtime preparation begins.
2. Use the preselected Balanced model profile.
3. Prepare the local runtime and synchronize only the selected folder.
4. Chat with answers grounded in local documents.

PocketRAG is an orchestrator and product experience. It will not implement its
own inference engine, document extraction pipeline, vector database, retrieval
pipeline, or reranker.

The current prototype has already established an Electron and React desktop
shell. Ollama, Podman, and Open WebUI have also been tested manually and are
known to work together on the target development machine.

## Decision

Prototype A is the only approved architecture. Alternative RAG backends are out
of scope for this prototype.

```text
+------------------------------------------------------+
| PocketRAG                                             |
|                                                      |
| React renderer                                       |
|   -> typed Electron IPC                              |
| Electron main process                                |
|   -> runtime lifecycle and health                    |
|   -> model management                                |
|   -> knowledge synchronization                       |
|   -> chat streaming and citation normalization       |
+--------------------------+---------------------------+
                           |
             localhost HTTP APIs only
                           |
             +-------------+-------------+
             |                           |
             v                           v
      Ollama on the host        Open WebUI in Podman
      - chat model              - document extraction
      - embedding model         - vector database
                                - retrieval and RAG
                                - chat history
                                - source metadata
```

### Desktop application

- Electron and React remain the PocketRAG application shell.
- PocketRAG uses its own UI. Open WebUI is not embedded as the visible UI.
- The renderer never launches processes or calls privileged runtime APIs.
- All runtime operations go through typed IPC handlers in the Electron main
  process.
- IPC payloads and backend responses must be validated at runtime.

### Ollama

- Ollama runs directly on the host to use Apple Silicon acceleration.
- PocketRAG detects, installs, starts, health-checks, and manages Ollama and its
  models. The managed Ollama application is stored in PocketRAG's application
  data and its CLI is run directly, without opening a separate Ollama window.
- Ollama must listen on localhost only.
- Model downloads occur only after explicit user approval.

### Podman

- Podman runs only the Open WebUI container. Podman Desktop is not required.
- When Podman is missing, PocketRAG downloads the pinned official signed macOS
  CLI package, verifies its SHA-256 checksum and package signature, then invokes
  the macOS authorization prompt to install it.
- PocketRAG reuses an existing Podman machine when one is available and creates
  a dedicated machine only when needed. It owns one Open WebUI container.
- A newly created machine uses 4 CPUs, 4 GB memory, and 30 GB disk. These values
  must be verified on clean target machines before release.
- Open WebUI is exposed on an available localhost port only.
- The selected knowledge folder is not mounted into the container. Files are
  synchronized through Open WebUI's API.

### Open WebUI

- Use the exact tested image `ghcr.io/open-webui/open-webui:v0.9.5`. Never use
  `main` or `latest` in a released PocketRAG build.
- Open WebUI connects to host Ollama through the Podman host gateway.
- Open WebUI owns document extraction, chunking, vector storage, retrieval, and
  RAG. Prototype chat history is held only for the current PocketRAG session.
- PocketRAG owns lifecycle orchestration, user-facing state, folder selection,
  model profiles, synchronization progress, errors, and citation presentation.
- Open WebUI upgrades occur only as part of a tested PocketRAG release.
- The prototype must disable cloud providers, telemetry, and background model
  update behavior that is not explicitly initiated by the user.

### Knowledge synchronization

- Synchronization is manual. PocketRAG does not continuously watch the folder.
- PocketRAG maintains its own manifest containing relative path, SHA-256
  checksum, file metadata, and Open WebUI file ID. It uses Open WebUI's stable
  upload, processing, knowledge-linking, and deletion APIs. A newer native
  incremental-sync endpoint may be adopted only after its release is pinned and
  compatibility-tested.
- A sync handles added, modified, renamed, and deleted files.
- Unchanged files are not uploaded or re-embedded.
- Processing is asynchronous. PocketRAG polls file-processing status and reports
  per-file progress and failures.
- An interrupted sync is resumable or safely repeatable without changing source
  documents.
- The source folder remains the source of truth. The vector index is derived
  data and may be rebuilt.

### Model profile for the reference machine

Reference hardware: MacBook Pro 16-inch, M1 Pro, 16 GB unified memory.

- Default chat model: `qwen3.5:4b-q4_K_M`
- Default embedding model: `qwen3-embedding:0.6b`
- Default context limit: 8,192 tokens
- Reranker: disabled for the first prototype
- Retrieval: hybrid keyword and vector retrieval
- Text splitter: token
- Chunk size: 1,000 tokens
- Chunk overlap: 100 tokens
- Minimum chunk size: 500 tokens
- Top K: 4
- BM25 keyword weight: 0.5
- Metadata-enriched retrieval: enabled
- PDF loader: page mode, with OCR disabled by default
- Answer sampling: temperature 0.2, Top P 0.9, maximum 1,024 output tokens

The recommended model is installed during initial setup. After setup, users may
choose another compatible chat model already installed in Ollama. The model
selector shows practical guidance, model size, parameter count, and quantization.
Embedding-only models are excluded.

Reference candidates for later evaluation are:

| Profile  | Chat model          | Intended hardware            |
| -------- | ------------------- | ---------------------------- |
| Fast     | `qwen3.5:2b-q4_K_M` | 8 GB or responsiveness-first |
| Balanced | `qwen3.5:4b-q4_K_M` | 16 GB, default               |
| Quality  | `qwen3.5:9b-q4_K_M` | 24 GB or more recommended    |

All profiles use the same embedding model so changing chat quality does not
require rebuilding the knowledge base.

Advanced Settings exposes bounded retrieval, context, answer, chunking, and PDF
OCR controls. Query-time changes apply immediately. Chunking, heading,
metadata-enrichment, and OCR changes require a controlled knowledge-base rebuild.

### Citations

The LLM does not create source identifiers. PocketRAG renders citations from
retrieved chunk metadata returned by the RAG backend.

Each normalized citation contains:

- document ID
- relative file path
- file hash
- source format
- source locator
- retrieved snippet
- retrieval score when available

Source locators are format-specific:

- PDF: page number, optionally bounding box
- PPTX: slide number
- XLSX: sheet name and cell range
- DOCX: heading path and paragraph number
- CSV: row range with column headers retained
- TXT and Markdown: heading or line range

If extraction does not preserve an exact locator, PocketRAG shows the document
name and retrieved snippet. It must not fabricate a page, slide, cell, or line
reference.

### Privacy and network behavior

- Prompts and document contents are processed locally and are never
  intentionally uploaded.
- Internet access is used only for user-approved model, runtime, and application
  downloads.
- After setup, chat and knowledge synchronization must work with outbound
  network access blocked.
- Runtime services bind to localhost and are not exposed to the LAN.
- The no-auth localhost backend session token is kept in memory and is not
  written to `config.json`. If persistent credentials are introduced later,
  they must use operating-system-protected storage.

### Lifecycle and updates

- Startup order: settings, Ollama, Podman machine, Open WebUI, compatibility
  check, then ready state.
- Every startup stage has a timeout, typed failure, retry action, and diagnostic
  log entry.
- PocketRAG must not report a component as ready without a real health check.
- The prototype pins Open WebUI and model identifiers in one runtime
  configuration module. A full compatibility manifest follows before release.
- Application, Ollama, Podman CLI, Open WebUI, and model updates are independent and
  never performed silently.
- The prototype may leave local services running for faster reopening. Explicit
  shutdown controls and tray behavior are later lifecycle work.

## Prototype boundaries

The first implementation target is macOS on Apple Silicon. Windows and Linux
remain product goals but are not acceptance targets for the first prototype.

The first end-to-end slice is:

1. Detect or install Ollama and the Podman CLI.
2. Start and verify Ollama.
3. Initialize or start the PocketRAG Podman machine.
4. Start a pinned Open WebUI container with persistent storage.
5. Verify Open WebUI-to-Ollama connectivity.
6. Download the approved default models with visible progress.
7. Select and synchronize one folder.
8. Send a real streaming chat request.
9. Display normalized source citations.

Setup is initiated by the user from PocketRAG. Missing dependencies are
downloaded only after that approval; Podman installation may show one native
macOS password prompt.

## Acceptance criteria

- A clean supported machine can complete active setup without terminal use.
- Download duration is measured separately from active setup time.
- Repeating sync without file changes does not re-embed files.
- Interrupted synchronization can be repeated safely.
- Unsupported, encrypted, or failed documents are reported individually.
- A warm chat produces a visible first token within a hardware-specific target
  established by benchmark, not a universal promise.
- Every displayed citation resolves to stored retrieval metadata.
- Chat and sync succeed while outbound internet access is blocked after setup.
- Quitting PocketRAG leaves no PocketRAG-managed service exposed on the LAN.

## Consequences

### Benefits

- Reuses a proven local RAG stack already tested by the product owner.
- Keeps PocketRAG focused on simplicity, orchestration, and user experience.
- Avoids implementing document parsing, vector storage, retrieval, and RAG from
  scratch.
- Provides a direct path to the desired folder, model, sync, and chat workflow.

### Costs and risks

- Podman adds a Linux VM on macOS and Windows.
- Clean-machine installation and recovery remain substantial engineering work.
- PocketRAG depends on Open WebUI API compatibility and data migrations.
- Open WebUI licensing and branding requirements must be resolved before broad
  public or commercial distribution.
- Exact citations for every Office format depend on extraction metadata and must
  be validated rather than assumed.

## Explicitly rejected for this prototype

- Replacing Open WebUI with Khoj, Kotaemon, AnythingLLM, GPT4All, RAGFlow, or a
  custom RAG backend
- Replacing Podman with Docker Desktop or a custom virtual machine layer
- Building a custom parser, vector database, retrieval engine, or reranker
- Continuous folder watching
- Cloud inference or cloud document storage
- Automatic untested dependency upgrades

## Confirmed implementation inputs

The product owner confirmed the following on 2026-07-23:

1. The prototype is for internal testing and will not be distributed publicly
   until the Open WebUI licensing posture is resolved.
2. macOS on Apple Silicon is the only first-prototype acceptance platform.
3. PocketRAG installs missing Ollama and Podman CLI dependencies. Users do not
   need to open Podman Desktop or run setup commands manually.
4. `Balanced` is the only model option in the first working slice. `Fast` and
   `Quality` follow later.
5. Synthetic PDF, DOCX, PPTX, XLSX, CSV, TXT, and Markdown fixtures will be used
   unless a representative non-sensitive document folder is provided later.

No additional product input is required before implementation begins.
