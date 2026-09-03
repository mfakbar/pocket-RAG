from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

from pocketrag_backend.engine import RagEngine

from run_qc_matrix import unload_model
from run_suggested_prompt_performance import run_case


ALLOWED_MODELS = (
    "qwen3.5:2b-q4_K_M",
    "qwen3.5:4b-q4_K_M",
    "qwen3.5:9b-q4_K_M",
)


def checksum(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--prompts", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--ollama-url", default="http://127.0.0.1:11434")
    parser.add_argument("--embedding-model", default="qwen3-embedding:0.6b")
    args = parser.parse_args()

    config = json.loads(args.config.read_text(encoding="utf-8"))
    prompts = json.loads(args.prompts.read_text(encoding="utf-8"))
    bases = {str(base["name"]): base for base in config.get("knowledgeBases") or []}
    source_verification: list[dict[str, Any]] = []
    for item in prompts:
        base = bases[str(item["knowledgeBase"])]
        expected_file = str(item["expectedFile"])
        configured_folder = Path(str(base.get("folder") or ""))
        source_path = (
            configured_folder / expected_file
            if configured_folder.is_absolute()
            else args.source_root / configured_folder / expected_file
        )
        expected_checksum = str((base.get("manifest") or {}).get(expected_file, {}).get("checksum") or "")
        actual_checksum = checksum(source_path)
        verified = bool(expected_checksum) and actual_checksum == expected_checksum
        source_verification.append(
            {
                "promptId": item["id"],
                "path": str(source_path),
                "expectedChecksum": expected_checksum,
                "actualChecksum": actual_checksum,
                "verified": verified,
            }
        )
        if not verified:
            raise RuntimeError(f"The indexed source does not match {source_path}.")

    engine = RagEngine(str(args.data_dir), args.ollama_url, args.embedding_model)
    cases: list[dict[str, Any]] = []
    args.output.parent.mkdir(parents=True, exist_ok=True)
    total = len(prompts) * len(ALLOWED_MODELS)
    position = 0
    for model in ALLOWED_MODELS:
        for item in prompts:
            position += 1
            base = bases[str(item["knowledgeBase"])]
            print(
                f"[{position}/{total}] {model} / {item['knowledgeBase']} / {item['id']}",
                flush=True,
            )
            result = run_case(
                engine,
                args.ollama_url,
                model,
                config,
                base,
                {"label": item["category"], "prompt": item["prompt"]},
            )
            case = {
                "id": f"{item['id']}:{model}",
                "promptId": item["id"],
                "category": item["category"],
                "expectedFile": item["expectedFile"],
                "expectations": item.get("expectations", {}),
                "model": model,
                **result,
            }
            cases.append(case)
            args.output.write_text(
                json.dumps(
                    {
                        "chatModelsUsed": list(ALLOWED_MODELS),
                        "sourceVerification": source_verification,
                        "cases": cases,
                    },
                    indent=2,
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
        unload_model(args.ollama_url, model)

    payload = {
        "chatModelsUsed": list(ALLOWED_MODELS),
        "judgeModel": None,
        "sourceVerification": source_verification,
        "cases": cases,
    }
    args.output.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
