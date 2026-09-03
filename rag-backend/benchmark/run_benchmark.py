from __future__ import annotations

import argparse
import json
import re
import shutil
import statistics
import time
import urllib.request
from pathlib import Path
from typing import Any

from pocketrag_backend.engine import RagEngine


BASE_SETTINGS = {
    "topK": 5,
    "hybridSearch": True,
    "hybridKeywordWeight": 0.5,
    "enrichedMetadata": True,
    "fullContext": False,
    "textSplitter": "token",
    "preserveHeadings": True,
    "chunkSize": 1000,
    "chunkOverlap": 100,
    "minimumChunkSize": 500,
    "pdfOcr": False,
    "improveDocumentMatching": False,
}

STOP_WORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "does",
    "for",
    "from",
    "how",
    "in",
    "is",
    "of",
    "on",
    "the",
    "to",
    "what",
    "which",
    "with",
}


def knowledge_base_for_file(index: int) -> str:
    return "benchmark-a" if index % 2 == 0 else "benchmark-b"


def question_terms(question: str) -> set[str]:
    return {
        token
        for token in re.findall(r"[a-z0-9]+", question.lower())
        if len(token) > 2 and token not in STOP_WORDS
    }


def query_result(
    engine: RagEngine,
    item: dict[str, str],
    knowledge_base_ids: list[str],
    improve: bool,
) -> dict[str, Any]:
    settings = {**BASE_SETTINGS, "improveDocumentMatching": improve}
    started = time.perf_counter()
    response = engine.query(
        {
            "query": item["question"],
            "knowledgeBaseIds": knowledge_base_ids,
            "settings": settings,
        }
    )
    elapsed_ms = (time.perf_counter() - started) * 1000
    chunks = response["chunks"]
    expected_indexes = [
        index for index, chunk in enumerate(chunks) if chunk["file"] == item["expected_file"]
    ]
    expected_chunks = [chunks[index] for index in expected_indexes]
    terms = question_terms(item["question"])
    expected_text = " ".join(
        f"{chunk.get('heading', '')} {chunk.get('text', '')}" for chunk in expected_chunks
    ).lower()
    matched_terms = sorted(term for term in terms if term in expected_text)
    return {
        "correct_source_in_top_five": bool(expected_indexes),
        "correct_source_rank": expected_indexes[0] + 1 if expected_indexes else None,
        "citation_points_to_expected_source": bool(expected_indexes)
        and all(bool(chunk.get("location")) for chunk in expected_chunks),
        "citation_metadata_complete": all(
            bool(chunk.get("file")) and bool(chunk.get("location")) for chunk in chunks
        ),
        "passage_term_coverage": round(len(matched_terms) / len(terms), 3) if terms else 0.0,
        "matched_question_terms": matched_terms,
        "latency_ms": round(elapsed_ms, 2),
        "rerank_latency_ms": float(response.get("metrics", {}).get("rerankLatencyMs", 0.0)),
        "reranker_peak_memory_bytes": int(
            response.get("metrics", {}).get("rerankerPeakMemoryBytes", 0)
        ),
        "process_peak_memory_bytes": int(
            response.get("metrics", {}).get("processPeakMemoryBytes", 0)
        ),
        "chunks": [
            {
                "index": index + 1,
                "file": chunk["file"],
                "location": chunk["location"],
                "knowledge_base_id": chunk["knowledgeBaseId"],
                "text_preview": chunk["text"][:350],
            }
            for index, chunk in enumerate(chunks)
        ],
    }


def ollama_answer(
    ollama_url: str, model: str, question: str, chunks: list[dict[str, Any]]
) -> str:
    sources = "\n\n".join(
        f"[{chunk['index']}] {chunk['file']} - {chunk['location']}\n{chunk['text_preview']}"
        for chunk in chunks
    )
    prompt = (
        "Answer only from the sources below. Cite every factual paragraph with [number]. "
        "If the answer is not present, say so.\n\n"
        f"Question: {question}\n\nSources:\n{sources}"
    )
    body = json.dumps(
        {
            "model": model,
            "prompt": prompt,
            "stream": False,
            "think": False,
            "options": {"temperature": 0.1, "num_predict": 256},
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{ollama_url.rstrip('/')}/api/generate",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        return str(json.loads(response.read().decode("utf-8")).get("response", "")).strip()


def answer_grounding(answer: str, result: dict[str, Any], expected_file: str) -> dict[str, Any]:
    cited = sorted({int(value) for value in re.findall(r"\[(\d+)\]", answer)})
    valid = [index for index in cited if 1 <= index <= len(result["chunks"])]
    expected = [
        index
        for index in valid
        if result["chunks"][index - 1]["file"] == expected_file
    ]
    refused = not answer or "not present" in answer.lower() or "not provided" in answer.lower()
    return {
        "answer": answer,
        "cited_indexes": cited,
        "all_citations_valid": len(valid) == len(cited) and bool(cited),
        "cites_expected_source": bool(expected),
        "grounded_answer_proxy": not refused and bool(expected) and len(valid) == len(cited),
    }


def summarize(results: list[dict[str, Any]]) -> dict[str, Any]:
    baseline = [item["baseline"] for item in results]
    reranked = [item["reranked"] for item in results]
    count = len(results)
    baseline_recall = sum(item["correct_source_in_top_five"] for item in baseline) / count
    reranked_recall = sum(item["correct_source_in_top_five"] for item in reranked) / count
    added_latencies = [
        after["latency_ms"] - before["latency_ms"]
        for before, after in zip(baseline, reranked, strict=True)
    ]
    answer_items = [item for item in results if "answer_evaluation" in item]
    return {
        "questions": count,
        "baseline_correct_top_five": round(baseline_recall, 4),
        "reranked_correct_top_five": round(reranked_recall, 4),
        "absolute_improvement": round(reranked_recall - baseline_recall, 4),
        "relative_improvement": round(
            (reranked_recall - baseline_recall) / baseline_recall, 4
        )
        if baseline_recall
        else None,
        "baseline_citation_passage_rate": round(
            sum(item["citation_points_to_expected_source"] for item in baseline) / count, 4
        ),
        "reranked_citation_passage_rate": round(
            sum(item["citation_points_to_expected_source"] for item in reranked) / count, 4
        ),
        "baseline_passage_term_coverage": round(
            statistics.mean(item["passage_term_coverage"] for item in baseline), 4
        ),
        "reranked_passage_term_coverage": round(
            statistics.mean(item["passage_term_coverage"] for item in reranked), 4
        ),
        "median_added_warm_latency_ms": round(statistics.median(added_latencies), 2),
        "median_reranker_only_latency_ms": round(
            statistics.median(item["rerank_latency_ms"] for item in reranked), 2
        ),
        "peak_process_memory_bytes": max(
            (item["process_peak_memory_bytes"] for item in reranked), default=0
        ),
        "answer_samples": len(answer_items),
        "baseline_grounded_answer_proxy": round(
            sum(item["answer_evaluation"]["baseline"]["grounded_answer_proxy"] for item in answer_items)
            / len(answer_items),
            4,
        )
        if answer_items
        else None,
        "reranked_grounded_answer_proxy": round(
            sum(item["answer_evaluation"]["reranked"]["grounded_answer_proxy"] for item in answer_items)
            / len(answer_items),
            4,
        )
        if answer_items
        else None,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", required=True)
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--ollama-url", default="http://127.0.0.1:11434")
    parser.add_argument("--embedding-model", default="qwen3-embedding:0.6b")
    parser.add_argument("--answer-model", default="")
    parser.add_argument("--answer-sample", type=int, default=10)
    parser.add_argument("--reuse-index", action="store_true")
    parser.add_argument(
        "--hardware-label",
        default="unreported",
        help="Device used for the measurement, for example 'M1 16GB'.",
    )
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    if not args.reuse_index:
        shutil.rmtree(data_dir, ignore_errors=True)
    engine = RagEngine(str(data_dir), args.ollama_url, args.embedding_model)
    corpus = Path(args.corpus)
    supported = {".pdf", ".docx", ".pptx", ".xlsx", ".csv", ".txt", ".md"}
    files = sorted(path for path in corpus.rglob("*") if path.suffix.lower() in supported)
    file_to_knowledge_base = {
        path.name: knowledge_base_for_file(index) for index, path in enumerate(files)
    }

    indexed = []
    if not args.reuse_index:
        for index, path in enumerate(files):
            relative = str(path.relative_to(corpus))
            knowledge_base_id = knowledge_base_for_file(index)
            started = time.perf_counter()
            result = engine.index_document(
                {
                    "knowledgeBaseId": knowledge_base_id,
                    "filePath": str(path),
                    "relativePath": relative,
                    "documentId": f"{knowledge_base_id}:{relative}",
                    "settings": BASE_SETTINGS,
                }
            )
            indexed.append(
                {
                    "file": relative,
                    "knowledge_base_id": knowledge_base_id,
                    "chunks": result["chunks"],
                    "seconds": round(time.perf_counter() - started, 3),
                }
            )
            print(f"Indexed {relative}: {result['chunks']} chunks", flush=True)
        engine.finalize_sync({})

    questions = json.loads(Path(__file__).with_name("questions.json").read_text(encoding="utf-8"))
    first = questions[0]
    warm_ids = ["benchmark-a", "benchmark-b"]
    print("Loading and warming the reranker...", flush=True)
    cold_started = time.perf_counter()
    cold = query_result(engine, first, warm_ids, True)
    cold_load_ms = (time.perf_counter() - cold_started) * 1000
    query_result(engine, first, warm_ids, True)

    modes: dict[str, list[dict[str, Any]]] = {"one_knowledge_base": [], "multiple_knowledge_bases": []}
    for mode, results in modes.items():
        for index, item in enumerate(questions):
            expected_kb = file_to_knowledge_base.get(item["expected_file"], "benchmark-a")
            ids = [expected_kb] if mode == "one_knowledge_base" else warm_ids
            baseline = query_result(engine, item, ids, False)
            reranked = query_result(engine, item, ids, True)
            result: dict[str, Any] = {**item, "knowledge_base_ids": ids, "baseline": baseline, "reranked": reranked}
            if (
                args.answer_model
                and mode == "multiple_knowledge_bases"
                and index < max(0, args.answer_sample)
            ):
                baseline_answer = ollama_answer(
                    args.ollama_url, args.answer_model, item["question"], baseline["chunks"]
                )
                reranked_answer = ollama_answer(
                    args.ollama_url, args.answer_model, item["question"], reranked["chunks"]
                )
                result["answer_evaluation"] = {
                    "baseline": answer_grounding(
                        baseline_answer, baseline, item["expected_file"]
                    ),
                    "reranked": answer_grounding(
                        reranked_answer, reranked, item["expected_file"]
                    ),
                }
            results.append(result)
            print(
                f"{mode} {index + 1:02d}/{len(questions)} "
                f"baseline={'PASS' if baseline['correct_source_in_top_five'] else 'MISS'} "
                f"reranked={'PASS' if reranked['correct_source_in_top_five'] else 'MISS'}",
                flush=True,
            )

    summaries = {mode: summarize(results) for mode, results in modes.items()}
    multi = summaries["multiple_knowledge_bases"]
    passed = (
        multi["absolute_improvement"] >= 0.10
        and multi["median_added_warm_latency_ms"] < 1000
    )
    report = {
        "model": "BAAI/bge-reranker-v2-m3",
        "model_revision": "c0abf900d43de6a2652b9acd221bb1b45ab65d6e",
        "hardware_label": args.hardware_label,
        "corpus_files": len(files),
        "cold_load_ms": round(cold_load_ms, 2),
        "cold_load_additional_peak_memory_bytes": cold["reranker_peak_memory_bytes"],
        "criteria": {
            "minimum_absolute_top_five_improvement": 0.10,
            "maximum_median_added_warm_latency_ms": 1000,
        },
        "summaries": summaries,
        "decision": "enable" if passed else "do_not_enable",
        "measurement_note": (
            "Answer grounding is an automatic citation-validity proxy. Generated answers and source "
            "previews are included for human accuracy review."
        ),
        "indexed": indexed,
        "results": modes,
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "results"}, indent=2))


if __name__ == "__main__":
    main()
