from __future__ import annotations

import argparse
import json
import statistics
import subprocess
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pocketrag_backend.engine import RagEngine, _broad_query

from run_qc_matrix import (
    answer_prompt,
    attach_supported_citations,
    clean_model_text,
    grounded_fallback,
    grounding_issues,
    repair_instruction,
    sanitize_answer,
    select_chunks,
)


@dataclass
class StreamResult:
    content: str
    elapsed_ms: float
    first_token_ms: float | None
    completion_tokens: int
    tokens_per_second: float | None
    done_reason: str
    token_events: int


class MemorySampler:
    def __init__(self, ollama_url: str) -> None:
        self.ollama_url = ollama_url.rstrip("/")
        self.peak_process_rss_bytes = 0
        self.peak_model_bytes = 0
        self.peak_model_vram_bytes = 0
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=2)

    def _sample_processes(self) -> None:
        try:
            output = subprocess.check_output(
                ["ps", "-axo", "rss=,command="], text=True, timeout=2
            )
        except (OSError, subprocess.SubprocessError):
            return
        rss_kib = 0
        for line in output.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            parts = stripped.split(maxsplit=1)
            if len(parts) != 2:
                continue
            command = parts[1].lower()
            if "ollama" in command or "run_suggested_prompt_performance.py" in command:
                try:
                    rss_kib += int(parts[0])
                except ValueError:
                    continue
        self.peak_process_rss_bytes = max(self.peak_process_rss_bytes, rss_kib * 1024)

    def _sample_models(self) -> None:
        try:
            with urllib.request.urlopen(f"{self.ollama_url}/api/ps", timeout=2) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (OSError, ValueError, urllib.error.URLError):
            return
        models = payload.get("models") or []
        self.peak_model_bytes = max(
            self.peak_model_bytes, sum(int(model.get("size") or 0) for model in models)
        )
        self.peak_model_vram_bytes = max(
            self.peak_model_vram_bytes,
            sum(int(model.get("size_vram") or 0) for model in models),
        )

    def _run(self) -> None:
        while not self._stop.wait(0.25):
            self._sample_processes()
            self._sample_models()


def stream_chat(
    url: str,
    model: str,
    messages: list[dict[str, str]],
    *,
    context: int,
    temperature: float,
    top_p: float,
    max_tokens: int,
    allow_continuation: bool = True,
) -> StreamResult:
    started = time.perf_counter()
    first_token_at: float | None = None
    generated = ""
    completion_tokens = 0
    evaluation_duration_ns = 0
    done_reason = ""
    token_events = 0
    request_messages = messages
    maximum_total_tokens = min(2048, max(768, max_tokens + min(1024, max_tokens)))

    for attempt in range(3):
        remaining_tokens = max(1, maximum_total_tokens - completion_tokens)
        request = urllib.request.Request(
            f"{url.rstrip('/')}/api/chat",
            data=json.dumps(
                {
                    "model": model,
                    "messages": request_messages,
                    "stream": True,
                    "think": False,
                    "options": {
                        "num_ctx": context,
                        "temperature": temperature,
                        "top_p": top_p,
                        "num_predict": min(max_tokens, remaining_tokens),
                    },
                }
            ).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=900) as response:
            for raw_line in response:
                if not raw_line.strip():
                    continue
                update = json.loads(raw_line.decode("utf-8"))
                content = str((update.get("message") or {}).get("content") or "")
                if content:
                    first_token_at = first_token_at or time.perf_counter()
                    token_events += 1
                    generated += content
                if update.get("done_reason"):
                    done_reason = str(update["done_reason"])
                if isinstance(update.get("eval_count"), int):
                    completion_tokens += int(update["eval_count"])
                if isinstance(update.get("eval_duration"), int):
                    evaluation_duration_ns += int(update["eval_duration"])
        if (
            not allow_continuation
            or done_reason != "length"
            or attempt == 2
            or completion_tokens >= maximum_total_tokens
            or not generated.strip()
        ):
            break
        request_messages = [
            *messages,
            {"role": "assistant", "content": generated},
            {
                "role": "user",
                "content": (
                    "Continue exactly where the answer stopped. Do not repeat anything. "
                    "Finish the remaining points and end with a complete sentence."
                ),
            },
        ]

    elapsed_ms = (time.perf_counter() - started) * 1000
    tokens_per_second = (
        completion_tokens / (evaluation_duration_ns / 1_000_000_000)
        if completion_tokens and evaluation_duration_ns
        else None
    )
    return StreamResult(
        content=generated.strip(),
        elapsed_ms=elapsed_ms,
        first_token_ms=(first_token_at - started) * 1000 if first_token_at else None,
        completion_tokens=completion_tokens,
        tokens_per_second=tokens_per_second,
        done_reason=done_reason,
        token_events=token_events,
    )


def run_case(
    engine: RagEngine,
    ollama_url: str,
    model: str,
    config: dict[str, Any],
    base: dict[str, Any],
    suggestion: dict[str, Any],
) -> dict[str, Any]:
    prompt = str(suggestion["prompt"])
    started = time.perf_counter()
    retrieval_started = time.perf_counter()
    response = engine.query(
        {
            "query": prompt,
            "knowledgeBaseIds": [str(base["id"])],
            "settings": config.get("rag", {}),
        }
    )
    retrieval_ms = (time.perf_counter() - retrieval_started) * 1000
    inference = config["inference"]
    broad_query = _broad_query(prompt)
    chunks = select_chunks(response["chunks"], int(inference["contextLength"]), broad_query)
    if not chunks:
        return {
            "knowledgeBase": base["name"],
            "label": suggestion.get("label"),
            "prompt": prompt,
            "retrievalMs": round(retrieval_ms, 2),
            "retrievalConfidence": float(
                (response.get("metrics") or {}).get("confidenceScore") or 0.0
            ),
            "qualityIssues": ["no retrieved passages"],
            "endToEndMs": round((time.perf_counter() - started) * 1000, 2),
        }

    messages = [
        {"role": "system", "content": answer_prompt(base, chunks)},
        {"role": "user", "content": prompt},
    ]
    first = stream_chat(
        ollama_url,
        model,
        messages,
        context=int(inference["contextLength"]),
        temperature=float(inference["temperature"]),
        top_p=float(inference["topP"]),
        max_tokens=int(inference["maxOutputTokens"]),
    )
    answer = attach_supported_citations(
        sanitize_answer(clean_model_text(first.content), chunks), chunks
    )
    initial_answer = answer
    issues_before_repair = grounding_issues(answer, chunks)
    repair: StreamResult | None = None
    if issues_before_repair:
        repair = stream_chat(
            ollama_url,
            model,
            [*messages, {"role": "user", "content": repair_instruction(issues_before_repair)}],
            context=int(inference["contextLength"]),
            temperature=0.0,
            top_p=min(float(inference["topP"]), 0.8),
            max_tokens=min(int(inference["maxOutputTokens"]), 768 if broad_query else 512),
            allow_continuation=True,
        )
        answer = attach_supported_citations(
            sanitize_answer(clean_model_text(repair.content), chunks), chunks
        )
    repaired_answer = answer if repair is not None else None
    issues_after_repair = grounding_issues(answer, chunks)
    final_issues = list(issues_after_repair)
    fallback_used = bool(final_issues)
    if fallback_used:
        answer = grounded_fallback(chunks)
        final_issues = []

    visible_ttft_ms = retrieval_ms + (first.first_token_ms or first.elapsed_ms)
    return {
        "knowledgeBase": base["name"],
        "label": suggestion.get("label"),
        "prompt": prompt,
        "retrievalMs": round(retrieval_ms, 2),
        "retrievalConfidence": float(
            (response.get("metrics") or {}).get("confidenceScore") or 0.0
        ),
        "modelFirstTokenMs": round(first.first_token_ms, 2) if first.first_token_ms else None,
        "visibleFirstTokenMs": round(visible_ttft_ms, 2),
        "generationMs": round(first.elapsed_ms, 2),
        "repairMs": round(repair.elapsed_ms, 2) if repair else 0.0,
        "endToEndMs": round((time.perf_counter() - started) * 1000, 2),
        "completionTokens": first.completion_tokens,
        "tokensPerSecond": round(first.tokens_per_second, 2) if first.tokens_per_second else None,
        "interTokenLatencyMs": (
            round(1000 / first.tokens_per_second, 2) if first.tokens_per_second else None
        ),
        "tokenEvents": first.token_events,
        "doneReason": first.done_reason,
        "repairUsed": repair is not None,
        "fallbackUsed": fallback_used,
        "issuesBeforeRepair": issues_before_repair,
        "issuesAfterRepair": issues_after_repair,
        "qualityIssues": final_issues,
        "sourceFiles": list(dict.fromkeys(str(chunk["file"]) for chunk in chunks)),
        "sourceCount": len(chunks),
        "retrievalMetrics": response.get("metrics") or {},
        "sources": [
            {
                "file": str(chunk["file"]),
                "location": str(chunk["location"]),
                "heading": str(chunk.get("heading") or ""),
                "text": str(chunk["text"]),
            }
            for chunk in chunks
        ],
        "answer": answer,
        "initialAnswer": initial_answer,
        "repairedAnswer": repaired_answer,
    }


def median(cases: list[dict[str, Any]], field: str) -> float | None:
    values = [float(case[field]) for case in cases if case.get(field) is not None]
    return round(statistics.median(values), 2) if values else None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--ollama-url", default="http://127.0.0.1:11434")
    parser.add_argument("--embedding-model", default="qwen3-embedding:0.6b")
    parser.add_argument("--answer-model", default="qwen3.5:2b-q4_K_M")
    parser.add_argument(
        "--case",
        action="append",
        default=[],
        help="Run only a Knowledge Base:Prompt label pair. May be repeated.",
    )
    args = parser.parse_args()

    if ":4b" in args.answer_model.lower() or ":9b" in args.answer_model.lower():
        raise ValueError("This run is restricted to the 2B answer model.")

    config = json.loads(args.config.read_text(encoding="utf-8"))
    bases = [base for base in config.get("knowledgeBases") or [] if base.get("suggestedPrompts")]
    engine = RagEngine(str(args.data_dir), args.ollama_url, args.embedding_model)
    sampler = MemorySampler(args.ollama_url)
    sampler.start()
    cases: list[dict[str, Any]] = []
    try:
        selected_cases = {
            value.casefold() for value in args.case if isinstance(value, str) and value.strip()
        }
        work = [
            (base, suggestion)
            for base in bases
            for suggestion in (base.get("suggestedPrompts") or [])[:3]
            if not selected_cases
            or f"{base['name']}:{suggestion.get('label')}".casefold() in selected_cases
        ]
        total = len(work)
        position = 0
        for base, suggestion in work:
            position += 1
            print(f"[{position}/{total}] {base['name']} / {suggestion.get('label')}", flush=True)
            case = run_case(
                engine, args.ollama_url, args.answer_model, config, base, suggestion
            )
            cases.append(case)
            print(
                f"  visible TTFT {case.get('visibleFirstTokenMs')} ms, "
                f"E2E {case.get('endToEndMs')} ms, "
                f"{case.get('tokensPerSecond')} tok/s, "
                f"repair={case.get('repairUsed')}, fallback={case.get('fallbackUsed')}",
                flush=True,
            )
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps({"cases": cases}, indent=2), encoding="utf-8")
    finally:
        sampler.stop()

    warm_cases = cases[1:]
    summary = {
        "answerModel": args.answer_model,
        "chatModelsUsed": [args.answer_model],
        "cases": len(cases),
        "coldVisibleFirstTokenMs": cases[0].get("visibleFirstTokenMs") if cases else None,
        "warmMedianVisibleFirstTokenMs": median(warm_cases, "visibleFirstTokenMs"),
        "medianRetrievalMs": median(cases, "retrievalMs"),
        "medianGenerationMs": median(cases, "generationMs"),
        "medianEndToEndMs": median(cases, "endToEndMs"),
        "minEndToEndMs": min((case["endToEndMs"] for case in cases), default=None),
        "maxEndToEndMs": max((case["endToEndMs"] for case in cases), default=None),
        "medianTokensPerSecond": median(cases, "tokensPerSecond"),
        "medianInterTokenLatencyMs": median(cases, "interTokenLatencyMs"),
        "repairCount": sum(bool(case.get("repairUsed")) for case in cases),
        "fallbackCount": sum(bool(case.get("fallbackUsed")) for case in cases),
        "qualityPassCount": sum(not case.get("qualityIssues") for case in cases),
        "peakProcessRssBytes": sampler.peak_process_rss_bytes,
        "peakLoadedModelBytes": sampler.peak_model_bytes,
        "peakLoadedModelVramBytes": sampler.peak_model_vram_bytes,
    }
    payload = {"summary": summary, "cases": cases}
    args.output.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2), flush=True)


if __name__ == "__main__":
    main()
