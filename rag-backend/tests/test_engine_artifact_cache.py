from __future__ import annotations

from types import SimpleNamespace
import tempfile
import unittest

from pocketrag_backend.engine import RagEngine


class ArtifactCacheTests(unittest.TestCase):
    def test_retry_reuses_completed_parse_and_embedding_artifact(self) -> None:
        class Extractor:
            calls = 0

            def extract(self, _file_path, _relative_path, _settings):
                self.calls += 1
                return [
                    SimpleNamespace(
                        text="Local policy text.",
                        embedding_text="Local policy text.",
                        location="Lines 1-1",
                        heading="Policy",
                    )
                ]

            @staticmethod
            def extract_spreadsheet_cells(_file_path):
                return []

            @staticmethod
            def document_metadata(_relative_path, _chunks):
                return {
                    "title": "Policy",
                    "extension": ".txt",
                    "pathSegments": ["policy.txt"],
                    "headings": ["Policy"],
                    "entities": [],
                    "summary": "Local policy text.",
                    "sections": [],
                }

        class Embedder:
            calls = 0

            def embed(self, texts, **_kwargs):
                self.calls += 1
                return [[0.1, 0.2] for _ in texts]

        with tempfile.TemporaryDirectory() as directory:
            engine = RagEngine(directory, "http://127.0.0.1:11434", "embedding-test")
            extractor = Extractor()
            embedder = Embedder()
            engine.extractor = extractor
            engine.embedder = embedder
            settings = {"chunkSize": 1000, "chunkOverlap": 100}

            first = engine.index_document(
                {
                    "knowledgeBaseId": "kb",
                    "filePath": "/tmp/policy.txt",
                    "relativePath": "policy.txt",
                    "documentId": "doc",
                    "versionId": "checksum",
                    "settings": settings,
                }
            )
            generation = engine.begin_rebuild({"knowledgeBaseId": "kb"})["generation"]
            second = engine.index_document(
                {
                    "knowledgeBaseId": "kb",
                    "filePath": "/tmp/policy.txt",
                    "relativePath": "policy.txt",
                    "documentId": "doc",
                    "versionId": "checksum",
                    "generation": generation,
                    "settings": settings,
                }
            )

            self.assertFalse(first["artifactCacheHit"])
            self.assertTrue(second["artifactCacheHit"])
            self.assertEqual(extractor.calls, 1)
            self.assertEqual(embedder.calls, 1)
            engine.close()


if __name__ == "__main__":
    unittest.main()
