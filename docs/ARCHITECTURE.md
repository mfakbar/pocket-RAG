# RavnDock Architecture

This document describes the RavnDock 1.1.0 implementation. RavnDock is a
local-first macOS document chat application for Apple Silicon Macs with at least
16 GB unified memory. The application package is named `pocketai` for historical
compatibility; the product shown to users is **RavnDock**.

For component-level execution rules and TTFT, generation-throughput, accuracy, and
failure-recovery analysis, see
[`INTERNAL_ENGINEERING_WORKFLOWS.md`](INTERNAL_ENGINEERING_WORKFLOWS.md).

## Product flow

```text
Welcome
  -> Create or choose a knowledge base
  -> Prepare local runtime and approved models
  -> Manually sync the selected folder
  -> Chat with files or the selected model alone
```

### First use

1. RavnDock shows a short welcome screen.
2. The user creates a knowledge base by choosing a local folder, adding a name and
   description, and optionally adding custom instructions.
3. The user chooses one initial chat model: Performance, Balanced, High Quality, or
   an Ollama-compatible custom model. RavnDock installs or starts Ollama, downloads
   that model plus the document-search model, installs the embedded document runtime,
   and starts the document engine.
4. The user starts a manual sync. RavnDock reads the chosen folder, builds the local
   index, and reports document-level progress or readable errors.
5. The knowledge base is ready for chat. The empty chat view offers three general
   ideas only: direct answers, insights, and concise summaries. It does not generate
   or store document-specific suggested prompts.

### Everyday use

- Select one or more synchronized knowledge bases, or choose **Model only** to chat
  without retrieval.
- Change the selected chat model from the chat composer or settings.
- Sync a knowledge base manually after its source folder changes. Sync is a protected
  background job and remains active when the user changes screens.
- Review knowledge-base file status, installed models, advanced retrieval settings,
  and resource usage from Settings and Monitor.

## Technology stack

| Layer             | Technology                                   | Responsibility                                     |
| ----------------- | -------------------------------------------- | -------------------------------------------------- |
| Desktop shell     | Electron 43, electron-vite                   | Native window, lifecycle, package integration      |
| User interface    | React 19, TypeScript, Tailwind CSS 4, Lucide | macOS-style UI, chat, settings, monitor            |
| Privileged bridge | Electron preload + typed IPC                 | Narrow renderer-to-main API surface                |
| Local inference   | Ollama                                       | Chat generation and embeddings on localhost        |
| RAG sidecar       | Python 3.12-3.14, `uv`                       | Private document extraction, indexing, retrieval   |
| Extraction        | Docling, openpyxl, pypdfium2, RapidOCR       | PDFs, Office files, spreadsheets, text, and OCR    |
| Local search      | LanceDB, PyArrow                             | Embedded vector and full-text hybrid index         |
| Optional ranking  | `BAAI/bge-reranker-v2-m3`                    | Extra ranking for ambiguous questions when enabled |

The Python module name remains `pocketrag_backend` for compatibility. It is not a
network service and is not exposed to the local network.

## Runtime architecture

```text
React renderer
    |
    | typed, context-isolated Electron IPC
    v
Electron main process
    |-- RuntimeOrchestrator: install, startup, health checks
    |-- KnowledgeService: scanning, manifests, atomic sync
    |-- OllamaService: local models, streaming, residency
    |-- LocalRagService: isolated query and ingestion child processes
    |-- ResourceMonitorService: Mac and RavnDock metrics
    |
    +-- Ollama on 127.0.0.1:11434
    |     |-- selected chat model
    |     +-- qwen3-embedding:0.6b when indexing or retrieving
    |
    +-- Python query child process over stdin/stdout
    |     |-- HybridStore reads the last committed generation
    |     +-- LocalReranker when enabled and appropriate
    |
    +-- Python ingestion child process over stdin/stdout
          |-- DocumentExtractor
          +-- HybridStore writes an isolated staging generation
```

The renderer cannot launch processes or read arbitrary files directly. The main
process validates IPC inputs, owns local process lifecycle, and returns only the
data required by the UI.

## Local data and privacy

- Source folders are read-only. RavnDock never modifies source documents.
- User settings, chat history, performance measurements, sync manifests, and the
  derived local index are stored under the operating system's application-data
  location.
- Folder access is limited to folders the user explicitly selects. macOS
  security-scoped bookmarks are retained so the app can reopen the selected folder.
- The app has no cloud inference, telemetry, analytics, advertising, or document
  upload path.
- After required software, models, and optional OCR assets are installed, normal
  chat and synchronization run offline. Internet access is used only for user-approved
  downloads.

See [`PRIVACY_POLICY.md`](PRIVACY_POLICY.md) for the public privacy policy.

## Model management and memory

RavnDock offers these default Ollama models during preparation and model management:

| Profile      | Model                  | Intended use                                                       |
| ------------ | ---------------------- | ------------------------------------------------------------------ |
| Performance  | `qwen3.5:2b-q4_K_M`    | Direct facts, short summaries, and simple procedures               |
| Balanced     | `qwen3.5:4b-q4_K_M`    | Comparisons, analysis, multi-section work, and spreadsheets        |
| High Quality | `qwen3.5:9b-q4_K_M`    | Detailed work when enough memory is available                      |
| Embeddings   | `qwen3-embedding:0.6b` | Downloaded automatically for local document indexing and retrieval |

Preparation downloads only the one chat model chosen by the user plus the embedding
model. The other profiles remain optional and can be downloaded later from Settings.

Only the selected chat model is kept resident. When the model changes, RavnDock
unloads other Ollama models before warming the new selection. The embedding model is
released after indexing or retrieval. **Improve Prompt** uses the chat model already
selected by the user; it does not load an extra helper model.

RavnDock warns when a 2B model is selected for a complex task, such as a comparison,
risk analysis, dense spreadsheet question, or multi-section request.

## Knowledge-base synchronization

Supported source formats are PDF, DOCX, PPTX, XLSX, CSV, TXT, and Markdown.

1. The scanner walks the chosen folder and skips hidden, temporary, and unsupported
   files.
2. It compares each file's relative path and SHA-256 checksum with the local manifest.
3. Every sync writes an isolated generation. Unchanged or uniquely renamed files clone
   their existing vectors and structured rows; added or changed files are extracted,
   chunked, embedded, and indexed.
4. The new generation becomes active only after all protected files succeed. Chat can
   continue against the last committed generation while ingestion runs. If processing
   fails, the previous generation remains active.
5. Completed parse and embedding artifacts are content-addressed locally, so a retry can
   reuse successful work without exposing an incomplete generation.
6. Per-file errors remain visible in Settings. The user can retry the sync without
   changing the source documents.

When Home or Settings opens a knowledge base, RavnDock performs a metadata-only path,
size, and modification-time check. It suggests a manual sync if the folder may have
changed; it does not continuously watch the user's filesystem.

Citation locators are preserved by file type:

- PDF: page or page range
- PPTX: slide or slide range
- XLSX: sheet and cell range
- DOCX: heading and paragraph range
- CSV: row range
- TXT and Markdown: section and line range

## Retrieval and answer generation

### Retrieval modes

The sidecar selects a retrieval mode from the question shape:

| Question shape          | Retrieval behavior                                             |
| ----------------------- | -------------------------------------------------------------- |
| Direct lookup           | Four to six passages from the named file; reranker skipped     |
| Document summary        | Coverage across major headings or slide groups                 |
| Spreadsheet comparison  | Structured rows from all requested sheets                      |
| Procedure or checklist  | Expanded context from the complete named document when it fits |
| Cross-document question | Balanced evidence from each relevant file                      |
| Ambiguous question      | Hybrid retrieval with optional reranking                       |

Hybrid retrieval combines semantic and full-text evidence. Advanced settings control
top K, keyword weight, chunking, heading preservation, metadata enrichment, full
context, and PDF OCR. Changes that affect indexing require a rebuild.

An explicit supported filename creates a strict retrieval boundary before semantic
search. Previous chat turns cannot add other filenames to that request, and hard-negative
results from other spreadsheets are discarded before structured execution or generation.
If the requested filename is not present in the selected knowledge base, RavnDock reports
that directly instead of silently searching other documents.

Files that share the same normalized name but have different numeric revisions or date
markers are treated as a version family. An explicitly named version always wins. Otherwise,
RavnDock uses a single clearly newest numbered or dated version; ambiguous variants remain
separate and the answer must disclose the conflict instead of combining their facts.

Complex questions are decomposed into up to four focused searches and embedded in one
local batch. Results are deduplicated, balanced, and expanded with neighboring chunks.
Before generation, an evidence-coverage pass identifies which requested categories are
supported and which must be reported as unavailable.

Spreadsheet files have two local representations: citation-ready text chunks and a
typed SQLite cell index containing sheet, row, column, cached value, numeric value,
unit, and formula metadata. Deterministic maximum, minimum, total, price, memory, and
lead-time operations use the typed index; the model explains the verified result.

Every indexed document also stores local title, path, heading, entity, document-summary,
and section-summary metadata. This metadata boosts document selection and supplies a
hierarchical navigation map, while citations continue to point only to raw source chunks.

### Streaming and validation

Ollama uses streaming chat responses. Tokens are passed from the main process to the
renderer as they arrive, so the response appears progressively instead of waiting for
the full answer.

Before a response is accepted, RavnDock normalizes model text and validates the result:

- requested categories must be addressed;
- factual paragraphs require support from retrieved passages;
- cited numbers and units must exactly match their source passages;
- unsupported inferences, repeated material, incomplete endings, malformed table
  artifacts, and raw pipe text outside valid Markdown tables are detected;
- valid Markdown tables are preserved, with factual rows validated and cited;
- credential-like fields are redacted;
- citations are attached from provenance metadata, not invented by the model.

Confidence thresholds are calibrated by retrieval mode and versioned as policy `1.0.0`.
Ambiguous questions require
stronger evidence than exact file lookups. Riskier multi-section answers can additionally
use the local reranker for semantic claim-to-passage verification; the reranker is released
before chat generation to protect unified memory.

**Improve document matching** is opt-in under Advanced Settings. Enabling it performs a
one-time, user-approved download of the revision-pinned `BAAI/bge-reranker-v2-m3` model
(about 2.3 GB). RavnDock reranks at most 24 hybrid candidates for broad or ambiguous
questions, maps scores to a normalized range for confidence checks, skips exact filenames
and direct lookups, and unloads the model after ranking or claim verification. Once cached,
the feature works offline.

When needed, RavnDock performs a targeted repair of only unsupported content or
returns a citation-safe fallback rather than presenting an ungrounded answer.
Consecutive statements supported by the same citation are collapsed to one citation
at the end of the run.

Verified responses are cached locally using a fingerprint of the question, model,
knowledge bases, context length, and exact retrieved passage contents. Any source change
produces a new fingerprint. The cache is private, bounded, and never used for subjective
interpretation requests.

`rag-backend/benchmark/regression_cases.json` records real failure patterns including named
spreadsheet isolation, missing-file handling, hard-negative files, reranker routing, and
version conflicts. `rag-backend/benchmark/release_evaluation.py` provides an automated
release gate for source recall@5, strict file isolation, version resolution, citation
validity, complete-answer rate, fallback rate, confidence calibration, prompt-injection
resistance, and labelled claim-verification precision/recall.

The main-process RAG helpers are organized by responsibility. `rag-pipeline.ts` is the stable
compatibility facade; conversation context, query policy, evidence ranking, direct lookup,
answer builders, spreadsheet grounding, shared terms, and shared types live in focused
`rag-*` modules. Callers can retain the facade imports while each policy area remains small
enough to test and change independently.

The Python sidecar follows the same boundary. `engine.py` owns indexing and query orchestration,
while `retrieval.py` contains the pure retrieval modes, source and sheet scoping, version-family
resolution, result diversification, and confidence calculations. `engine.py` re-exports the
existing helper names so benchmark and regression imports remain compatible.

## Screens and responsibilities

| Screen                  | Purpose                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| Welcome and preparation | Explain the local workflow and prepare approved dependencies                                                    |
| Home                    | Choose a model and knowledge base, sync it, and start a new chat                                                |
| Chat                    | Conversations, attachments, prompt templates, prompt improvement, citations, and compact local resource signals |
| Settings                | Knowledge-base details, source file list, model management, advanced retrieval/inference controls, About        |
| Monitor                 | CPU, memory, GPU, storage, temperature, active RavnDock processes, and model performance history                |

## Packaging and release

RavnDock currently targets macOS 12 or newer on Apple Silicon (`arm64`). The
repository supports an unsigned DMG release for GitHub distribution; no Apple
Developer ID is required for that path. Users must use **Privacy & Security → Open
Anyway** on first launch.

See [`GITHUB_RELEASE.md`](GITHUB_RELEASE.md) and
[`RELEASE_READINESS.md`](RELEASE_READINESS.md) for release checks.

## Development and verification

Requirements: Apple Silicon macOS, Node.js, npm, `uv`, and Ollama.

```bash
npm install
uv sync --project rag-backend --python 3.14
npm run dev
```

Run the required checks before a release:

```bash
npm run typecheck
npm run lint
npm test
npm run test:backend
npm run build
```
