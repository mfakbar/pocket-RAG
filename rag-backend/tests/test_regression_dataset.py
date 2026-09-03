from __future__ import annotations

import json
from pathlib import Path
import unittest

from pocketrag_backend.engine import (
    DIRECT_LOOKUP,
    _named_files,
    _requested_file_references,
    _resolve_version_conflicts,
    _retrieval_mode,
)


DATASET = Path(__file__).parents[1] / "benchmark" / "regression_cases.json"


class RetrievalRegressionDatasetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.cases = json.loads(DATASET.read_text(encoding="utf-8"))["cases"]

    def test_real_world_queries_keep_expected_file_scope(self) -> None:
        for case in self.cases:
            with self.subTest(case=case["id"]):
                named = _named_files(case["question"], case["availableFiles"])
                mode = _retrieval_mode(case["question"], named)
                self.assertEqual(mode, case["expectedMode"])
                if case["strictFileScope"]:
                    self.assertEqual(named, case["expectedFiles"])
                    self.assertTrue(_requested_file_references(case["question"]))
                should_rerank = bool(case["rerankerExpected"])
                actual_rerank = not named and mode != DIRECT_LOOKUP
                self.assertEqual(actual_rerank, should_rerank)

    def test_version_resolution_is_stable(self) -> None:
        version_cases = [case for case in self.cases if case.get("expectedVersionResolution")]
        for case in version_cases:
            with self.subTest(case=case["id"]):
                named = _named_files(case["question"], case["availableFiles"])
                conflicts, excluded = _resolve_version_conflicts(case["availableFiles"], named)
                self.assertEqual(conflicts[0]["resolution"], case["expectedVersionResolution"])
                selected = conflicts[0]["selectedFile"]
                self.assertEqual(selected, case["expectedFiles"][0])
                if case["expectedVersionResolution"] == "newest_version_marker":
                    self.assertNotIn(selected.casefold(), excluded)


if __name__ == "__main__":
    unittest.main()
