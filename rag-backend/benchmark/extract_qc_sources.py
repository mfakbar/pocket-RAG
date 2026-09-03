from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from pocketrag_backend.documents import DocumentExtractor


FOLDER_NAMES = {"BoQ": "BoQ", "Technical": "Technical Library"}


def serialize_chunk(chunk: Any) -> dict[str, str]:
    return {
        "location": str(chunk.location),
        "heading": str(chunk.heading or ""),
        "text": str(chunk.text),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--prompts", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    config = json.loads(args.config.read_text(encoding="utf-8"))
    prompts = json.loads(args.prompts.read_text(encoding="utf-8"))
    settings = dict(config["rag"])
    extractor = DocumentExtractor()
    documents: dict[str, Any] = {}

    for item in prompts:
        file_name = str(item["expectedFile"])
        if file_name in documents:
            continue
        source_path = (
            args.source_root
            / FOLDER_NAMES[str(item["knowledgeBase"])]
            / file_name
        )
        print(f"Extracting {source_path}", flush=True)
        chunks = extractor.extract(str(source_path), file_name, settings)
        documents[file_name] = {
            "path": str(source_path),
            "chunks": [serialize_chunk(chunk) for chunk in chunks],
        }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps({"documents": documents}, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
