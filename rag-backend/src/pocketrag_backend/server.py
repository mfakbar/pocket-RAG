from __future__ import annotations

import argparse
import json
import logging
import sys
import traceback
from typing import Any, Callable

from .engine import RagEngine


def _write(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--ollama-url", default="http://127.0.0.1:11434")
    parser.add_argument("--embedding-model", required=True)
    parser.add_argument("--reranker-model", required=True)
    args = parser.parse_args()

    logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
    engine = RagEngine(
        args.data_dir, args.ollama_url, args.embedding_model, args.reranker_model
    )
    methods: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
        "health": engine.health,
        "warm": engine.warm,
        "prepare_reranker": engine.prepare_reranker,
        "reset_index": engine.reset_index,
        "begin_rebuild": engine.begin_rebuild,
        "clone_document": engine.clone_document,
        "prune_generation": engine.prune_generation,
        "commit_rebuild": engine.commit_rebuild,
        "abort_rebuild": engine.abort_rebuild,
        "index_document": engine.index_document,
        "remove_document": engine.remove_document,
        "finalize_sync": engine.finalize_sync,
        "release_embedding": engine.release_embedding,
        "clear": engine.clear,
        "extract_attachments": engine.extract_attachments,
        "query": engine.query,
        "verify_claims": engine.verify_claims,
    }
    _write({"event": "ready", "version": "1.0.0"})

    try:
        for line in sys.stdin:
            if not line.strip():
                continue
            request_id: Any = None
            try:
                request = json.loads(line)
                request_id = request.get("id")
                method = methods.get(str(request.get("method")))
                if method is None:
                    raise ValueError("Unknown backend method.")
                result = method(dict(request.get("params") or {}))
                _write({"id": request_id, "ok": True, "result": result})
            except Exception as error:
                traceback.print_exc(file=sys.stderr)
                _write({"id": request_id, "ok": False, "error": str(error)})
    finally:
        engine.close()


if __name__ == "__main__":
    main()
