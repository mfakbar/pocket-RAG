# ADR-002: Embedded Local RAG Backend

- Status: Accepted
- Date: 2026-07-24
- Decision owner: RavnDock
- Supersedes: ADR-001

## Current implementation note

The product name is now **RavnDock**. Internal package and Python module names
retain `pocketai` and `pocketrag_backend` for compatibility. This ADR remains the
architectural decision record; the current runtime, synchronization, retrieval,
model-residency, validation, and release behavior is documented in
[`ARCHITECTURE.md`](ARCHITECTURE.md).

## Context

The first prototype delegated retrieval to Open WebUI running inside a Podman
virtual machine. This introduced three failure domains before document chat could
work: the VM, the container, and an external HTTP API. Startup and repair were too
fragile for the intended non-technical user.

PocketRAG still needs proven RAG components, local folder synchronization, precise
citations, streamed chat, and every retrieval parameter already exposed in the UI.
It must not replace document parsing, vector search, embedding, or local inference
with untested custom implementations.

## Decision

PocketRAG owns a small local Python sidecar and composes established open-source
components:

- Docling provides structured PDF, DOCX, and PPTX parsing, table handling, OCR,
  provenance, and hybrid chunking.
- LanceDB provides an embedded vector store, full-text index, hybrid retrieval,
  and score combination.
- Ollama remains the local inference and embedding server.
- openpyxl is used for XLSX so citations include the exact sheet and cell range.
- Standard parsers handle CSV, text, and Markdown while preserving rows, lines,
  and sections.

```text
PocketRAG renderer
       |
   typed IPC
       |
Electron main process
  |             |
  |             +---- Ollama: chat + embeddings
  |
  +---- JSON lines over stdin/stdout
              |
       PocketRAG RAG sidecar
         |             |
      Docling       LanceDB
      parsers     hybrid index
```

The sidecar is not a general web service. Electron starts it as a child process,
communicates over private process pipes, and stops it when the app quits. This
removes localhost ports, container networking, VM startup, and external RAG API
compatibility from the application lifecycle.

## Settings mapping

All existing PocketRAG settings remain authoritative:

| PocketRAG setting  | Backend behavior                                  |
| ------------------ | ------------------------------------------------- |
| Top K              | Final number of retrieved chunks                  |
| Hybrid search      | LanceDB vector plus full-text search              |
| Keyword weight     | Linear vector/keyword score combination           |
| Full context       | Expand matched documents after retrieval          |
| Enriched metadata  | Add file, section, and location to embedding text |
| Text splitter      | Token or character sizing                         |
| Preserve headings  | Keep headings in chunks and embedding metadata    |
| Chunk size         | Maximum extraction/chunking size                  |
| Chunk overlap      | Overlap only within the same source region        |
| Minimum chunk size | Merge small adjacent chunks when safe             |
| PDF OCR            | Enable Docling OCR for PDFs                       |

Inference context length, temperature, top P, and output token limits continue to
be passed directly to Ollama.

## Citations

The backend returns source metadata in the product-defined format:

- PDF: page or page range
- PPTX: slide or slide range
- XLSX: sheet and cell range
- DOCX: heading and paragraph range
- CSV: row range
- text and Markdown: section and line range

Chunk overlap is restricted to chunks sharing the same provenance region so text
from one sheet, section, or page cannot be attributed to another.

## Synchronization and migration

The embedded index uses versioned generations. A rebuild writes a new generation
without changing the active one. PocketRAG switches generations only after every
document succeeds; cancellation or failure deletes the incomplete generation and
leaves the previous index available. Source documents are read-only.

Existing installations are identified by a backend schema version in local
settings. The first sync after this release performs one atomic rebuild from the
selected folder. Old Open WebUI identifiers are ignored and removed when settings
are next saved.

The packaged app downloads a pinned, checksum-verified `uv` archive and installs
the locked Python environment into PocketRAG's app data directory. No administrator
password or separate GUI is required.

## Validation

The initial corpus benchmark used all five supported files in the selected
knowledge folder and 30 expected-source questions. It achieved:

- Top-K source recall: 100%
- Mean reciprocal rank: 96.7%
- Citation coverage: 100%
- Average retrieval time: 170.5 ms

Regression tests cover per-format citations, Excel sheet isolation, and atomic
generation commit/rollback. The benchmark questions and runner are versioned under
`rag-backend/benchmark` so retrieval changes can be measured before release.

## Consequences

- Podman and Open WebUI are no longer runtime, install, repair, or packaging
  dependencies.
- PocketRAG owns the sidecar protocol and index migration behavior.
- Large parsing dependencies remain, but they run directly on macOS without a Linux
  VM and are locked per PocketRAG release.
- RAG library upgrades require citation regression tests and a corpus benchmark.
