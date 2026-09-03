# RavnDock Internal Engineering Workflows

**Product version:** 1.1.0  
**Document status:** Current implementation reference  
**Target platform:** Apple Silicon macOS, minimum 16 GB unified memory  
**Last verified:** 2026-08-09

This document explains the implemented RavnDock architecture, execution rules, local
resource effects, and quality controls. It is intended for engineers changing the
runtime, retrieval pipeline, model configuration, document processing, or monitoring
experience.

## Corrected Technology Stack

- **Desktop:** Electron 43, electron-vite, React 19, TypeScript, Tailwind CSS 4.
- **Process boundary:** context-isolated Electron preload with typed IPC. The renderer
  has no direct Node.js or arbitrary filesystem access.
- **Generation and embeddings:** local Ollama on `127.0.0.1:11434`. The selected chat
  model generates answers; `qwen3-embedding:0.6b` creates query and document vectors.
- **RAG sidecar:** Python 3.12-3.14 child process communicating through newline-delimited
  JSON over private stdin/stdout pipes. It is not an HTTP service.
- **Parsing:** `pypdfium2` for native PDF text, RapidOCR for optional scanned-PDF OCR,
  `openpyxl` for XLSX, Python's CSV/text parsers for CSV/TXT/Markdown, and Docling for
  DOCX/PPTX conversion and chunking.
- **Search and derived state:** LanceDB/PyArrow for vector and full-text chunk retrieval;
  SQLite for active document versions, typed spreadsheet cells, metadata, document and
  section summaries, and generation state.
- **Optional ranking:** revision-pinned `BAAI/bge-reranker-v2-m3`, downloaded only after
  the user enables Improve document matching.

RavnDock no longer depends on Podman or Open WebUI. Source documents are read-only;
all indexes, manifests, settings, chat history, caches, and measurements are derived
local application data.

## How to Interpret the Performance Ratings

- **TTFT** covers the complete interval before the first visible generated token. It
  can include model loading, query embedding, retrieval, optional reranking, context
  construction, and Ollama prompt evaluation.
- **Tokens/sec** measures Ollama evaluation throughput after generation starts. Most
  retrieval work does not directly change this metric, but a larger prompt, a larger
  model, memory pressure, swap, or thermal throttling can reduce it.
- **Response accuracy** means source selection, factual correctness, numerical fidelity,
  citation support, completeness, and resistance to unsupported inference.
- Relative impact labels are architectural assessments, not guarantees. The Monitor
  records real TTFT, tokens/sec, inter-token latency, and end-to-end latency by model.
  Hardware, model build, document size, and current memory pressure remain variable.

## Desktop Process Isolation and IPC

- **Technical Mechanism:** The React renderer calls a narrow API exposed by the
  context-isolated preload. Electron's main process owns filesystem selection,
  security-scoped bookmarks, settings, Ollama, child-process lifecycle, sync jobs,
  resource sampling, and chat orchestration. The main process starts separate Python
  query and ingestion sidecars against the same generation-aware local store. Requests
  use unique IDs over JSON-lines stdin; responses return over stdout and diagnostics use
  stderr. Ollama is called separately over localhost HTTP.
- **Under the Hood Rules & Constraints:** The renderer cannot spawn processes, import
  Node APIs, or read arbitrary local paths. IPC payloads use shared TypeScript contracts.
  Each Python server handles its own input loop synchronously, but query work does not queue
  behind parsing or OCR. Sync writes a staging generation while chat reads the last committed
  generation. IPC
  timeouts are operation-specific: ordinary retrieval allows two minutes, reranker
  retrieval ten minutes, attachments five minutes, and document indexing twenty minutes.
- **Performance & Quality Impact Matrix:**
  - **TTFT Impact:** Low for IPC serialization. A running sync can still compete for disk,
    CPU, or Ollama embedding resources, but it no longer serially blocks query IPC.
  - **Tokens/Sec Impact:** None during steady generation. IPC forwards already generated
    token chunks and does not perform inference.
  - **Response Accuracy Impact:** Positive. Privileged operations and contracts stay in
    one controlled layer, reducing malformed requests and accidental source access.
  - **Overall Impact:** Highly recommended as a security and maintainability best
    practice. Isolated sidecars preserve chat availability during long ingestion.
- **Edge Cases & Failure Recovery:** A dead sidecar is detected by health checks and can
  be restarted by the runtime orchestrator. Pending requests have timers and reject on
  timeout. The UI receives friendly errors rather than raw child-process traces. A
  stalled heavy sync does not freeze React or queue chat retrieval. Unexpected sidecar exits
  use bounded exponential restart backoff; RavnDock does not silently turn file chat into
  model-only chat.

## First-Run Runtime Preparation

- **Technical Mechanism:** RuntimeOrchestrator verifies the selected knowledge folder,
  locates or installs a managed Ollama CLI, starts Ollama, downloads only the user's
  selected chat model plus `qwen3-embedding:0.6b`, installs the pinned Python RAG runtime,
  starts the sidecar, and performs a health check. Preparation emits step, percentage,
  downloaded-byte, and total-byte progress to the preparation UI.
- **Under the Hood Rules & Constraints:** Internet access is used only for approved
  software/model downloads. The default profiles are Performance
  (`qwen3.5:2b-q4_K_M`), Balanced (`qwen3.5:4b-q4_K_M`), and High Quality
  (`qwen3.5:9b-q4_K_M`), but preparation downloads one chosen chat model rather than all
  three. A custom Ollama-compatible model may replace it. Downloads accept an AbortSignal;
  cancellation is presented as a paused, retryable preparation state.
- **Performance & Quality Impact Matrix:**
  - **TTFT Impact:** High on first use because downloads, process startup, and model warm-up
    precede chat. Low on later launches when dependencies and the selected model exist.
  - **Tokens/Sec Impact:** Model choice is the dominant factor. On a 16 GB M1, the 2B model
    normally leaves the most memory headroom; 4B trades throughput for stronger synthesis;
    9B has the highest pressure and greatest risk of reduced throughput or swap.
  - **Response Accuracy Impact:** Higher-capacity models generally improve complex
    synthesis, but preparation itself does not change retrieval quality.
  - **Overall Impact:** Highly recommended. One-model onboarding materially lowers setup
    time, disk use, and abandonment compared with downloading all profiles.
- **Edge Cases & Failure Recovery:** If Ollama is installed but stopped, RavnDock starts
  it and waits up to 30 seconds. Missing or failed components remain individually visible.
  Interrupted model downloads can be resumed by Ollama. Normal chat and sync work offline
  after all required local assets have been downloaded.

## Chat Model Residency and Apple Unified Memory

- **Technical Mechanism:** Before generation, `activateModel()` asks Ollama for running
  models, unloads every model except the selected chat model, and warms that model with a
  ten-minute keep-alive. Embedding calls use `keep_alive: 0`, releasing the embedding
  model after indexing or retrieval. Prompt improvement uses the currently selected chat
  model instead of loading a separate helper model.
- **Under the Hood Rules & Constraints:** Only one chat model should remain resident.
  Switching models explicitly unloads the previous model. The warm-up context is capped
  at 8K, while a chat request can use an adaptive 8K or 16K context. The monitor reports
  Ollama's model size and accelerator allocation, but macOS unified memory means GPU and
  CPU allocations are not physically independent pools.
- **Performance & Quality Impact Matrix:**
  - **TTFT Impact:** Medium to high on a cold model or model switch; low when the selected
    model is already warm. Unloading competitors prevents a larger memory-related delay.
  - **Tokens/Sec Impact:** Strong positive protection. Avoiding simultaneous chat,
    embedding, and reranker residency reduces memory contention and swap risk.
  - **Response Accuracy Impact:** Neutral directly. A larger model can improve difficult
    comparisons, but memory pressure can make the experience too slow to be useful.
  - **Overall Impact:** Highly recommended for the minimum 16 GB target.
- **Edge Cases & Failure Recovery:** If unload fails, the operation reports an error rather
  than silently allowing uncontrolled residency. Users selecting 2B for comparisons,
  risk analysis, dense spreadsheets, or multi-section work receive a recommendation to
  use Balanced, but their explicit model choice is respected.

## Knowledge Folder Discovery and File Scanning

- **Technical Mechanism:** The main process resolves the selected folder to its real path,
  validates that it is a directory, recursively walks entries in deterministic sorted
  order, and streams each supported file through SHA-256. The scan records relative path,
  checksum, byte size, and modification time.
- **Under the Hood Rules & Constraints:** Supported extensions are PDF, DOCX, PPTX, XLSX,
  CSV, TXT, and Markdown. Hidden names, Office temporary files beginning with `~$`,
  symbolic links, unsupported extensions, and non-files are skipped. Symbolic links are
  never followed, which prevents the selected folder from indirectly escaping to another
  filesystem location. Filesystem access remains within a user-selected folder restored
  through a macOS security-scoped bookmark.
- **Performance & Quality Impact Matrix:**
  - **TTFT Impact:** None during ordinary chat after sync. A concurrent scan can create
    disk contention, and a subsequent sidecar indexing request can queue chat retrieval.
  - **Tokens/Sec Impact:** Normally none; sustained disk and CPU activity can have a small
    indirect effect under thermal or memory pressure.
  - **Response Accuracy Impact:** High positive. Checksums prevent stale unchanged files
    from being reindexed and deterministic paths preserve stable document identity.
  - **Overall Impact:** Highly recommended as a safe, incremental-sync foundation.
- **Edge Cases & Failure Recovery:** An invalid folder fails before indexing. An empty
  supported-file set clears that knowledge base's derived index but never changes source
  files. Cloud-placeholder files that are not locally available can fail to open; the
  per-file error asks the user to make the file available on the Mac and retry.

## Initial Ingestion and Atomic Rebuild

- **Technical Mechanism:** A new or schema-outdated knowledge base starts a separate index
  generation. Every file is parsed, chunked, embedded, and written against that generation.
  `commit_rebuild` atomically marks the generation active only after processing completes.
  The source manifest is then updated to the committed document set.
- **Under the Hood Rules & Constraints:** The current backend schema marker is version 5.
  If a document that existed in the previous manifest fails during rebuild, RavnDock aborts
  the new generation and preserves the previous active index. A newly introduced file may
  fail without invalidating already successful files in the new generation. Source
  documents are read-only throughout the operation.
- **Performance & Quality Impact Matrix:**
  - **TTFT Impact:** No direct effect after completion. Chat continues against the last
    committed generation during rebuild instead of waiting for ingestion IPC.
  - **Tokens/Sec Impact:** None structurally; embedding and parsing can temporarily consume
    CPU, GPU, and memory if generation starts concurrently.
  - **Response Accuracy Impact:** High positive. Atomic activation prevents partially
    rebuilt indexes from replacing a previously consistent knowledge base.
  - **Overall Impact:** Highly recommended and required for index-format migrations.
- **Edge Cases & Failure Recovery:** Any outer rebuild exception triggers an abort attempt.
  Existing active data remains usable when an old document fails. Errors are stored per
  file with friendly text plus redacted technical details. Content-addressed parse/vector
  artifacts survive an aborted generation, allowing a retry to reuse completed file work.

## Incremental Folder Sync

- **Technical Mechanism:** After scanning, every sync builds a staging generation. Unchanged
  files clone their active chunks and structured metadata without parsing or embedding;
  unique content-hash rename matches clone the same artifacts under the new path. New and
  changed files use a content-addressed compressed artifact cache, then the complete
  generation is committed atomically. Progress remains visible while screens change.
- **Under the Hood Rules & Constraints:** Files with previous sync errors are retried even
  if their checksum is unchanged. Failed updates do not overwrite a successful manifest
  entry. Only the selected knowledge base is synchronized. Sync never watches every local
  folder and never modifies the chosen source directory.
- **Performance & Quality Impact Matrix:**
  - **TTFT Impact:** Low when only unchanged files are scanned; medium/high resource
    contention is possible when changed files require parsing and embedding, but chat does
    not wait for the ingestion sidecar.
  - **Tokens/Sec Impact:** Usually none, with possible indirect reduction from concurrent
    embedding, disk activity, or thermal pressure.
  - **Response Accuracy Impact:** High positive because deleted and changed documents are
    reflected without rebuilding unrelated files.
  - **Overall Impact:** Highly recommended common practice for folder-backed RAG.
- **Edge Cases & Failure Recovery:** A failure is isolated to its file. The UI reports the
  number of failed documents and a readable cause. The user can leave the screen without
  cancelling the job, then retry later. Interrupted sync preserves the previous generation;
  a retry reuses valid per-file artifacts keyed by checksum, embedding model, and settings.

## Format-Specific Parsing, OCR, and Provenance

- **Technical Mechanism:** PDF pages are extracted with pypdfium2. Pages with no native
  text can be rendered at 2x and passed to local RapidOCR when PDF OCR is enabled. XLSX is
  read with `openpyxl` in read-only/data-only mode for citation chunks and again for typed
  cached/formula cell indexing. CSV, TXT, and Markdown use dedicated parsers. DOCX and PPTX
  use Docling conversion plus its HybridChunker. Every output carries file-type-specific
  provenance.
- **Under the Hood Rules & Constraints:** Citation locations are PDF page, PPTX slide,
  XLSX sheet and cell range, DOCX heading and paragraph, CSV row range, and TXT/Markdown
  heading and line range. OCR is disabled by default because it is slower and may require
  a one-time local model download. No extracted document text is sent to a cloud service.
- **Performance & Quality Impact Matrix:**
  - **TTFT Impact:** None after indexing. High ingestion latency for scanned PDFs and complex
    Office documents; OCR and Docling are the heaviest paths.
  - **Tokens/Sec Impact:** None after parsing, except temporary resource contention if chat
    overlaps ingestion.
  - **Response Accuracy Impact:** High positive because structured provenance supports exact
    citations. OCR accuracy remains lower than native text and can propagate recognition
    errors into retrieval.
  - **Overall Impact:** Native parsers are highly recommended. OCR is recommended only for
    scanned PDFs that otherwise contain no readable text.
- **Edge Cases & Failure Recovery:** A textless PDF with OCR off is rejected with guidance.
  Missing OCR assets produce a one-time-download message. Password-protected, corrupted,
  unsupported, or cloud-placeholder files fail individually and remain visible in Settings.
  Very large files can reach the 20-minute index timeout and should be split or optimized.

## Chunking, Metadata Enrichment, and Embedding

- **Technical Mechanism:** Parsed blocks are split by token count by default, or by
  characters when configured. Default settings are 1,000-unit sections, 100-unit overlap,
  and 500-unit minimum sections. Small adjacent pieces are merged. Overlap is added only
  across compatible provenance boundaries, such as the same PDF page/heading or the same
  spreadsheet sheet/range family. Embedding text can prepend filename, section, and location
  metadata before calling Ollama.
- **Under the Hood Rules & Constraints:** Heading preservation is enabled by default. Table
  headers are repeated when Docling divides a table. The stored source text and enriched
  embedding text are separate: enrichment improves matching without changing what is cited.
  The embedding model is released with `keep_alive: 0` after each batch.
- **Performance & Quality Impact Matrix:**
  - **TTFT Impact:** Query embedding adds low/medium pre-generation latency. Larger chunks
    can reduce retrieval calls but increase prompt evaluation time; smaller chunks increase
    candidate count and fragmentation.
  - **Tokens/Sec Impact:** Indirect. Larger selected chunks fill more context and can reduce
    generation throughput on Apple Silicon.
  - **Response Accuracy Impact:** High. Preserved headings and conservative overlap improve
    passage coherence; excessive overlap can duplicate evidence and bias rankings.
  - **Overall Impact:** The defaults are recommended general-purpose settings. Rechunking
    should be benchmarked against the regression set before release.
- **Edge Cases & Failure Recovery:** Empty blocks are discarded. Oversized tables or sections
  are split while retaining provenance. Any change to chunking, enrichment, heading, or OCR
  settings requires rebuilding affected knowledge bases; otherwise old indexed chunks would
  not match the new policy.

## LanceDB, SQLite, and Index Versioning

- **Technical Mechanism:** LanceDB stores chunk vectors, full text, embedding text, source
  provenance, document/version IDs, generation IDs, and chunk indexes. SQLite stores active
  document versions, typed spreadsheet cells, metadata, hierarchical summaries, and active
  generations under WAL journaling. Queries filter to active documents and generations.
- **Under the Hood Rules & Constraints:** Source changes create new version identities.
  Search cannot use an inactive rebuild generation. Derived records are scoped by knowledge
  base and document. Local response-cache files use mode `0600`; source and index paths stay
  in the application data directory rather than the selected source folder.
- **Performance & Quality Impact Matrix:**
  - **TTFT Impact:** LanceDB's memory-mapped local retrieval is low latency for ordinary
    corpora; hybrid FTS, multiple subqueries, or large candidate pools increase it.
  - **Tokens/Sec Impact:** None directly. Very large local indexes can increase memory and
    page-cache pressure, indirectly affecting model throughput.
  - **Response Accuracy Impact:** High positive. Active-generation filtering and typed cells
    prevent stale versions and lossy spreadsheet text from being treated as current facts.
  - **Overall Impact:** Highly recommended production architecture for a local app.
- **Edge Cases & Failure Recovery:** WAL protects SQLite consistency during interrupted
  writes. Atomic generation selection protects LanceDB visibility. If derived data becomes
  incompatible, backend-version mismatch forces a rebuild from unchanged source documents.

## Multi-Turn Conversational Memory

- **Technical Mechanism:** RavnDock does not continuously summarize the full conversation
  with another model. A deterministic resolver inspects the latest user turn. Explicit
  filenames always stand alone. Obvious follow-ups such as “the second point,” “what about
  that,” or “tell me more” are rewritten into a standalone retrieval query containing the
  previous user question, a compact outline of the previous assistant answer, and the new
  follow-up. New topics are left unchanged.
- **Under the Hood Rules & Constraints:** The outline keeps up to 24 Markdown headings/list
  items, or up to eight sentences when structure is absent, with each item capped at 240
  characters. Missing antecedents and invalid ordinal references return a clarification
  instead of guessing. When prior context was not used, only the latest user turn is sent
  to generation, preventing chat history from filling the context window.
- **Performance & Quality Impact Matrix:**
  - **TTFT Impact:** Low. Rewriting is local string processing with no additional inference.
  - **Tokens/Sec Impact:** Positive compared with sending full history because the model
    evaluates fewer prompt tokens.
  - **Response Accuracy Impact:** Positive for clear follow-ups and topic switches. It can
    miss novel conversational references not covered by the deterministic patterns.
  - **Overall Impact:** Highly recommended for predictable local performance. A learned
    condenser would require rigorous injection and latency controls before replacing it.
- **Edge Cases & Failure Recovery:** A follow-up without a prior answer asks what the user
  means. An ordinal not present in the outline asks the user to name or quote the point.
  An explicit filename prevents stale prior files from leaking into a new retrieval scope.

## Query Planning, Decomposition, and Retrieval Modes

- **Technical Mechanism:** The main process anticipates a mode from the question shape;
  the sidecar confirms it. Modes are direct lookup, document summary, spreadsheet
  comparison, procedure/checklist, cross-document, and ambiguous. Multi-category or long
  complex questions are decomposed into at most four focused subqueries, embedded in one
  local batch, and recombined before selection.
- **Under the Hood Rules & Constraints:** Direct lookup targets approximately four to six
  passages. Summaries seek major heading/slide coverage. Spreadsheet tasks retrieve typed
  rows and expanded ranges. Procedures can expand a complete named document when it fits.
  Cross-document retrieval balances relevant files. Ambiguous questions use stricter
  confidence thresholds and are the primary reranker candidates.
- **Performance & Quality Impact Matrix:**
  - **TTFT Impact:** Low for mode classification; medium for decomposition because up to four
    queries increase vector and FTS work, although embeddings are batched.
  - **Tokens/Sec Impact:** Indirectly positive when planning avoids irrelevant context;
    negative when broad modes legitimately select more evidence.
  - **Response Accuracy Impact:** High positive for multi-part requests because evidence is
    collected per requested category rather than from one dominant query phrase.
  - **Overall Impact:** Highly recommended industry practice with bounded decomposition.
- **Edge Cases & Failure Recovery:** Direct lookup intentionally skips decomposition. Queries
  shorter than eight words generally remain single. Evidence coverage later marks requested
  categories that retrieval could not support, preventing the model from filling gaps.

## Deterministic Source, Sheet, and Version Resolution

- **Technical Mechanism:** Before semantic retrieval, the sidecar compares the question
  with the active source catalog. Exact supported filenames have highest priority. Full
  normalized stems, titles, project/customer metadata, and unique sheet aliases are resolved
  next. Common aliases such as `mgmt`/`management` and `spec`/`specification` are normalized.
  A resolved source becomes a hard file and optional sheet filter applied to chunks,
  neighbors, typed rows, summaries, complete-document expansion, and citations.
- **Under the Hood Rules & Constraints:** A named file must not borrow facts from another
  file. A missing requested filename returns a specific error instead of a broad search.
  Close metadata matches produce a clarification with candidate files. Version families
  prefer an explicit version; otherwise a clearly newest numeric/date marker may win.
  Unresolved conflicts remain separate and must be disclosed.
- **Performance & Quality Impact Matrix:**
  - **TTFT Impact:** Low and often positive because hard scope reduces the candidate set.
  - **Tokens/Sec Impact:** Positive indirectly through a smaller, cleaner prompt.
  - **Response Accuracy Impact:** Very high. This is the primary defense against unrelated
    spreadsheet/customer citations after the user names a document or project.
  - **Overall Impact:** Highly recommended and release-critical.
- **Edge Cases & Failure Recovery:** Ambiguous aliases stop before generation and ask the
  user to choose. A scope is reapplied after neighbor and complete-document expansion so a
  later stage cannot reintroduce excluded files. Regression cases cover named-file isolation,
  hard-negative files, missing files, aliases, and version conflicts.

## Hybrid Retrieval, Confidence, and Neighbor Expansion

- **Technical Mechanism:** Query vectors are generated locally, then LanceDB combines vector
  similarity with full-text search. The default hybrid keyword weight is 0.5. Results are
  deduplicated, metadata-boosted when no hard source scope exists, and optionally expanded
  with adjacent chunks from the same document. Confidence combines lexical overlap, top
  retrieval score, mode-specific thresholds, and exact-file matches.
- **Under the Hood Rules & Constraints:** Hybrid search and enriched metadata are enabled by
  default. Direct and spreadsheet/ambiguous modes can use radius-one neighbor expansion.
  Exact file matches are high confidence, but generation still validates every claim. Low
  confidence stops with a request for a filename, topic, or field rather than invoking the
  model on weak evidence.
- **Performance & Quality Impact Matrix:**
  - **TTFT Impact:** Medium. Query embedding plus vector and FTS search is the baseline RAG
    cost; neighbors and multiple subqueries add local lookups.
  - **Tokens/Sec Impact:** Low indirect effect. Neighbor passages increase context size but
    can prevent expensive repair by restoring surrounding meaning.
  - **Response Accuracy Impact:** High positive. Keyword search captures IDs, prices, and
    names; semantic search captures paraphrases; neighbors recover split explanations.
  - **Overall Impact:** Highly recommended common RAG practice.
- **Edge Cases & Failure Recovery:** No results and low confidence are distinct friendly
  states. Confidence is calibrated by mode, with ambiguous questions requiring stronger
  evidence. Exact filenames bypass score uncertainty but not grounding validation.

## Hierarchical Summaries and Evidence-Aware Context Packing

- **Technical Mechanism:** Sync stores document metadata, document summaries, and section
  summaries. Broad retrieval uses these as a navigation layer, while citations still point
  to raw chunks. Before generation, chunks are deduplicated and ranked using retrieval score,
  term overlap, and exact-file preference. Evidence is balanced by mode, redacted, packed
  to a character budget, and reordered so the strongest passages appear at both prompt
  edges to reduce lost-in-the-middle effects.
- **Under the Hood Rules & Constraints:** Normal questions use at least 8K context. Broad
  document summaries, procedures, cross-document work, and exhaustive spreadsheet tasks
  use 16K. Context budget is derived from context length and a mode-specific fraction, using
  approximately 3.2 characters per token. Evidence coverage checks requested categories
  before generation and instructs the model to mark unsupported categories unavailable.
- **Performance & Quality Impact Matrix:**
  - **TTFT Impact:** Medium for large contexts because Ollama must evaluate more prompt
    tokens before the first generated token.
  - **Tokens/Sec Impact:** Medium negative at 16K or near-full context due to KV-cache and
    unified-memory bandwidth pressure.
  - **Response Accuracy Impact:** High positive for broad synthesis and long documents;
    category coverage and edge placement reduce omission and context-position failures.
  - **Overall Impact:** Highly recommended when adaptive. Forcing 16K for every query is not
    recommended on a 16 GB M1.
- **Edge Cases & Failure Recovery:** Packing stops before the budget after at least one
  chunk. Strong evidence is retained first. Missing requested categories are surfaced in
  the system prompt. If a complete document exceeds budget, mode-specific selection still
  prioritizes major sections rather than silently truncating arbitrary tail content.

## Structured Spreadsheet Execution

- **Technical Mechanism:** XLSX sync creates both text chunks and typed cell records with
  sheet, row, column, header, address, display value, raw value, type, numeric value, unit,
  and formula. Spreadsheet questions retrieve headers with adjacent matching rows.
  Deterministic code can calculate maximum, minimum, total, price, memory, lead time, and
  configuration lists. The model receives a verified result with exact source values and
  calculation method, then explains it.
- **Under the Hood Rules & Constraints:** Named filenames and sheets are hard filters. A
  derived calculation is allowed only when the structured result supplies exact operands
  and method. Cached formula values are used where available; RavnDock does not execute
  Excel formulas. Values and units must be reproduced exactly and are checked after
  generation.
- **Performance & Quality Impact Matrix:**
  - **TTFT Impact:** Medium. Typed-row lookup and deterministic calculation add local work,
    but are usually cheaper than asking the model to reason over many raw table chunks.
  - **Tokens/Sec Impact:** Positive indirectly because compact verified rows replace a much
    larger spreadsheet prompt.
  - **Response Accuracy Impact:** Very high for numerical and exact-field questions. It
    prevents arithmetic hallucination and cross-sheet header/value separation.
  - **Overall Impact:** Highly recommended and required for reliable spreadsheet RAG.
- **Edge Cases & Failure Recovery:** Formula-only cells without saved cached results cannot
  be recomputed locally and must be reported unavailable. Ambiguous duplicate headers or
  units remain separate. Multi-sheet exhaustive requests use 16K only when necessary.

## Improve Document Matching and Claim Verification

- **Technical Mechanism:** When enabled, the sidecar loads the local
  `BAAI/bge-reranker-v2-m3` cross-encoder and reranks at most 24 hybrid candidates for broad
  or ambiguous requests. It can also score up to 12 generated claim-to-passage checks during
  post-generation verification. Model files are revision-pinned, hash-verified, cached
  locally, and released after use.
- **Under the Hood Rules & Constraints:** The feature is opt-in and requires a one-time
  approximately 2.3 GB download. It is skipped for direct lookup, exact sheet scope, and
  Use complete documents. Broad summaries within a hard file scope may still rerank passages
  inside that file. Deterministic lexical and numeric validators remain authoritative if
  the optional reranker is unavailable.
- **Performance & Quality Impact Matrix:**
  - **TTFT Impact:** High on first/cold use. A recent local verification measured about
    4.33 seconds to rerank 24 passages on the development Mac; warm results vary and must
    be benchmarked per release.
  - **Tokens/Sec Impact:** No direct generation effect when the reranker is released first;
    possible indirect thermal/memory effect during repeated heavy requests.
  - **Response Accuracy Impact:** Medium/high for ambiguous semantic matches and claim-level
    support. Little value for exact filename/direct fact lookup, where deterministic scope
    and keyword matching are stronger and faster.
  - **Overall Impact:** Recommended for ambiguous or broad semantic questions, not as a
    universal default on minimum hardware.
- **Edge Cases & Failure Recovery:** Download failure leaves the setting unprepared and
  shows a retryable local message. Once cached, it works offline. If inference fails, search
  continues without reranking. Full-context mode intentionally wins when both options are
  enabled, avoiding duplicate high-memory ranking work.

## Use Complete Documents

- **Technical Mechanism:** Full-context mode identifies top matched documents, expands them
  to their active complete chunk sets, preserves file/sheet scope, and applies the final
  context budget. It is most useful for a few short documents, procedures, and synthesis
  that depends on globally distributed sections.
- **Under the Hood Rules & Constraints:** Complete-document expansion does not mean unlimited
  prompt size. Final selection is still capped by context packing and adaptive 8K/16K
  inference. The option skips the reranker. Hard source and sheet filters remain in force.
- **Performance & Quality Impact Matrix:**
  - **TTFT Impact:** High for longer documents because prompt evaluation grows substantially.
  - **Tokens/Sec Impact:** Medium/high negative when the context approaches 16K, especially
    on 16 GB unified memory.
  - **Response Accuracy Impact:** Positive for short coherent documents and procedures;
    potentially negative when irrelevant sections crowd out the exact answer.
  - **Overall Impact:** Recommended only for a few short documents or an explicitly broad
    task. Not recommended as a universal default.
- **Edge Cases & Failure Recovery:** Large matched documents are still truncated by evidence
  packing. The UI description warns about context use. If both complete documents and
  reranking are enabled, the reranker is skipped rather than loading both expensive paths.

## Ollama Generation and Live Token Streaming

- **Technical Mechanism:** After retrieval and prompt assembly, RavnDock activates the
  selected model and calls Ollama `/api/chat` with `stream: true` and `think: false`. JSON
  updates are decoded incrementally and forwarded immediately to the renderer. Metrics use
  Ollama's evaluation count and duration for tokens/sec and inter-token latency, plus local
  clocks for TTFT and end-to-end duration.
- **Under the Hood Rules & Constraints:** Defaults are temperature 0.2, top-p 0.9, 1,024
  requested output tokens, and 8K context. Adaptive workflows can use 16K. The total answer
  is capped at 2,048 generated tokens. If Ollama reports a length stop, RavnDock may issue up
  to two bounded continuation calls using an exact-continue instruction. The user can abort
  through AbortSignal.
- **Performance & Quality Impact Matrix:**
  - **TTFT Impact:** Dominated by cold model load, prompt evaluation, context size, and all
    earlier retrieval/reranking work. Streaming minimizes perceived latency once generation
    begins but does not change raw TTFT.
  - **Tokens/Sec Impact:** Dominated by model size, quantization, context/KV cache, memory
    bandwidth, thermal state, and swap. 2B should be fastest; 4B is the default balance;
    9B is most demanding.
  - **Response Accuracy Impact:** Low temperature and hidden-thinking suppression favor
    concise, reproducible grounded answers. Continuation reduces mid-sentence truncation.
  - **Overall Impact:** Highly recommended. Streaming is essential for acceptable local-AI
    perceived performance.
- **Edge Cases & Failure Recovery:** Empty or failed Ollama responses become friendly chat
  errors. Abort stops the reader. Length continuation is bounded to prevent loops and is
  disabled for calls that explicitly do not permit it. A model that is too large may cause
  severe TTFT, swap, or system pressure despite successful loading.

## Grounding Prompt, Citations, Redaction, and Validation

- **Technical Mechanism:** The system prompt supplies numbered local passages with title,
  knowledge base, file, location, section, and content. It requires direct answers, concise
  Markdown, exact numbers/units, factual citations, source separation, explicit unavailable
  fields, and complete endings. After streaming, RavnDock normalizes text, rejects malformed
  table and HTML artifacts, preserves valid Markdown tables, redacts credential-like fields,
  attaches citations from actual provenance, collapses repeated consecutive citations, and
  runs deterministic validators. Table rows are validated independently and missing supported
  citations are inserted inside the final table cell so rendering remains intact.
- **Under the Hood Rules & Constraints:** Every requested category must be answered or marked
  unavailable. Factual paragraphs need passage support. Unsupported inference is not fact.
  Passwords, secrets, private keys, and access tokens are replaced with `[REDACTED]`. General
  knowledge/opinion is forbidden unless the user explicitly asks for interpretation; then
  the answer must separate cited **From your files** content from uncited **Model
  interpretation (not from your files)** content. Answers default to under 450 words and six
  sections.
- **Performance & Quality Impact Matrix:**
  - **TTFT Impact:** System-prompt size and source formatting add prompt-evaluation latency.
    Deterministic postchecks happen after streaming and therefore do not delay first token.
  - **Tokens/Sec Impact:** Slight indirect negative from the longer instruction/context
    prompt, but no change to model evaluation mechanics.
  - **Response Accuracy Impact:** Very high. Provenance-owned citations, numerical checks,
    redaction, and interpretation separation are the final defenses against hallucination,
    misattribution, and secret exposure.
  - **Overall Impact:** Highly recommended and release-critical.
- **Edge Cases & Failure Recovery:** Citation numbering is rebuilt from selected evidence,
  not trusted from model prose. Unsupported generated blocks are removed or marked. If no
  trustworthy prose survives, a citation-safe fallback lists relevant local sections without
  inventing their meaning.

## Post-Generation Repair and Verified-Content Retention

- **Technical Mechanism:** When validation finds issues, the UI first shows “Checking
  sources…”. RavnDock extracts a verified draft when possible and asks the same selected
  model, at temperature 0 and top-p no greater than 0.8, to repair only missing or unsupported
  content. Repair output is normalized and validated again. The final renderer content is
  replaced only when postchecking changed the streamed draft.
- **Under the Hood Rules & Constraints:** Targeted repair uses 256 tokens for ordinary
  requests or 384 for broad requests; a full repair is capped at 512 or 768 respectively.
  Semantic claim verification is optional and bounded. If repair still fails, verified
  content is retained and the unsupported remainder is explicitly unavailable. The system
  must not discard correct sections merely because one claim failed. Verified headings,
  lists, and valid Markdown tables are retained without flattening or restyling; only malformed
  pipe output is repaired.
- **Performance & Quality Impact Matrix:**
  - **TTFT Impact:** None for the first draft because repair occurs after streaming begins.
  - **Tokens/Sec Impact:** The displayed model throughput is aggregated across generation
    and any repair. Repair consumes additional inference time and energy.
  - **Response Accuracy Impact:** High positive. It prevents a polished but unsupported draft
    from being accepted and preserves valid content instead of replacing everything with a
    generic failure.
  - **Overall Impact:** Recommended best practice for high-trust RAG, with targeted bounds to
    control latency.
- **Edge Cases & Failure Recovery:** The user may briefly see a draft before it is replaced;
  a notice explains that sources changed the answer. If the repair call fails or remains
  unsupported, verified sections plus an unavailable-details statement are returned. This
  stage explains the pause after token streaming completes.

## Verified Response Cache

- **Technical Mechanism:** Issue-free, non-interpretive answers are cached locally. The key
  hashes the normalized question, selected model, knowledge-base IDs, context length,
  conversation, policy, and SHA-256 of every exact selected passage. The cache stores answer,
  citations, metrics, and timestamp in an atomic JSON file.
- **Under the Hood Rules & Constraints:** Maximum 100 entries, maximum age 30 days, file mode
  `0600`. Subjective interpretation is never cached. Any source text, chunk selection, model,
  knowledge base, conversation, context, or relevant policy change produces a different key.
- **Performance & Quality Impact Matrix:**
  - **TTFT Impact:** Very low on a hit after retrieval and key construction; the cached answer
    is emitted immediately as one content event.
  - **Tokens/Sec Impact:** Not applicable on a hit because no generation occurs. Cached metrics
    are marked `cached` and must not be interpreted as a new model run.
  - **Response Accuracy Impact:** Neutral/positive because only fully validated responses are
    stored and exact evidence fingerprints prevent stale reuse after source changes.
  - **Overall Impact:** Highly recommended for repeated local questions.
- **Edge Cases & Failure Recovery:** Corrupt, missing, or incompatible cache data is ignored.
  Writes use a temporary file and rename. Cache write failure never fails the chat response.

## Attachments, Model-Only Chat, and Prompt Improvement

- **Technical Mechanism:** Chat can operate with selected knowledge bases, model-only mode,
  or directly attached supported files. Attachments are parsed by the sidecar and inserted
  into the same evidence pipeline with attached-file provenance. Model-only chat bypasses
  retrieval and calls Ollama directly. Improve Prompt uses the selected chat model to rewrite
  the user's question without answering it.
- **Under the Hood Rules & Constraints:** Attachment paths come from user file selection and
  have a five-minute extraction timeout. Knowledge-base grounding rules apply whenever file
  evidence exists. Model-only output cannot claim knowledge-base grounding or citations.
  Prompt improvement cannot silently load the 2B helper when the user selected another model;
  preserving one resident model has priority over marginal helper speed.
- **Performance & Quality Impact Matrix:**
  - **TTFT Impact:** Attachments add parse latency on each use because they are not necessarily
    pre-indexed. Model-only chat is fastest. Prompt improvement adds a separate generation
    step before the final chat request.
  - **Tokens/Sec Impact:** Uses the selected model's normal throughput. Avoiding a second model
    protects unified-memory headroom.
  - **Response Accuracy Impact:** Attachments enable ad hoc grounded answers. Prompt improvement
    can increase retrieval specificity but may distort intent, so users explicitly accept or
    reject it.
  - **Overall Impact:** Recommended as optional user-controlled workflows.
- **Edge Cases & Failure Recovery:** Unsupported/corrupt attachments fail without changing a
  knowledge base. The original prompt remains available if improvement is rejected or fails.
  Model-only mode remains usable offline whenever the selected Ollama model is installed.

## Deterministic File Inventory

- **Technical Mechanism:** Questions such as “What documents do you have?” bypass embeddings,
  LanceDB, and Ollama. Electron reads the synchronized manifests for the selected knowledge
  bases and renders the filenames grouped by knowledge-base name.
- **Under the Hood Rules & Constraints:** Only successfully synchronized manifest entries are
  listed. No model is allowed to infer, rename, summarize, or omit files. An unsynchronized
  knowledge base is shown as having no available files.
- **Performance & Quality Impact Matrix:**
  - **TTFT Impact:** Very low; the UI receives deterministic local data with a reported zero
    model TTFT.
  - **Tokens/Sec Impact:** Not applicable because no generation runs.
  - **Response Accuracy Impact:** Very high for inventory questions because the result is the
    authoritative sync state rather than retrieval output.
  - **Overall Impact:** Highly recommended task-specific handling.
- **Edge Cases & Failure Recovery:** Files moved after the last sync remain in the manifest
  until the next sync; citation opening detects this and asks the user to sync. Empty manifests
  return an explicit no-files message.

## Live System Health Monitor

- **Technical Mechanism:** Every two seconds, the renderer requests a resource snapshot and
  retains 30 points, representing approximately one minute. Electron main measures system CPU
  from deltas of `os.cpus()`, memory pressure using `memory_pressure -Q` with an `os.freemem()`
  fallback, swap usage/rates through `sysctl vm.swapusage` and `vm_stat`, app process
  CPU/memory through `app.getAppMetrics()`, disk capacity through
  `statfs`, GPU availability/utilization through `ioreg` AGX counters, battery temperature
  through `ioreg`, Ollama resident models through `/api/ps`, and persisted per-model response
  performance from settings. The chat view uses the latest 15 points for a compact 30-second
  memory/GPU view.
- **Under the Hood Rules & Constraints:** Overlapping refreshes are suppressed. GPU probing is
  cached for four seconds and individual OS commands time out after two seconds. macOS does
  not expose a reliable per-app GPU percentage, so RavnDock shows total GPU utilization plus
  Electron GPU-process memory and Ollama accelerator allocation separately. Temperature is
  labeled **Battery**, not CPU. Swap remains distinct from memory pressure and is shown as
  capacity plus recent swap-in/swap-out throughput.
- **Performance & Quality Impact Matrix:**
  - **TTFT Impact:** Low, but two-second shell/IPC sampling can add small scheduling noise.
    Refresh de-duplication and GPU caching bound this overhead.
  - **Tokens/Sec Impact:** Usually negligible. Aggressive privileged GPU polling is avoided;
    that would create unnecessary overhead and distribution complexity.
  - **Response Accuracy Impact:** No answer-content effect. It improves operational accuracy
    by showing whether poor model performance correlates with memory, GPU, or thermal pressure.
  - **Overall Impact:** Recommended for visible local health. Swap makes hidden unified-memory
    pressure diagnosable without privileged monitoring tools.
- **Edge Cases & Failure Recovery:** Unsupported GPU counters, disk queries, battery sensors,
  or memory commands return `null`/fallback values while the rest of the dashboard remains
  usable. Errors become a friendly unavailable message. History is bounded to prevent an
  in-session memory leak.

## Model Performance Statistics

- **Technical Mechanism:** After chat, settings aggregate response count, minimum/average/
  maximum TTFT, tokens/sec, inter-token latency, and end-to-end latency by model. Monitor sorts
  model statistics by average tokens/sec and shows plain-language help. Ollama's evaluation
  counters are preferred over estimating tokens from text.
- **Under the Hood Rules & Constraints:** Null metrics are preserved when Ollama does not
  report a counter. Inter-token latency can be derived as `1000 / tokensPerSecond` for legacy
  samples. Cached responses are marked and should not be treated as fresh inference runs.
  Results are device-, temperature-, context-, and workload-specific, not model-wide claims.
- **Performance & Quality Impact Matrix:**
  - **TTFT Impact:** Negligible persistence cost after completion.
  - **Tokens/Sec Impact:** No runtime effect; this is observational instrumentation.
  - **Response Accuracy Impact:** Indirectly positive by helping users choose a model that is
    both capable and usable on their Mac.
  - **Overall Impact:** Recommended. Release evaluation should keep performance and quality
    metrics separate so a faster but less grounded model does not appear universally better.
- **Edge Cases & Failure Recovery:** Older settings are migrated with nullable fields and
  derived ITL. A single outlier can distort min/max, so average plus sample count is the most
  useful everyday display. Clearing local app data resets measurements.

## Failure Handling, Privacy, and Local Recovery

- **Technical Mechanism:** Main-process errors are mapped to stable user-facing failures.
  Sync errors preserve a friendly explanation plus truncated technical detail with local
  user paths redacted. Settings writes are queued, validated, backed up, written to a
  temporary file, and renamed. Source documents are never modified. The renderer receives
  only required data through typed IPC.
- **Under the Hood Rules & Constraints:** No cloud inference, telemetry, advertising, or
  document upload path exists. Network access is limited to localhost runtime traffic and
  explicit dependency/model downloads. Symbolic links are skipped. Retrieved text is placed
  inside a system-owned **LOCAL SOURCES** section and grounding rules prohibit broadening
  beyond those sources. The system prompt explicitly treats retrieved document content as
  untrusted data, ignores role-override or exfiltration instructions, and still permits
  legitimate procedures to be quoted as document content.
- **Performance & Quality Impact Matrix:**
  - **TTFT Impact:** Negligible in the success path. Validation and backups affect settings or
    post-generation latency rather than first token.
  - **Tokens/Sec Impact:** None.
  - **Response Accuracy Impact:** High trust impact. Clear scope, injection-resistant prompt
    boundaries, redaction, and recoverable derived state reduce harmful or misleading output.
  - **Overall Impact:** Highly recommended and mandatory for the local-private value promise.
- **Edge Cases & Failure Recovery:** Derived indexes can be rebuilt from source folders.
  Interrupted sync preserves source files and, during atomic rebuild, the previous active
  generation. Missing local models require an approved download; already installed models
  and indexes remain available offline.

## Regression Dataset and Release Evaluation

- **Technical Mechanism:** `rag-backend/benchmark/regression_cases.json` records failure
  patterns including named-file isolation, hard-negative spreadsheets, missing files,
  source aliases, reranker routing, version conflicts, and document prompt injection. The
  Python release evaluator measures source recall@5, strict file isolation, version resolution,
  citation validity, complete-answer rate, fallback rate, confidence calibration,
  prompt-injection resistance, and labelled claim-verification precision/recall. Unit tests
  cover backend storage/retrieval and application orchestration.
- **Under the Hood Rules & Constraints:** 2B and 4B quality must be evaluated independently;
  a 9B response must not be used as an automatic correctness oracle. Source documents and
  deterministic expected facts remain the benchmark. Performance measurements must label
  cold/warm state, model, context length, reranker state, and hardware.
- **Performance & Quality Impact Matrix:**
  - **TTFT Impact:** None in production. Release testing quantifies whether a change moves
    retrieval, reranking, validation, or generation latency.
  - **Tokens/Sec Impact:** None in production; benchmark runs measure throughput regressions.
  - **Response Accuracy Impact:** Very high. Regression gates prevent a local fix for one
    spreadsheet or citation pattern from breaking another retrieval mode.
  - **Overall Impact:** Highly recommended common practice and required before RAG releases.
- **Edge Cases & Failure Recovery:** Tests must skip unavailable optional models explicitly,
  never silently substitute 9B, and retain machine-readable failures. A failed release gate
  blocks publication but does not change user data or production indexes.

## Current Architectural Limits and Engineering Priorities

1. **Shared local resources:** Query and ingestion use separate IPC workers, but still share
   disk, the index database, and Ollama. Heavy OCR or embedding can reduce throughput even
   though it no longer blocks query dispatch.
2. **Full-context cost:** Complete-document mode still obeys 8K/16K packing and can crowd
   out focused evidence. Keep it opt-in and benchmark by task class.
3. **Reranker latency and benefit:** The stored legacy benchmark reports a 9.21-second cold load
   and median reranker-only latency of 1.78 seconds for one knowledge base and 2.94 seconds for
   multiple knowledge bases. It showed no top-five gain for one knowledge base and a 3.33-point
   regression across multiple knowledge bases. That report predates mandatory hardware labels,
   so it is diagnostic rather than minimum-hardware release evidence. Keep reranking conditional
   and require a labelled 16 GB M1-class rerun before changing its default.
4. **OCR and Office-file bloat:** Large scanned PDFs and complex presentations can hold
   substantial intermediate data. File-size guidance exists; safe cancellation inside one
   extraction still requires a supervised per-file worker boundary.
5. **Cache delivery:** A cache hit emits the complete answer in one event and is explicitly
   labelled **Cached verified answer**. It is not animated as fake live inference, and cached
   turns are excluded from model-speed aggregates.
