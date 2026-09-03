from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import subprocess
import time
import urllib.request
from pathlib import Path
from typing import Any

from pocketrag_backend.engine import RagEngine


SETTINGS = {
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


def normalized(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.casefold())


def numeric_values(value: str) -> list[float]:
    matches = re.findall(r"(?<![a-z0-9])\d[\d,]*(?:\.\d+)?", value.casefold())
    return [float(item.replace(",", "")) for item in matches]


def contains_number(value: str, expected: float) -> bool:
    return any(math.isclose(item, expected, rel_tol=1e-9, abs_tol=1e-6) for item in numeric_values(value))


def format_rows(rows: list[dict[str, Any]], limit: int = 320) -> str:
    lines = ["VERIFIED TYPED SPREADSHEET ROWS"]
    for row in rows[:limit]:
        cells = "; ".join(
            f"{cell['column']}={cell['value']}"
            for cell in row.get("cells") or []
            if str(cell.get("value") or "").strip()
        )
        lines.append(
            f"- {row['file']}, Sheet {row['sheet']}, row {row['rowIndex']}: {cells}"
        )
    return "\n".join(lines)


def source_blocks(chunks: list[dict[str, Any]]) -> str:
    return "\n\n".join(
        "\n".join(
            [
                f"[{index}]",
                f"File: {chunk['file']}",
                f"Location: {chunk['location']}",
                "Content:",
                str(chunk["text"]),
            ]
        )
        for index, chunk in enumerate(chunks, start=1)
    )


def answer_with_local_model(
    url: str,
    model: str,
    prompt: str,
    chunks: list[dict[str, Any]],
    rows: list[dict[str, Any]],
    structured_evidence: str,
) -> str:
    system = (
        "You are RavnDock. Answer only from the supplied local spreadsheet evidence. "
        "Use typed rows to keep row-to-column mappings exact. Perform only calculations explicitly "
        "requested by the user, show their operands, preserve exact units, and cite the matching raw "
        "source chunks as [1], [2], and so on. Treat VERIFIED TYPED SPREADSHEET RESULT as authoritative: "
        "copy its selected rows, operands, order, and derived result directly. Do not add excluded rows, "
        "alternate calculations, assumptions, discrepancy notes, self-corrections, or repeated conclusions. "
        "If evidence is insufficient, say so.\n\n"
        + (structured_evidence or format_rows(rows))
        + "\n\nRAW SOURCE CHUNKS\n"
        + source_blocks(chunks)
    )
    body = json.dumps(
        {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            "stream": False,
            "think": False,
            "options": {
                "num_ctx": 16384,
                "temperature": 0,
                "top_p": 0.8,
                "num_predict": 900,
            },
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{url.rstrip('/')}/api/chat",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=900) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return str(payload.get("message", {}).get("content", "")).strip()


def app_structured_result(
    question: str,
    chunks: list[dict[str, Any]],
    rows: list[dict[str, Any]],
    compiled_module: Path,
) -> dict[str, str]:
    runner = Path(__file__).with_name("render_excel_evidence.cjs")
    payload = json.dumps(
        {
            "question": question,
            "chunks": chunks,
            "rows": rows,
            "compiled": str(compiled_module),
        }
    )
    result = subprocess.run(
        ["node", str(runner)],
        input=payload,
        text=True,
        capture_output=True,
        check=True,
    )
    parsed = json.loads(result.stdout)
    return {
        "evidence": str(parsed.get("evidence") or ""),
        "answer": str(parsed.get("answer") or ""),
    }


def evaluate_text(value: str, case: dict[str, Any]) -> dict[str, Any]:
    missing_text = [
        item for item in case.get("requiredText") or [] if normalized(str(item)) not in normalized(value)
    ]
    missing_numbers = [
        float(item)
        for item in case.get("requiredNumbers") or []
        if not contains_number(value, float(item))
    ]
    return {
        "pass": not missing_text and not missing_numbers,
        "missingText": missing_text,
        "missingNumbers": missing_numbers,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--prompts", type=Path, default=Path(__file__).with_name("excel_boq_prompts.json"))
    parser.add_argument("--ollama-url", default="http://127.0.0.1:11434")
    parser.add_argument("--embedding-model", default="qwen3-embedding:4b")
    parser.add_argument("--answer-model", default="qwen3.5:4b-q4_K_M")
    parser.add_argument("--reuse-index", action="store_true")
    parser.add_argument("--skip-answers", action="store_true")
    parser.add_argument("--case", action="append", default=[])
    parser.add_argument(
        "--compiled-rag-pipeline",
        type=Path,
        default=Path(".test-out/src/main/lib/rag-pipeline.js"),
        help="Compiled production spreadsheet evidence module. Run npm test first.",
    )
    args = parser.parse_args()

    cases = json.loads(args.prompts.read_text(encoding="utf-8"))
    selected_ids = {str(value) for value in args.case if str(value).strip()}
    if selected_ids:
        cases = [case for case in cases if str(case["id"]) in selected_ids]
    if not args.reuse_index:
        shutil.rmtree(args.data_dir, ignore_errors=True)
    engine = RagEngine(str(args.data_dir), args.ollama_url, args.embedding_model)
    indexed: list[dict[str, Any]] = []
    try:
        if not args.reuse_index:
            files = sorted(args.corpus.glob("*.xlsx"), key=lambda item: item.name.casefold())
            for position, path in enumerate(files, start=1):
                started = time.perf_counter()
                result = engine.index_document(
                    {
                        "knowledgeBaseId": "excel-boq",
                        "filePath": str(path),
                        "relativePath": path.name,
                        "documentId": f"excel-boq:{path.name}",
                        "settings": SETTINGS,
                    }
                )
                indexed.append(
                    {
                        "file": path.name,
                        "chunks": result["chunks"],
                        "spreadsheetCells": result.get("spreadsheetCells", 0),
                        "seconds": round(time.perf_counter() - started, 3),
                    }
                )
                print(f"Indexed {position}/{len(files)}: {path.name}", flush=True)
            engine.finalize_sync({})

        results: list[dict[str, Any]] = []
        for position, case in enumerate(cases, start=1):
            print(f"Case {position}/{len(cases)}: {case['id']}", flush=True)
            started = time.perf_counter()
            response = engine.query(
                {
                    "query": case["prompt"],
                    "knowledgeBaseIds": ["excel-boq"],
                    "settings": SETTINGS,
                }
            )
            retrieval_ms = round((time.perf_counter() - started) * 1000, 2)
            chunks = list(response.get("chunks") or [])
            rows = list(response.get("structuredRows") or [])
            structured_result = app_structured_result(
                str(case["prompt"]), chunks, rows, args.compiled_rag_pipeline
            )
            structured_evidence = structured_result["evidence"]
            evidence = (
                source_blocks(chunks)
                + "\n"
                + format_rows(rows)
                + "\n"
                + structured_evidence
            )
            expected_file = str(case["expectedFile"])
            expected_sheets = {str(item) for item in case.get("expectedSheets") or []}
            retrieved_files = {str(chunk.get("file") or "") for chunk in chunks}
            retrieved_sheets = {
                match.group(1)
                for chunk in chunks
                if (match := re.match(r"Sheet (.+?), [A-Z]+\d+:[A-Z]+\d+", str(chunk.get("location") or "")))
            }
            row_sheets = {str(row.get("sheet") or "") for row in rows}
            scope_pass = bool(chunks) and retrieved_files == {expected_file}
            sheet_pass = not expected_sheets or expected_sheets.issubset(retrieved_sheets | row_sheets)
            evidence_eval = evaluate_text(evidence, case)
            answer = ""
            local_model_draft = ""
            answer_eval = {"pass": False, "missingText": [], "missingNumbers": []}
            answer_ms = 0.0
            if not args.skip_answers and chunks:
                answer_started = time.perf_counter()
                local_model_draft = answer_with_local_model(
                    args.ollama_url,
                    args.answer_model,
                    str(case["prompt"]),
                    chunks,
                    rows,
                    structured_evidence,
                )
                answer = structured_result["answer"] or local_model_draft
                answer_ms = round((time.perf_counter() - answer_started) * 1000, 2)
                answer_eval = evaluate_text(answer, case)
            results.append(
                {
                    **case,
                    "retrievalMs": retrieval_ms,
                    "answerMs": answer_ms,
                    "retrievalMetrics": response.get("metrics") or {},
                    "retrievedFiles": sorted(retrieved_files),
                    "retrievedSheets": sorted(retrieved_sheets),
                    "structuredRowSheets": sorted(row_sheets),
                    "chunkCount": len(chunks),
                    "structuredRowCount": len(rows),
                    "structuredEvidence": structured_evidence,
                    "scopePass": scope_pass,
                    "sheetCoveragePass": sheet_pass,
                    "evidenceEvaluation": evidence_eval,
                    "answerEvaluation": answer_eval,
                    "pass": scope_pass and sheet_pass and evidence_eval["pass"] and (args.skip_answers or answer_eval["pass"]),
                    "answer": answer,
                    "localModelDraft": local_model_draft,
                    "sources": chunks,
                }
            )
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps({"indexed": indexed, "results": results}, indent=2), encoding="utf-8")
    finally:
        engine.close()

    summary = {
        "cases": len(results),
        "passed": sum(bool(item["pass"]) for item in results),
        "scopePassed": sum(bool(item["scopePass"]) for item in results),
        "sheetCoveragePassed": sum(bool(item["sheetCoveragePass"]) for item in results),
        "evidencePassed": sum(bool(item["evidenceEvaluation"]["pass"]) for item in results),
        "answerPassed": None if args.skip_answers else sum(bool(item["answerEvaluation"]["pass"]) for item in results),
        "embeddingModel": args.embedding_model,
        "answerModel": None if args.skip_answers else args.answer_model,
        "appModelUsed": False,
    }
    payload = {"summary": summary, "indexed": indexed, "results": results}
    args.output.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2), flush=True)


if __name__ == "__main__":
    main()
