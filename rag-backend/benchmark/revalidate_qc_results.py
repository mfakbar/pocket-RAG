from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from run_qc_matrix import grounded_fallback, grounding_issues


def revalidate_case(case: dict[str, Any]) -> dict[str, Any]:
    chunks = [
        {
            "file": source["file"],
            "location": source["location"],
            "heading": source.get("heading", ""),
            "text": source["text"],
        }
        for source in case.get("sources") or []
    ]
    initial = str(case.get("initialAnswer") or case.get("answer") or "")
    repaired = case.get("repairedAnswer")
    initial_issues = grounding_issues(initial, chunks)
    repair_used = bool(initial_issues and repaired)
    repair_issues = grounding_issues(str(repaired), chunks) if repair_used else []
    fallback_used = bool(initial_issues and (not repaired or repair_issues))

    if not initial_issues:
        answer = initial
    elif repair_used and not repair_issues:
        answer = str(repaired)
    else:
        answer = grounded_fallback(chunks)

    projected_end_to_end_ms = float(case.get("endToEndMs") or 0)
    if not repair_used and not fallback_used:
        projected_end_to_end_ms = float(case.get("retrievalMs") or 0) + float(
            case.get("generationMs") or 0
        )

    return {
        **case,
        "answerRevalidated": answer,
        "issuesBeforeRepairRevalidated": initial_issues,
        "issuesAfterRepairRevalidated": repair_issues,
        "repairUsedRevalidated": repair_used,
        "fallbackUsedRevalidated": fallback_used,
        "projectedEndToEndMs": round(projected_end_to_end_ms, 2),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    payload = json.loads(args.input.read_text(encoding="utf-8"))
    payload["cases"] = [revalidate_case(case) for case in payload.get("cases") or []]
    args.output.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
