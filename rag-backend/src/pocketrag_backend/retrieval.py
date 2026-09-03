from __future__ import annotations

import math
from pathlib import Path
import re
from typing import Any
import unicodedata


DIRECT_LOOKUP = "direct_lookup"
DOCUMENT_SUMMARY = "document_summary"
SPREADSHEET_COMPARISON = "spreadsheet_comparison"
PROCEDURE_CHECKLIST = "procedure_checklist"
CROSS_DOCUMENT = "cross_document"
AMBIGUOUS = "ambiguous"

SUPPORTED_FILE_PATTERN = r"(?:pdf|docx|pptx|xlsx|xls|csv|txt|md|markdown)"

_SCOPE_ALIASES = {
    "configs": "configuration",
    "config": "configuration",
    "mgmt": "management",
    "spec": "specification",
    "specs": "specification",
    "spek": "specification",
}
_SCOPE_STOP_WORDS = {
    "a", "an", "and", "are", "at", "by", "document", "documents", "file", "files",
    "for", "from", "in", "is", "of", "on", "please", "server", "sheet", "summarize",
    "summary", "the", "that", "to", "what", "which", "with", "workbook",
}
_GENERIC_FILE_TERMS = {
    "ai", "bill", "boq", "edit", "material", "materials", "option", "options", "server",
    "update", "updated", "use", "uses", "with",
}
_TOPIC_STOP_WORDS = _SCOPE_STOP_WORDS | {
    "aci", "best", "cisco", "dc", "design", "implement", "implementing",
    "implementation", "network", "practice", "practices", "refer", "reference",
    "sdn", "service",
}


def _result_score(chunk: dict[str, Any]) -> float:
    reranker = chunk.get("_reranker_score")
    if reranker is not None:
        return float(reranker)
    relevance = chunk.get("_relevance_score")
    if relevance is not None:
        return float(relevance)
    distance = chunk.get("_distance")
    return 1.0 - float(distance) if distance is not None else 0.0


def _topic_relevance_score(question: str, chunk: dict[str, Any]) -> float:
    """Prefer exact section titles and topic phrases before truncating candidates."""
    question_tokens = [
        token
        for token in re.findall(r"[a-z0-9]+", question.casefold())
        if len(token) >= 3 and token not in _TOPIC_STOP_WORDS
    ]
    if not question_tokens:
        return 0.0
    heading = re.sub(r"\s+", " ", str(chunk.get("heading") or "").casefold())
    text = re.sub(r"\s+", " ", str(chunk.get("text") or "").casefold())
    heading_terms = set(re.findall(r"[a-z0-9]+", heading))
    heading_overlap = sum(token in heading_terms for token in question_tokens)
    phrases = [
        f"{question_tokens[index]} {question_tokens[index + 1]}"
        for index in range(len(question_tokens) - 1)
    ]
    phrase_matches = sum(phrase in f"{heading} {text}" for phrase in phrases)
    text_terms = set(re.findall(r"[a-z0-9]+", text))
    text_overlap = sum(token in text_terms for token in question_tokens)
    return min(0.6, heading_overlap * 0.12 + phrase_matches * 0.08 + text_overlap * 0.01)


def _confidence_score(
    question: str, chunks: list[dict[str, Any]], named_files: list[str]
) -> float:
    if not chunks:
        return 0.0
    stop = {"and", "are", "for", "from", "the", "this", "what", "which", "with"}
    query_terms = {
        term
        for term in re.findall(r"[a-z0-9._/-]{3,}", question.casefold())
        if term not in stop
    }
    overlap = 0.0
    if query_terms:
        overlap = max(
            sum(
                1
                for term in query_terms
                if term
                in " ".join(
                    [
                        str(chunk.get("file_name") or ""),
                        str(chunk.get("heading") or ""),
                        str(chunk.get("location") or ""),
                        str(chunk.get("text") or ""),
                    ]
                ).casefold()
            )
            / len(query_terms)
            for chunk in chunks
        )
    raw = max((_result_score(chunk) for chunk in chunks), default=0.0)
    normalized_score = (
        raw
        if 0.0 <= raw <= 1.0
        else 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, raw))))
    )
    confidence = max(0.0, min(1.0, overlap * 0.55 + normalized_score * 0.45))
    if named_files:
        # Matching the requested file proves source scope, not answer completeness.
        confidence = min(0.9, max(0.75, confidence))
    return round(confidence, 4)


def _chunks_for_named_file(question: str, chunks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized_question = question.casefold()
    matches = [
        chunk
        for chunk in chunks
        if str(chunk.get("file_name") or "").casefold() in normalized_question
    ]
    return matches or chunks


def _broad_query(question: str) -> bool:
    explicit_scope = bool(
        re.search(
            r"\b(?:all|compare|executive summary|meeting brief|overview|summari[sz]e|"
            r"timeline|action plan|key (?:facts|numbers|points)|risks? and gaps?|benefits|business outcomes|"
            r"(?:most important|important|key) risks?|"
            r"list each|list the important|checklist|procedure|grouped by|main (?:use cases|"
            r"benefits|risks|differentiators)|customer outcomes|what design best practices|"
            r"software stacks?)\b|\btop\s+\d+\b|\b(?:unique|competitive)\b.*\bdifferentiators?\b",
            question,
            re.IGNORECASE,
        )
    )
    multi_field_request = bool(
        re.search(
            r"\b(?:identify|list|extract|summari[sz]e|compare)\b.*\b(?:quantit(?:y|ies)|"
            r"prices?|totals?|figures?|measurements?|architecture|operations?|differentiators?)\b",
            question,
            re.IGNORECASE,
        )
    )
    broad_differentiators = bool(
        re.search(r"\bmain\b.*\bdifferentiators?\b", question, re.IGNORECASE)
    )
    return explicit_scope or multi_field_request or broad_differentiators


def _exhaustive_query(question: str) -> bool:
    return bool(
        re.search(
            r"\b(?:all|list each|list the important|checklist|procedure|grouped by|extract|"
            r"quantit(?:y|ies)|prices? or totals?|important (?:numbers|figures|measurements)|"
            r"software stacks?)\b|\btop\s+\d+\b",
            question,
            re.IGNORECASE,
        )
    )


def _retrieval_mode(question: str, named_files: list[str]) -> str:
    normalized = question.casefold()
    if len(named_files) > 1 or re.search(
        r"\b(?:across|between)\s+(?:the\s+)?(?:files|documents|presentations|spreadsheets)\b|"
        r"\bcross[- ]document\b|\bcompare\b.*\b(?:files|documents)\b",
        normalized,
    ):
        return CROSS_DOCUMENT
    if (
        re.search(
            r"\b(?:spreadsheet|workbook|worksheet|sheet|cell|rows?|columns?)\b|"
            r"\.(?:xlsx|xls|csv)\b",
            normalized,
        )
        or _exact_spreadsheet_field(question)
    ) and re.search(
        r"\b(?:compare|comparison|list|extract|quantit(?:y|ies)|prices?|costs?|totals?|"
        r"lead times?|configurations?|options?|memory|part numbers?|maximum|minimum|longest|"
        r"highest|lowest|sizing|targets?|gpus?|use cases?)\b",
        normalized,
    ):
        return SPREADSHEET_COMPARISON
    if re.search(
        r"\b(?:summari[sz]e|summary|overview|executive brief|meeting brief|what (?:is|are) "
        r"(?:this|the) (?:file|document|presentation) about)\b",
        normalized,
    ):
        return DOCUMENT_SUMMARY
    if re.search(
        r"\bsoftware stacks?\b|\btop\s+\d+\b|"
        r"\b(?:unique|main|key|competitive)\b.*\bdifferentiators?\b|"
        r"\b(?:benefits|business outcomes|customer outcomes)\b",
        normalized,
    ):
        # Inventories and ranked/curated lists need document-wide coverage. Treating
        # them as direct lookups only retrieves the first matching slide or page.
        return DOCUMENT_SUMMARY
    if re.search(
        r"\b(?:procedure|checklist|steps?|step[- ]by[- ]step|workflow|runbook|how (?:do|to)|"
        r"sequence|provisioning process)\b",
        normalized,
    ):
        return PROCEDURE_CHECKLIST
    if named_files or (
        not _broad_query(question)
        and re.search(
            r"^(?:what|which|who|when|where|how (?:much|many))\b|"
            r"\b(?:find|state|listed|exact|specific|according to)\b",
            normalized,
        )
    ):
        return DIRECT_LOOKUP
    return AMBIGUOUS


def _exact_spreadsheet_field(question: str) -> bool:
    return bool(
        re.search(
            r"\b(?:unit prices?|prices?|costs?|totals?|lead times?|memory(?: configuration)?|"
            r"quantit(?:y|ies)|part numbers?|configurations?|server names?|skus?|pids?)\b",
            question,
            re.IGNORECASE,
        )
    )


def _spreadsheet_aggregate_query(question: str) -> bool:
    return bool(
        re.search(
            r"\b(?:maximum|max|min(?:imum)?|highest|lowest|longest|shortest|total|sum|"
            r"average|all|each|every|compare|comparison|list)\b",
            question,
            re.IGNORECASE,
        )
    )


def _normalized_file_reference(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return re.sub(r"[^a-z0-9]+", "", normalized)


def _canonical_scope_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    normalized = re.sub(r"\bbill\s+of\s+(?:materials?|quantit(?:y|ies))\b", " boq ", normalized)
    normalized = re.sub(r"(?<=\d)(?=[a-z])|(?<=[a-z])(?=\d)", " ", normalized)
    tokens = re.findall(r"[a-z0-9]+", normalized)
    return " ".join(_SCOPE_ALIASES.get(token, token) for token in tokens)


def _scope_terms(value: str) -> set[str]:
    return {
        term
        for term in _canonical_scope_text(value).split()
        if len(term) >= 2 and term not in _SCOPE_STOP_WORDS
    }


def _source_scope(
    question: str,
    catalog: list[dict[str, Any]],
) -> dict[str, Any]:
    """Resolve an explicit or uniquely implied document boundary before retrieval."""
    file_names = [str(item.get("file") or "") for item in catalog]
    explicit_files = _named_files(question, file_names)
    if explicit_files:
        selected_catalog = [
            item for item in catalog if str(item.get("file") or "").casefold() in {
                name.casefold() for name in explicit_files
            }
        ]
        sheets = _resolved_sheets(question, selected_catalog)
        return {
            "files": explicit_files,
            "sheets": sheets,
            "reason": "explicit_filename",
            "confidence": 1.0,
            "explicit": True,
            "ambiguous": False,
            "candidates": [],
        }

    compact_question = _normalized_file_reference(question)
    stem_matches = [
        file_name
        for file_name in file_names
        if len(_normalized_file_reference(Path(file_name).stem)) >= 8
        and _normalized_file_reference(Path(file_name).stem) in compact_question
    ]
    if stem_matches:
        selected_catalog = [
            item for item in catalog if str(item.get("file") or "").casefold() in {
                name.casefold() for name in stem_matches
            }
        ]
        return {
            "files": stem_matches,
            "sheets": _resolved_sheets(question, selected_catalog),
            "reason": "explicit_filename",
            "confidence": 0.99,
            "explicit": True,
            "ambiguous": False,
            "candidates": [],
        }

    question_terms = _scope_terms(question)
    canonical_question = _canonical_scope_text(question)
    scored: list[dict[str, Any]] = []
    for item in catalog:
        file_name = str(item.get("file") or "")
        file_terms = _scope_terms(Path(file_name).stem)
        metadata_terms = _scope_terms(
            " ".join(
                str(item.get(field) or "")
                for field in ("title", "pathSegments", "headings", "entities")
            )
        )
        file_overlap = question_terms & file_terms
        rare_overlap = file_overlap - _GENERIC_FILE_TERMS
        best_sheet = ""
        best_sheet_score = 0
        exact_sheet = False
        for sheet in item.get("sheets") or []:
            canonical_sheet = _canonical_scope_text(str(sheet))
            sheet_terms = _scope_terms(str(sheet))
            overlap = question_terms & sheet_terms
            sheet_exact = bool(sheet_terms) and (
                (len(sheet_terms) >= 2 and canonical_sheet in canonical_question)
                or bool(
                    re.search(
                        rf"\bsheet\s+{re.escape(canonical_sheet)}\b",
                        canonical_question,
                    )
                )
            )
            score = len(overlap) * 3 + (6 if sheet_exact else 0)
            if score > best_sheet_score:
                best_sheet = str(sheet)
                best_sheet_score = score
                exact_sheet = sheet_exact
        score = (
            len(file_overlap) * 2
            + len(rare_overlap) * 3
            + len(question_terms & metadata_terms)
            + best_sheet_score
        )
        if score > 0:
            scored.append(
                {
                    "file": file_name,
                    "score": score,
                    "sheet": best_sheet if (exact_sheet or best_sheet_score >= 6) else "",
                    "exactSheet": exact_sheet,
                }
            )
    scored.sort(key=lambda item: (-int(item["score"]), str(item["file"]).casefold()))
    if not scored or int(scored[0]["score"]) < 6:
        return {
            "files": [], "sheets": [], "reason": "unresolved", "confidence": 0.0,
            "explicit": False, "ambiguous": False, "candidates": [],
        }
    top = scored[0]
    second_score = int(scored[1]["score"]) if len(scored) > 1 else 0
    close = [item for item in scored if int(top["score"]) - int(item["score"]) < 4]
    if len(close) > 1:
        return {
            "files": [],
            "sheets": [],
            "reason": "ambiguous_metadata",
            "confidence": round(int(top["score"]) / max(1, int(top["score"]) + second_score), 3),
            "explicit": False,
            "ambiguous": True,
            "candidates": [
                {"file": str(item["file"]), "sheet": str(item["sheet"] or "")}
                for item in close[:5]
            ],
        }
    return {
        "files": [str(top["file"])],
        "sheets": [str(top["sheet"])] if top["sheet"] else [],
        "reason": "unique_sheet" if top["sheet"] else "unique_metadata",
        "confidence": round(int(top["score"]) / max(1, int(top["score"]) + second_score), 3),
        "explicit": False,
        "ambiguous": False,
        "candidates": [],
    }


def _resolved_sheets(question: str, catalog: list[dict[str, Any]]) -> list[str]:
    canonical_question = _canonical_scope_text(question)
    question_terms = _scope_terms(question)
    available = [str(sheet) for item in catalog for sheet in item.get("sheets") or []]
    quoted = [
        value.strip()
        for value in re.findall(r'["“”]([^"“”]+)["“”]', question)
        if value.strip()
    ]
    exact_quoted = [
        sheet
        for sheet in available
        if any(
            _canonical_scope_text(sheet) == _canonical_scope_text(value)
            for value in quoted
        )
    ]
    if exact_quoted:
        return list(dict.fromkeys(exact_quoted))
    # Users often omit a trailing capacity/configuration qualifier when they
    # explicitly name a sheet (for example, "sheet UCS-X" for
    # "UCS-X (8xH200)"). Resolve that shorthand only when the alias is unique
    # in the selected workbook, so similar tabs cannot be silently mixed.
    if re.search(r"\bsheets?\b", canonical_question):
        aliases: dict[str, list[str]] = {}
        for sheet in available:
            alias = re.sub(r"\s*\([^()]+\)\s*$", "", sheet).strip()
            canonical_alias = _canonical_scope_text(alias)
            if (
                canonical_alias
                and canonical_alias != _canonical_scope_text(sheet)
                and len(canonical_alias.split()) >= 2
            ):
                aliases.setdefault(canonical_alias, []).append(sheet)
        shorthand_matches = [
            sheets[0]
            for alias, sheets in aliases.items()
            if len(sheets) == 1
            and re.search(rf"\b{re.escape(alias)}\b", canonical_question)
        ]
        if shorthand_matches:
            return list(dict.fromkeys(shorthand_matches))
    question_identifiers = set(
        re.findall(r"\b[a-z]+\d+[a-z]*\b", unicodedata.normalize("NFKC", question).casefold())
    )
    matches: list[str] = []
    for item in catalog:
        for sheet in item.get("sheets") or []:
            terms = _scope_terms(str(sheet))
            canonical_sheet = _canonical_scope_text(str(sheet))
            sheet_identifiers = set(
                re.findall(
                    r"\b[a-z]+\d+[a-z]*\b",
                    unicodedata.normalize("NFKC", str(sheet)).casefold(),
                )
            )
            explicitly_named = bool(
                terms
                and (
                    (len(terms) >= 2 and canonical_sheet in canonical_question)
                    or re.search(
                        rf"\bsheet\s+{re.escape(canonical_sheet)}\b",
                        canonical_question,
                    )
                    or any(
                        term in question_terms
                        for term in terms
                        if len(term) >= 3 and any(character.isdigit() for character in term)
                    )
                    or bool(question_identifiers & sheet_identifiers)
                    or (
                        canonical_sheet == "boq"
                        and bool(re.search(r"\bboq\b", canonical_question))
                    )
                )
            )
            if explicitly_named:
                if str(sheet).casefold() not in {match.casefold() for match in matches}:
                    matches.append(str(sheet))
    return matches


def _chunk_in_scope(
    chunk: dict[str, Any], file_names: list[str], sheet_names: list[str]
) -> bool:
    if file_names and str(chunk.get("file_name") or "").casefold() not in {
        item.casefold() for item in file_names
    }:
        return False
    if sheet_names:
        sheet = _sheet_name(chunk).casefold()
        heading = str(chunk.get("heading") or "").casefold()
        allowed = {item.casefold() for item in sheet_names}
        return sheet in allowed or heading in allowed
    return True


def _requested_file_references(question: str) -> list[str]:
    references: list[str] = []
    quoted = re.findall(
        rf"[\"'“”]([^\"'“”\n]+\.{SUPPORTED_FILE_PATTERN})[\"'“”]",
        question,
        re.IGNORECASE,
    )
    bare = re.findall(
        rf"(?<![\w./-])([\w][\w./()\-]*\.{SUPPORTED_FILE_PATTERN})(?!\w)",
        question,
        re.IGNORECASE,
    )
    quoted_keys = {_normalized_file_reference(reference) for reference in quoted}
    bare = [
        reference
        for reference in bare
        if not any(key.endswith(_normalized_file_reference(reference)) for key in quoted_keys)
    ]
    for reference in [*quoted, *bare]:
        candidate = reference.strip().replace("\\", "/").rsplit("/", 1)[-1]
        if candidate and candidate.casefold() not in {item.casefold() for item in references}:
            references.append(candidate)
    return references


def _named_files(question: str, file_names: list[str]) -> list[str]:
    normalized_question = unicodedata.normalize("NFKC", question).casefold()
    exact = [name for name in file_names if name.casefold() in normalized_question]
    if exact:
        return exact
    compact_question = _normalized_file_reference(question)
    return [
        name
        for name in file_names
        if len(_normalized_file_reference(name)) >= 8
        and _normalized_file_reference(name) in compact_question
    ]


def _version_identity(file_name: str) -> tuple[str, tuple[int, int] | None, str]:
    stem = Path(file_name).stem
    normalized = unicodedata.normalize("NFKC", stem).casefold()
    version_match = re.search(
        r"(?:^|[\s._-])(?:v(?:ersion)?|rev(?:ision)?)[\s._-]*([0-9]+)(?:$|[\s._-])",
        normalized,
    )
    date_match = re.search(
        r"(?:^|[\s._-])((?:19|20)\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?:$|[\s._-])",
        normalized,
    )
    rank: tuple[int, int] | None = None
    label = ""
    if date_match:
        rank = (2, int("".join(date_match.groups())))
        label = date_match.group(0).strip(" ._-")
    elif version_match:
        rank = (1, int(version_match.group(1)))
        label = version_match.group(0).strip(" ._-")
    family = re.sub(
        r"(?:^|[\s._-])(?:v(?:ersion)?|rev(?:ision)?)[\s._-]*[0-9]+(?:$|[\s._-])",
        " ",
        normalized,
    )
    family = re.sub(
        r"(?:^|[\s._-])(?:19|20)\d{2}[-_.]?\d{2}[-_.]?\d{2}(?:$|[\s._-])",
        " ",
        family,
    )
    family = re.sub(r"(?:^|[\s._-])(?:draft|final|copy)(?:$|[\s._-])", " ", family)
    family = re.sub(r"[^a-z0-9]+", "", family)
    return f"{Path(file_name).suffix.casefold()}:{family}", rank, label


def _resolve_version_conflicts(
    file_names: list[str], named_files: list[str]
) -> tuple[list[dict[str, Any]], set[str]]:
    groups: dict[str, list[tuple[str, tuple[int, int] | None, str]]] = {}
    for file_name in file_names:
        family, rank, label = _version_identity(file_name)
        if not family.split(":", 1)[-1]:
            continue
        groups.setdefault(family, []).append((file_name, rank, label))
    conflicts: list[dict[str, Any]] = []
    excluded: set[str] = set()
    named = {item.casefold() for item in named_files}
    for entries in groups.values():
        if len(entries) < 2 or not any(rank is not None or label for _, rank, label in entries):
            continue
        files = sorted((file_name for file_name, _, _ in entries), key=str.casefold)
        explicit = next((file_name for file_name in files if file_name.casefold() in named), None)
        if explicit:
            conflicts.append(
                {
                    "files": files,
                    "selectedFile": explicit,
                    "resolution": "explicit_file",
                }
            )
            continue
        ranked = [(file_name, rank) for file_name, rank, _ in entries if rank is not None]
        ranked.sort(key=lambda item: item[1] or (0, 0), reverse=True)
        if ranked and (len(ranked) == 1 or ranked[0][1] != ranked[1][1]):
            selected = ranked[0][0]
            excluded.update(file_name.casefold() for file_name in files if file_name != selected)
            conflicts.append(
                {
                    "files": files,
                    "selectedFile": selected,
                    "resolution": "newest_version_marker",
                }
            )
        else:
            conflicts.append(
                {
                    "files": files,
                    "selectedFile": None,
                    "resolution": "unresolved",
                }
            )
    return conflicts, excluded


def _search_question(question: str, named_files: list[str]) -> str:
    search = question
    for file_name in named_files:
        search = re.sub(re.escape(file_name), " ", search, flags=re.IGNORECASE)
    search = re.sub(r"[\"'“”]", " ", search)
    search = re.sub(r"\s+", " ", search).strip(" ,.:;-")
    return search or question


def _diversify_by_file(
    chunks: list[dict[str, Any]], limit: int
) -> list[dict[str, Any]]:
    if len(chunks) <= limit:
        return chunks
    selected: list[dict[str, Any]] = []
    deferred: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for chunk in chunks:
        key = (
            str(chunk.get("knowledge_base_id") or ""),
            str(chunk.get("file_name") or ""),
        )
        if key in seen:
            deferred.append(chunk)
            continue
        seen.add(key)
        selected.append(chunk)
        if len(selected) >= limit:
            return selected
    return (selected + deferred)[:limit]


def _diversify_by_section(
    chunks: list[dict[str, Any]], limit: int
) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    deferred: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for chunk in chunks:
        key = (
            str(chunk.get("knowledge_base_id") or ""),
            str(chunk.get("file_name") or ""),
            str(chunk.get("location") or chunk.get("heading") or ""),
        )
        if key in seen:
            deferred.append(chunk)
            continue
        seen.add(key)
        selected.append(chunk)
    return (selected + deferred)[:limit]


def _coverage_key(chunk: dict[str, Any]) -> tuple[str, str, str]:
    location = str(chunk.get("location") or "")
    heading = str(chunk.get("heading") or "").strip()
    page = re.search(r"\b(?:slide|page)\s+(\d+)", location, re.IGNORECASE)
    if heading:
        section = re.sub(r"\s+", " ", heading.casefold())
    elif page:
        number = int(page.group(1))
        start = ((number - 1) // 4) * 4 + 1
        section = f"page-group-{start}-{start + 3}"
    else:
        section = location.casefold()
    return (
        str(chunk.get("knowledge_base_id") or ""),
        str(chunk.get("file_name") or ""),
        section,
    )


def _cover_major_sections(
    chunks: list[dict[str, Any]], limit: int
) -> list[dict[str, Any]]:
    if len(chunks) <= limit:
        return chunks
    first: list[dict[str, Any]] = []
    remainder: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for chunk in chunks:
        key = _coverage_key(chunk)
        if key in seen:
            remainder.append(chunk)
        else:
            seen.add(key)
            first.append(chunk)
    return (first + remainder)[:limit]


def _balance_by_file(
    chunks: list[dict[str, Any]], limit: int
) -> list[dict[str, Any]]:
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    order: list[tuple[str, str]] = []
    for chunk in chunks:
        key = (
            str(chunk.get("knowledge_base_id") or ""),
            str(chunk.get("file_name") or ""),
        )
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(chunk)
    selected: list[dict[str, Any]] = []
    offset = 0
    while len(selected) < limit:
        added = False
        for key in order:
            if offset < len(groups[key]):
                selected.append(groups[key][offset])
                added = True
                if len(selected) >= limit:
                    break
        if not added:
            break
        offset += 1
    return selected


def _sheet_name(chunk: dict[str, Any]) -> str:
    match = re.search(
        r"^Sheet\s+(.+?)(?:,\s*[A-Z]+\d+:[A-Z]+\d+)?$",
        str(chunk.get("location") or ""),
        re.IGNORECASE,
    )
    return match.group(1).strip() if match else ""


def _requested_sheet_names(
    question: str, chunks: list[dict[str, Any]]
) -> list[str]:
    normalized = question.casefold()
    names = sorted({_sheet_name(chunk) for chunk in chunks if _sheet_name(chunk)})
    return [name for name in names if name.casefold() in normalized]


