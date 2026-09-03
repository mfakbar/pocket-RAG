from __future__ import annotations

import gzip
import hashlib
import json
import os
from pathlib import Path
from typing import Any
from uuid import uuid4

from .documents import DocumentExtractor
from .ollama import OllamaEmbeddingClient
from .reranker import LocalReranker
from .retrieval import (
    AMBIGUOUS,
    CROSS_DOCUMENT,
    DIRECT_LOOKUP,
    DOCUMENT_SUMMARY,
    PROCEDURE_CHECKLIST,
    SPREADSHEET_COMPARISON,
    SUPPORTED_FILE_PATTERN,
    _balance_by_file,
    _broad_query,
    _canonical_scope_text,
    _chunks_for_named_file,
    _chunk_in_scope,
    _confidence_score,
    _cover_major_sections,
    _coverage_key,
    _diversify_by_file,
    _diversify_by_section,
    _exact_spreadsheet_field,
    _exhaustive_query,
    _named_files,
    _normalized_file_reference,
    _requested_file_references,
    _requested_sheet_names,
    _resolve_version_conflicts,
    _result_score,
    _retrieval_mode,
    _search_question,
    _sheet_name,
    _source_scope,
    _spreadsheet_aggregate_query,
    _scope_terms,
    _topic_relevance_score,
    _version_identity,
)
from .store import HybridStore


class RagEngine:
    INDEX_BATCH_SIZE = 24
    ARTIFACT_CACHE_VERSION = 5

    def __init__(
        self,
        data_dir: str,
        ollama_url: str,
        embedding_model: str,
        reranker_model: str = "BAAI/bge-reranker-v2-m3",
    ) -> None:
        self.extractor = DocumentExtractor()
        self.embedder = OllamaEmbeddingClient(ollama_url, embedding_model)
        self.store = HybridStore(data_dir)
        self.reranker = LocalReranker(
            Path(data_dir) / "models" / "reranker", reranker_model
        )
        self.embedding_model = embedding_model
        self.artifact_cache = Path(data_dir) / "artifact-cache"
        self.artifact_cache.mkdir(parents=True, exist_ok=True)

    def close(self) -> None:
        self.store.close()

    def _artifact_cache_path(self, version_id: str, settings: dict[str, Any]) -> Path:
        fingerprint = json.dumps(
            {
                "cacheVersion": self.ARTIFACT_CACHE_VERSION,
                "versionId": version_id,
                "embeddingModel": self.embedding_model,
                "settings": settings,
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        key = hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()
        return self.artifact_cache / f"{key}.json.gz"

    @staticmethod
    def _read_artifact(path: Path) -> dict[str, Any] | None:
        try:
            with gzip.open(path, "rt", encoding="utf-8") as handle:
                payload = json.load(handle)
            if not isinstance(payload, dict) or not isinstance(payload.get("rows"), list):
                return None
            return payload
        except (OSError, ValueError, TypeError):
            path.unlink(missing_ok=True)
            return None

    @staticmethod
    def _write_artifact(path: Path, payload: dict[str, Any]) -> None:
        temporary = path.with_suffix(f"{path.suffix}.{os.getpid()}.tmp")
        try:
            with gzip.open(temporary, "wt", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)

    def health(self, _params: dict[str, Any]) -> dict[str, Any]:
        return self.store.health()

    def warm(self, _params: dict[str, Any]) -> dict[str, bool]:
        self.embedder.embed(["RavenDock local document search"], keep_alive=0)
        return {"ready": True}

    def prepare_reranker(self, _params: dict[str, Any]) -> dict[str, Any]:
        return self.reranker.prepare()

    def reset_index(self, _params: dict[str, Any]) -> dict[str, bool]:
        self.store.reset_index()
        return {"reset": True}

    def begin_rebuild(self, params: dict[str, Any]) -> dict[str, str]:
        knowledge_base_id = str(params.get("knowledgeBaseId") or "default")
        return {"generation": self.store.begin_rebuild(knowledge_base_id)}

    def clone_document(self, params: dict[str, Any]) -> dict[str, bool]:
        cloned = self.store.clone_active_document(
            str(params.get("knowledgeBaseId") or "default"),
            str(params["generation"]),
            str(params["sourceDocumentId"]),
            str(params["targetDocumentId"]),
            str(params["versionId"]),
            str(params["relativePath"]),
        )
        return {"cloned": cloned}

    def prune_generation(self, params: dict[str, Any]) -> dict[str, bool]:
        self.store.prune_generation(
            str(params.get("knowledgeBaseId") or "default"),
            str(params["generation"]),
            [str(value) for value in params.get("documentIds") or []],
        )
        return {"pruned": True}

    def commit_rebuild(self, params: dict[str, Any]) -> dict[str, bool]:
        self.store.finalize()
        self.store.commit_rebuild(
            str(params.get("knowledgeBaseId") or "default"), str(params["generation"])
        )
        return {"committed": True}

    def abort_rebuild(self, params: dict[str, Any]) -> dict[str, bool]:
        self.store.abort_rebuild(
            str(params.get("knowledgeBaseId") or "default"), str(params["generation"])
        )
        return {"aborted": True}

    def index_document(self, params: dict[str, Any]) -> dict[str, Any]:
        knowledge_base_id = str(params.get("knowledgeBaseId") or "default")
        file_path = str(params["filePath"])
        relative_path = str(params["relativePath"])
        document_id = str(params["documentId"])
        version_id = str(params.get("versionId") or uuid4())
        generation = str(
            params.get("generation") or self.store.active_generation(knowledge_base_id)
        )
        settings = dict(params.get("settings") or {})
        if self.store.has_document_version(
            knowledge_base_id, generation, document_id, version_id
        ):
            return {
                "documentId": document_id,
                "versionId": version_id,
                "chunks": 0,
                "spreadsheetCells": 0,
                "reused": True,
            }
        extension = Path(file_path).suffix.lower()
        cache_path = self._artifact_cache_path(version_id, settings)
        artifact = self._read_artifact(cache_path)
        artifact_cache_hit = artifact is not None
        if artifact is None:
            chunks = self.extractor.extract(file_path, relative_path, settings)
            spreadsheet_cells = self.extractor.extract_spreadsheet_cells(file_path)
            document_metadata = self.extractor.document_metadata(relative_path, chunks)
            if not chunks:
                raise RuntimeError("No readable text was found in this document.")
            cached_rows: list[dict[str, Any]] = []
            for offset in range(0, len(chunks), self.INDEX_BATCH_SIZE):
                batch = chunks[offset : offset + self.INDEX_BATCH_SIZE]
                vectors = self.embedder.embed(
                    [chunk.embedding_text for chunk in batch],
                    batch_size=self.INDEX_BATCH_SIZE,
                )
                cached_rows.extend(
                    {
                        "chunk_index": offset + index,
                        "text": chunk.text,
                        "embedding_text": chunk.embedding_text,
                        "location": chunk.location,
                        "heading": chunk.heading,
                        "vector": vector,
                    }
                    for index, (chunk, vector) in enumerate(
                        zip(batch, vectors, strict=True)
                    )
                )
            artifact = {
                "rows": cached_rows,
                "spreadsheetCells": [cell.__dict__ for cell in spreadsheet_cells],
                "documentMetadata": document_metadata,
            }
            self._write_artifact(cache_path, artifact)

        cached_rows = list(artifact.get("rows") or [])
        spreadsheet_cells = list(artifact.get("spreadsheetCells") or [])
        document_metadata = dict(artifact.get("documentMetadata") or {})
        if not cached_rows:
            raise RuntimeError("No readable text was found in this document.")
        self.store.prepare_document_version(
            knowledge_base_id, generation, document_id, version_id
        )
        try:
            for offset in range(0, len(cached_rows), self.INDEX_BATCH_SIZE):
                batch = cached_rows[offset : offset + self.INDEX_BATCH_SIZE]
                rows = [
                    {
                        "id": str(uuid4()),
                        "knowledge_base_id": knowledge_base_id,
                        "generation": generation,
                        "document_id": document_id,
                        "version_id": version_id,
                        "relative_path": relative_path,
                        "file_name": Path(relative_path).name,
                        "extension": extension,
                        "chunk_index": int(chunk["chunk_index"]),
                        "text": str(chunk["text"]),
                        "embedding_text": str(chunk["embedding_text"]),
                        "location": str(chunk["location"]),
                        "heading": str(chunk.get("heading") or ""),
                        "vector": [float(value) for value in chunk["vector"]],
                    }
                    for chunk in batch
                ]
                self.store.append_document_rows(rows)
            self.store.stage_spreadsheet_cells(
                knowledge_base_id,
                generation,
                document_id,
                version_id,
                relative_path,
                spreadsheet_cells,
            )
            self.store.stage_document_metadata(
                knowledge_base_id,
                generation,
                document_id,
                version_id,
                relative_path,
                document_metadata,
            )
            self.store.commit_document_version(
                knowledge_base_id,
                generation,
                document_id,
                version_id,
                relative_path,
            )
        except Exception:
            self.store.abort_document_version(
                knowledge_base_id, generation, document_id, version_id
            )
            raise
        return {
            "documentId": document_id,
            "versionId": version_id,
            "chunks": len(cached_rows),
            "spreadsheetCells": len(spreadsheet_cells),
            "artifactCacheHit": artifact_cache_hit,
        }

    def remove_document(self, params: dict[str, Any]) -> dict[str, bool]:
        self.store.remove_document(
            str(params.get("knowledgeBaseId") or "default"),
            str(params["documentId"]),
            str(params["generation"]) if params.get("generation") else None,
        )
        return {"removed": True}

    def finalize_sync(self, _params: dict[str, Any]) -> dict[str, bool]:
        self.store.finalize()
        self.embedder.unload()
        return {"ready": True}

    def release_embedding(self, _params: dict[str, Any]) -> dict[str, bool]:
        self.embedder.unload()
        return {"released": True}

    def clear(self, params: dict[str, Any]) -> dict[str, bool]:
        knowledge_base_id = params.get("knowledgeBaseId")
        self.store.clear(str(knowledge_base_id) if knowledge_base_id else None)
        return {"cleared": True}

    def extract_attachments(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        settings = dict(params.get("settings") or {})
        file_paths = [str(item) for item in params.get("filePaths") or []][:10]
        chunks: list[dict[str, Any]] = []
        for file_path in file_paths:
            source = Path(file_path)
            if not source.is_file():
                continue
            for chunk in self.extractor.extract(str(source), source.name, settings):
                chunks.append(
                    {
                        "text": chunk.text,
                        "file": source.name,
                        "path": source.name,
                        "location": chunk.location,
                        "heading": chunk.heading,
                        "score": 1.0,
                    }
                )
                if len(chunks) >= 24:
                    return chunks
        return chunks

    def query(self, params: dict[str, Any]) -> dict[str, Any]:
        question = str(params["query"]).strip()
        if not question:
            return {"chunks": [], "metrics": {}}
        settings = dict(params.get("settings") or {})
        knowledge_base_ids = [
            str(item) for item in params.get("knowledgeBaseIds") or ["default"]
        ]
        configured_top_k = max(1, min(20, int(settings.get("topK", 4))))
        available_files = self.store.active_file_names(knowledge_base_ids)
        requested_file_references = _requested_file_references(question)
        catalog_reader = getattr(self.store, "active_source_catalog", None)
        source_catalog = (
            catalog_reader(knowledge_base_ids)
            if callable(catalog_reader)
            else [{"file": file_name, "sheets": []} for file_name in available_files]
        )
        source_scope = _source_scope(question, source_catalog)
        named_files = [str(item) for item in source_scope["files"]]
        scoped_sheets = [str(item) for item in source_scope["sheets"]]
        if requested_file_references and not named_files:
            return {
                "chunks": [],
                "structuredRows": [],
                "hierarchicalSummaries": [],
                "metrics": {
                    "requestedFileNotFound": requested_file_references,
                    "fileFilterApplied": False,
                    "rerankerApplied": False,
                    "confidenceScore": 0.0,
                },
            }
        if source_scope["ambiguous"]:
            return {
                "chunks": [],
                "structuredRows": [],
                "hierarchicalSummaries": [],
                "metrics": {
                    "sourceScope": source_scope,
                    "scopeAmbiguity": source_scope["candidates"],
                    "fileFilterApplied": False,
                    "rerankerApplied": False,
                    "confidenceScore": float(source_scope["confidence"]),
                },
            }
        version_conflicts, excluded_version_files = _resolve_version_conflicts(
            available_files, named_files
        )
        mode = _retrieval_mode(question, named_files)
        exact_field_query = _exact_spreadsheet_field(question)
        aggregate_query = mode == SPREADSHEET_COMPARISON and _spreadsheet_aggregate_query(question)
        broad_query = _broad_query(question) or mode in {
            DOCUMENT_SUMMARY,
            PROCEDURE_CHECKLIST,
            CROSS_DOCUMENT,
        } or aggregate_query
        exhaustive_query = mode == PROCEDURE_CHECKLIST or aggregate_query
        limits = {
            DIRECT_LOOKUP: max(4, min(6, configured_top_k)),
            DOCUMENT_SUMMARY: 24,
            SPREADSHEET_COMPARISON: (
                48 if aggregate_query else max(8, min(12, configured_top_k * 2))
            ),
            PROCEDURE_CHECKLIST: 48,
            CROSS_DOCUMENT: 12,
            AMBIGUOUS: max(4, min(8, configured_top_k)),
        }
        top_k = limits[mode]
        improve = bool(settings.get("improveDocumentMatching", False))
        search_question = _search_question(question, named_files)
        subqueries = [
            str(item).strip()
            for item in params.get("subqueries") or []
            if str(item).strip() and str(item).strip() != search_question
        ][:4]
        expand_named_document = bool(named_files) and (
            mode in {DOCUMENT_SUMMARY, PROCEDURE_CHECKLIST}
            or (mode == SPREADSHEET_COMPARISON and aggregate_query)
        )
        if expand_named_document and mode == SPREADSHEET_COMPARISON:
            subqueries = []
        search_queries = [search_question, *subqueries]
        vectors = self.embedder.embed(search_queries, keep_alive=0)
        candidate_groups: list[list[dict[str, Any]]] = []
        for candidate_query, vector in zip(search_queries, vectors, strict=True):
            candidate_chunks = self.store.query(
                candidate_query,
                vector,
                top_k,
                max(24, top_k * 6),
                bool(settings.get("hybridSearch", True)),
                float(settings.get("hybridKeywordWeight", 0.5)),
                bool(settings.get("fullContext", False)) or expand_named_document,
                knowledge_base_ids,
                named_files,
                scoped_sheets,
            )
            candidate_groups.append(sorted(candidate_chunks, key=_result_score, reverse=True))
        chunks: list[dict[str, Any]] = []
        seen: set[str] = set()
        max_group = max((len(group) for group in candidate_groups), default=0)
        for offset in range(max_group):
            for group in candidate_groups:
                if offset >= len(group):
                    continue
                chunk = group[offset]
                identifier = str(chunk.get("id") or "") or ":".join(
                    [
                        str(chunk.get("knowledge_base_id") or ""),
                        str(chunk.get("document_id") or ""),
                        str(chunk.get("file_name") or ""),
                        str(chunk.get("location") or ""),
                        str(chunk.get("chunk_index") or 0),
                        str(chunk.get("text") or "")[:80],
                    ]
                )
                if identifier in seen:
                    continue
                seen.add(identifier)
                chunks.append(chunk)
        if named_files or scoped_sheets:
            chunks = [
                chunk for chunk in chunks if _chunk_in_scope(chunk, named_files, scoped_sheets)
            ]
        elif excluded_version_files:
            chunks = [
                chunk
                for chunk in chunks
                if str(chunk.get("file_name") or "").casefold()
                not in excluded_version_files
            ]
        for chunk in chunks:
            topic_score = _topic_relevance_score(search_question, chunk)
            if topic_score > 0:
                chunk["_relevance_score"] = _result_score(chunk) + topic_score
        chunks.sort(key=_result_score, reverse=True)
        file_filter_applied = bool(named_files)
        metrics: dict[str, Any] = {
            "rerankerApplied": False,
            "rerankLatencyMs": 0.0,
            "fileFilterApplied": file_filter_applied,
        }
        metadata_reader = getattr(self.store, "metadata_matching_files", None)
        metadata_matches = (
            metadata_reader(knowledge_base_ids, question, 8)
            if not named_files and callable(metadata_reader)
            else []
        )
        metadata_scores = {
            (str(item["knowledgeBaseId"]), str(item["file"])): int(item["score"])
            for item in metadata_matches
        }
        if metadata_scores:
            for chunk in chunks:
                score = metadata_scores.get(
                    (str(chunk.get("knowledge_base_id") or ""), str(chunk.get("file_name") or "")),
                    0,
                )
                if score > 0:
                    chunk["_relevance_score"] = _result_score(chunk) + min(0.12, score * 0.02)
            chunks.sort(key=_result_score, reverse=True)
        metrics["metadataMatchedFiles"] = [str(item["file"]) for item in metadata_matches]
        should_rerank = (
            improve
            and mode != DIRECT_LOOKUP
            and not bool(settings.get("fullContext", False))
            and not bool(scoped_sheets)
        )
        if should_rerank:
            rerank_limit = min(len(chunks), max(24, top_k * 2)) if broad_query else top_k
            chunks, metrics = self.reranker.rerank(search_question, chunks, rerank_limit)
            metrics["fileFilterApplied"] = file_filter_applied
        if mode == DIRECT_LOOKUP:
            chunks = chunks[:top_k]
        elif mode == DOCUMENT_SUMMARY:
            major_groups = len({_coverage_key(chunk) for chunk in chunks})
            chunks = _cover_major_sections(chunks, min(64, max(top_k, major_groups)))
        elif mode == SPREADSHEET_COMPARISON:
            requested_sheets = scoped_sheets or _requested_sheet_names(question, chunks)
            if requested_sheets:
                requested = {name.casefold() for name in requested_sheets}
                chunks = [
                    chunk for chunk in chunks if _sheet_name(chunk).casefold() in requested
                ]
            else:
                chunks = _cover_major_sections(chunks, top_k)
        elif mode == PROCEDURE_CHECKLIST:
            if not expand_named_document:
                chunks = chunks[:top_k]
        elif mode == CROSS_DOCUMENT:
            chunks = _balance_by_file(chunks, top_k)
        else:
            chunks = chunks[:top_k]
        expand_neighbors = getattr(self.store, "expand_neighbors", None)
        if callable(expand_neighbors) and chunks and not expand_named_document and mode in {
            DIRECT_LOOKUP,
            SPREADSHEET_COMPARISON,
            AMBIGUOUS,
        }:
            neighbor_limit = {
                DIRECT_LOOKUP: 8,
                SPREADSHEET_COMPARISON: min(24, max(12, top_k + 4)),
                AMBIGUOUS: 8,
            }[mode]
            chunks = expand_neighbors(chunks, radius=1, limit=neighbor_limit)
            if named_files or scoped_sheets:
                chunks = [
                    chunk
                    for chunk in chunks
                    if _chunk_in_scope(chunk, named_files, scoped_sheets)
                ]
        metrics["dynamicTopK"] = top_k
        metrics["broadQuery"] = broad_query
        metrics["exhaustiveQuery"] = exhaustive_query
        metrics["namedFiles"] = named_files
        metrics["sourceScope"] = source_scope
        metrics["requestedFileReferences"] = requested_file_references
        metrics["versionConflicts"] = version_conflicts
        metrics["retrievalMode"] = mode
        metrics["requestedSheets"] = scoped_sheets or (
            _requested_sheet_names(question, chunks)
            if mode == SPREADSHEET_COMPARISON
            else []
        )
        metrics["selectedPassages"] = len(chunks)
        metrics["exactFieldQuery"] = exact_field_query
        metrics["aggregateQuery"] = aggregate_query
        metrics["subqueryCount"] = len(subqueries)
        metrics["topScore"] = max((_result_score(chunk) for chunk in chunks), default=0.0)
        metrics["confidenceScore"] = _confidence_score(question, chunks, named_files)
        structured_rows_reader = getattr(self.store, "structured_rows", None)
        structured_rows = (
            structured_rows_reader(
                knowledge_base_ids,
                question,
                named_files,
                scoped_sheets,
                320 if aggregate_query else 160,
            )
            if mode == SPREADSHEET_COMPARISON and callable(structured_rows_reader)
            else []
        )
        if excluded_version_files:
            structured_rows = [
                row
                for row in structured_rows
                if str(row.get("file") or "").casefold() not in excluded_version_files
            ]
        summary_reader = getattr(self.store, "hierarchical_summaries", None)
        summaries = (
            summary_reader(
                knowledge_base_ids,
                question,
                named_files,
                scoped_sheets,
                16 if mode in {DOCUMENT_SUMMARY, PROCEDURE_CHECKLIST, CROSS_DOCUMENT} else 8,
            )
            if callable(summary_reader)
            else []
        )
        if excluded_version_files:
            summaries = [
                summary
                for summary in summaries
                if str(summary.get("file") or "").casefold() not in excluded_version_files
            ]
        unload_reranker = getattr(self.reranker, "unload", None)
        if metrics.get("rerankerApplied") and callable(unload_reranker):
            unload_reranker()
        return {
            "chunks": [
                {
                    "text": str(chunk["text"]),
                    "file": str(chunk["file_name"]),
                    "path": str(chunk["relative_path"]),
                    "location": str(chunk["location"]),
                    "heading": str(chunk.get("heading") or ""),
                    "knowledgeBaseId": str(chunk["knowledge_base_id"]),
                    "documentId": str(chunk.get("document_id") or ""),
                    "chunkIndex": int(chunk.get("chunk_index") or 0),
                    "score": _result_score(chunk),
                }
                for chunk in chunks
            ],
            "structuredRows": structured_rows,
            "hierarchicalSummaries": summaries,
            "metrics": metrics,
        }

    def verify_claims(self, params: dict[str, Any]) -> dict[str, Any]:
        checks = list(params.get("checks") or [])[:16]
        results: list[dict[str, Any]] = []
        applied = False
        latency = 0.0
        for check in checks:
            claim = str(check.get("claim") or "").strip()
            passages = [str(item).strip() for item in check.get("passages") or [] if str(item).strip()]
            if not claim or not passages:
                results.append({"id": check.get("id"), "supported": False, "score": None})
                continue
            candidates = [
                {"id": str(index), "text": passage, "file_name": "", "heading": ""}
                for index, passage in enumerate(passages)
            ]
            ranked, metrics = self.reranker.rerank(claim, candidates, len(candidates))
            score = max((float(item.get("_reranker_score") or 0.0) for item in ranked), default=0.0)
            applied = applied or bool(metrics.get("rerankerApplied"))
            latency += float(metrics.get("rerankLatencyMs") or 0.0)
            results.append(
                {
                    "id": check.get("id"),
                    "supported": score >= 0.5 if metrics.get("rerankerApplied") else None,
                    "score": score if metrics.get("rerankerApplied") else None,
                }
            )
        unload_reranker = getattr(self.reranker, "unload", None)
        if applied and callable(unload_reranker):
            unload_reranker()
        return {
            "results": results,
            "rerankerApplied": applied,
            "latencyMs": round(latency, 2),
        }
