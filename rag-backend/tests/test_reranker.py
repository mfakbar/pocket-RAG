from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pocketrag_backend.reranker import LocalReranker


class LocalRerankerTests(unittest.TestCase):
    def test_supports_separate_cache_locations_for_selectable_models(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            quality = LocalReranker(cache)
            faster = LocalReranker(cache, "BAAI/bge-reranker-base")

            self.assertEqual(quality.local_model_dir, cache / "model")
            self.assertEqual(
                faster.local_model_dir, cache / "BAAI--bge-reranker-base"
            )

    def test_rejects_an_unsupported_reranker_model(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                LocalReranker(Path(directory), "unknown/model")

    def test_parses_valid_git_lfs_pointer(self) -> None:
        digest = "a" * 64
        pointer = (
            "version https://git-lfs.github.com/spec/v1\n"
            f"oid sha256:{digest}\n"
            "size 2271071852\n"
        ).encode()

        self.assertEqual(LocalReranker._parse_lfs_pointer(pointer), (digest, 2271071852))

    def test_rejects_untrusted_download_host(self) -> None:
        with self.assertRaises(RuntimeError):
            LocalReranker._validate_download_url("https://example.com/model.safetensors")

    def test_detects_git_lfs_pointer(self) -> None:
        self.assertTrue(
            LocalReranker._is_lfs_pointer(
                b"version https://git-lfs.github.com/spec/v1\noid sha256:abc\n"
            )
        )
        self.assertFalse(LocalReranker._is_lfs_pointer(b'{"model_type":"xlm-roberta"}'))

    def test_prepare_uses_git_lfs_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            reranker = LocalReranker(Path(directory))
            load_calls = 0

            def load() -> None:
                nonlocal load_calls
                load_calls += 1
                if load_calls < 2:
                    raise FileNotFoundError("not downloaded")

            with (
                patch.object(reranker, "_load", side_effect=load),
                patch.object(reranker, "_download_from_git_lfs") as fallback,
                patch("huggingface_hub.snapshot_download", side_effect=RuntimeError("blocked")),
            ):
                result = reranker.prepare()

            fallback.assert_called_once_with()
            self.assertTrue(result["ready"])
            self.assertTrue(result["downloaded"])

    def test_prepare_repairs_pointer_files_left_by_filtered_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            reranker = LocalReranker(Path(directory))
            load_calls = 0

            def load() -> None:
                nonlocal load_calls
                load_calls += 1
                if load_calls < 2:
                    raise FileNotFoundError("not downloaded")

            with (
                patch.object(reranker, "_load", side_effect=load),
                patch.object(reranker, "_complete_local_model", return_value=False),
                patch.object(reranker, "_download_from_git_lfs") as fallback,
                patch("huggingface_hub.snapshot_download"),
            ):
                result = reranker.prepare()

            fallback.assert_called_once_with()
            self.assertTrue(result["ready"])


if __name__ == "__main__":
    unittest.main()
