from __future__ import annotations

import argparse
import json
import re
import time
import urllib.request
from pathlib import Path
from typing import Any

from pocketrag_backend.engine import RagEngine


HTML_ARTIFACT = re.compile(r"</?(?:br|p|div|span|li|ul|ol|table|tr|td|h[1-6])\b", re.I)
FILE_REFERENCE = re.compile(r'["“]([^"”]+\.(?:pdf|docx|pptx|xlsx|csv|txt|md))["”]', re.I)


def ask_ollama(
    ollama_url: str,
    model: str,
    question: str,
    chunks: list[dict[str, Any]],
    knowledge_base: dict[str, Any],
    inference: dict[str, Any],
) -> tuple[str, float]:
    sources = "\n\n".join(
        "\n".join(
            [
                f"[{index}]",
                f"Document title: {Path(str(chunk['file'])).stem}",
                f"File: {chunk['file']}",
                f"Location: {chunk['location']}",
                *([f"Section: {chunk['heading']}"] if chunk.get("heading") else []),
                "Content:",
                str(chunk["text"]),
            ]
        )
        for index, chunk in enumerate(chunks, 1)
    )
    system = (
        "You are PocketRAG. Answer using only the supplied local sources. Use Markdown, never "
        "raw HTML. Cite supporting sources inline as [1], [2], and so on. Do not infer facts "
        "that are absent from the sources. If the sources do not contain the answer, say so.\n\n"
        f"Knowledge base: {knowledge_base['name']}\n"
        f"Description: {knowledge_base.get('description') or 'Local documents'}\n\n"
        f"LOCAL SOURCES\n{sources}"
    )
    payload = json.dumps(
        {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": question},
            ],
            "stream": False,
            "think": False,
            "options": {
                "num_ctx": int(inference.get("contextLength", 8192)),
                "temperature": float(inference.get("temperature", 0.2)),
                "top_p": float(inference.get("topP", 0.9)),
                "num_predict": min(1024, int(inference.get("maxOutputTokens", 1024))),
            },
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{ollama_url.rstrip('/')}/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=300) as response:
        body = json.loads(response.read().decode("utf-8"))
    elapsed_ms = (time.perf_counter() - started) * 1000
    return str(body.get("message", {}).get("content", "")).strip(), elapsed_ms


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--ollama-url", default="http://127.0.0.1:11434")
    parser.add_argument("--embedding-model", default="qwen3-embedding:0.6b")
    parser.add_argument("--model")
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()

    config = json.loads(args.config.read_text(encoding="utf-8"))
    model = args.model or str(config["selectedModel"])
    engine = RagEngine(str(args.data_dir), args.ollama_url, args.embedding_model)
    results: list[dict[str, Any]] = []

    for base in config.get("knowledgeBases", []):
        for suggestion in base.get("suggestedPrompts", []):
            question = str(suggestion.get("prompt", "")).strip()
            if not question:
                continue
            started = time.perf_counter()
            retrieved = engine.query(
                {
                    "query": question,
                    "knowledgeBaseIds": [str(base["id"])],
                    "settings": config.get("rag", {}),
                }
            )["chunks"]
            retrieval_ms = (time.perf_counter() - started) * 1000
            answer, answer_ms = ask_ollama(
                args.ollama_url,
                model,
                question,
                retrieved,
                base,
                config.get("inference", {}),
            )
            citations = [int(value) for value in re.findall(r"\[(\d+)\]", answer)]
            referenced_files = FILE_REFERENCE.findall(question)
            retrieved_files = [str(chunk["file"]) for chunk in retrieved]
            results.append(
                {
                    "knowledgeBase": base["name"],
                    "label": suggestion.get("label"),
                    "prompt": question,
                    "referencedFiles": referenced_files,
                    "referencedFilesRetrieved": {
                        file: any(Path(item).name == Path(file).name for item in retrieved_files)
                        for file in referenced_files
                    },
                    "retrievedSources": [
                        {
                            "file": chunk["file"],
                            "location": chunk["location"],
                            "heading": chunk.get("heading", ""),
                        }
                        for chunk in retrieved
                    ],
                    "answer": answer,
                    "quality": {
                        "empty": not bool(answer),
                        "containsHtmlArtifact": bool(HTML_ARTIFACT.search(answer)),
                        "citations": citations,
                        "allCitationsValid": bool(citations)
                        and all(1 <= citation <= len(retrieved) for citation in citations),
                        "retrievalMs": round(retrieval_ms, 2),
                        "answerMs": round(answer_ms, 2),
                    },
                }
            )

    report = {
        "model": model,
        "knowledgeBases": len(config.get("knowledgeBases", [])),
        "questions": len(results),
        "results": results,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
