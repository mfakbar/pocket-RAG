from __future__ import annotations

import tempfile
import unittest

from pocketrag_backend.store import HybridStore


def row(generation: str, document_id: str, text: str) -> dict[str, object]:
    return {
        "id": f"{generation}-{document_id}",
        "knowledge_base_id": "kb",
        "generation": generation,
        "document_id": document_id,
        "version_id": "v1",
        "relative_path": f"{document_id}.txt",
        "file_name": f"{document_id}.txt",
        "extension": ".txt",
        "chunk_index": 0,
        "text": text,
        "embedding_text": text,
        "location": "Line 1",
        "heading": "",
        "vector": [0.5, 0.5],
    }


class HybridStoreTests(unittest.TestCase):
    def test_reset_index_removes_all_derived_search_data(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = HybridStore(directory)
            generation = store.begin_rebuild("kb-1")
            store.append_document_rows(
                [
                    {
                        "id": "chunk-1",
                        "knowledge_base_id": "kb-1",
                        "generation": generation,
                        "document_id": "doc-1",
                        "version_id": "v1",
                        "relative_path": "notes.txt",
                        "file_name": "notes.txt",
                        "extension": ".txt",
                        "chunk_index": 0,
                        "text": "hello",
                        "embedding_text": "hello",
                        "location": "Line 1",
                        "heading": "",
                        "vector": [0.1, 0.2],
                    }
                ]
            )
            store.commit_rebuild("kb-1", generation)

            store.reset_index()

            self.assertEqual(store.health()["chunks"], 0)
            self.assertEqual(store.health()["documents"], 0)
            self.assertEqual(store.active_generation("kb-1"), "default")
            store.close()

    @staticmethod
    def _cell(value: str, number: float) -> dict[str, object]:
        return {
            "sheet_name": "Pricing",
            "row_index": 2,
            "column_index": 2,
            "column_name": "Unit Price USD",
            "cell_address": "B2",
            "display_value": value,
            "raw_value": value,
            "value_type": "n",
            "numeric_value": number,
            "unit": "USD",
            "formula": "",
        }

    def test_neighbor_expansion_keeps_adjacent_document_chunks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = HybridStore(directory)
            rows = []
            for index, text in enumerate(["before", "match", "after"]):
                item = row("default", "doc", text)
                item["id"] = f"doc-{index}"
                item["chunk_index"] = index
                rows.append(item)
            store.index_document("kb", "default", "doc", "v1", "doc.txt", rows)

            expanded = store.expand_neighbors([rows[1]], radius=1, limit=3)

            self.assertEqual([item["text"] for item in expanded], ["before", "match", "after"])

    def test_rebuild_commit_and_abort_are_atomic(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = HybridStore(directory)
            store.index_document(
                "kb", "default", "old", "v1", "old.txt", [row("default", "old", "old")]
            )

            abandoned = store.begin_rebuild("kb")
            store.index_document(
                "kb",
                abandoned,
                "abandoned",
                "v1",
                "abandoned.txt",
                [row(abandoned, "abandoned", "no")],
            )
            store.abort_rebuild("kb", abandoned)
            self.assertEqual(store.active_generation("kb"), "default")
            self.assertEqual(store.health()["documents"], 1)

            replacement = store.begin_rebuild("kb")
            store.index_document(
                "kb",
                replacement,
                "new",
                "v1",
                "new.txt",
                [row(replacement, "new", "new")],
            )
            store.commit_rebuild("kb", replacement)

            health = store.health()
            self.assertEqual(store.active_generation("kb"), replacement)
            self.assertEqual(health["documents"], 1)
            self.assertEqual(health["chunks"], 1)

    def test_empty_generation_can_be_committed_atomically(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = HybridStore(directory)
            store.index_document(
                "kb", "default", "old", "v1", "old.txt", [row("default", "old", "old")]
            )

            empty = store.begin_rebuild("kb")
            store.commit_rebuild("kb", empty)

            self.assertEqual(store.active_generation("kb"), empty)
            self.assertEqual(store.sample(["kb"], 4), [])

    def test_clone_active_document_reuses_chunks_and_structured_rows(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = HybridStore(directory)
            store.index_document(
                "kb", "default", "old", "v1", "old.xlsx", [row("default", "old", "pricing")]
            )
            store.stage_spreadsheet_cells(
                "kb", "default", "old", "v1", "old.xlsx", [self._cell("100", 100)]
            )
            store.stage_document_metadata(
                "kb",
                "default",
                "old",
                "v1",
                "old.xlsx",
                {
                    "title": "Pricing",
                    "extension": ".xlsx",
                    "pathSegments": ["old.xlsx"],
                    "headings": ["Pricing"],
                    "entities": ["USD"],
                    "summary": "Pricing details.",
                    "sections": [],
                },
            )

            generation = store.begin_rebuild("kb")
            self.assertTrue(
                store.clone_active_document(
                    "kb", generation, "old", "new", "v1", "renamed.xlsx"
                )
            )
            store.commit_rebuild("kb", generation)

            self.assertEqual(store.sample(["kb"], 4)[0]["file_name"], "renamed.xlsx")
            structured = store.structured_rows(["kb"], "unit price", ["renamed.xlsx"])
            self.assertEqual(structured[0]["cells"][0]["value"], "100")

    def test_staged_document_rows_are_hidden_until_commit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = HybridStore(directory)
            store.index_document(
                "kb", "default", "doc", "v1", "doc.txt", [row("default", "doc", "old")]
            )
            staged = row("default", "doc", "new")
            staged["id"] = "staged"
            staged["version_id"] = "v2"
            store.prepare_document_version("kb", "default", "doc", "v2")
            store.append_document_rows([staged])

            active = store.sample(["kb"], 4)
            self.assertEqual([item["text"] for item in active], ["old"])

            store.commit_document_version("kb", "default", "doc", "v2", "doc.txt")
            active = store.sample(["kb"], 4)
            self.assertEqual([item["text"] for item in active], ["new"])

    def test_aborting_staged_rows_preserves_active_document(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = HybridStore(directory)
            store.index_document(
                "kb", "default", "doc", "v1", "doc.txt", [row("default", "doc", "old")]
            )
            staged = row("default", "doc", "new")
            staged["id"] = "staged"
            staged["version_id"] = "v2"
            store.append_document_rows([staged])
            store.abort_document_version("kb", "default", "doc", "v2")

            active = store.sample(["kb"], 4)
            self.assertEqual([item["text"] for item in active], ["old"])

    def test_typed_cells_follow_the_active_document_version(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = HybridStore(directory)
            store.index_document(
                "kb", "default", "doc", "v1", "pricing.xlsx", [row("default", "doc", "old")]
            )
            store.stage_spreadsheet_cells(
                "kb", "default", "doc", "v1", "pricing.xlsx", [self._cell("100", 100)]
            )
            store.stage_document_metadata(
                "kb",
                "default",
                "doc",
                "v1",
                "pricing.xlsx",
                {
                    "title": "H200 pricing",
                    "extension": ".xlsx",
                    "pathSegments": ["pricing.xlsx"],
                    "headings": ["Commercial"],
                    "entities": ["H200"],
                    "summary": "H200 commercial options.",
                    "sections": [
                        {
                            "heading": "Commercial",
                            "location": "Sheet Pricing",
                            "summary": "H200 unit pricing details.",
                        }
                    ],
                },
            )
            staged = row("default", "doc", "new")
            staged["id"] = "staged"
            staged["version_id"] = "v2"
            store.prepare_document_version("kb", "default", "doc", "v2")
            store.append_document_rows([staged])
            store.stage_spreadsheet_cells(
                "kb", "default", "doc", "v2", "pricing.xlsx", [self._cell("200", 200)]
            )

            before = store.structured_rows(["kb"], "unit price", ["pricing.xlsx"])
            self.assertEqual(before[0]["cells"][0]["value"], "100")
            self.assertEqual(store.metadata_matching_files(["kb"], "H200")[0]["file"], "pricing.xlsx")
            self.assertEqual(
                store.hierarchical_summaries(["kb"], "pricing")[0]["heading"], "Commercial"
            )

            store.commit_document_version("kb", "default", "doc", "v2", "pricing.xlsx")
            after = store.structured_rows(["kb"], "unit price", ["pricing.xlsx"])
            self.assertEqual(after[0]["cells"][0]["value"], "200")

    def test_source_catalog_and_structured_rows_preserve_sheet_scope(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = HybridStore(directory)
            store.index_document(
                "kb", "default", "doc", "v1", "Platform_Options.xlsx", [row("default", "doc", "data")]
            )
            pricing = self._cell("100", 100)
            management = {**self._cell("64 GB", 64), "sheet_name": "Rafay Mgmt Appliance"}
            store.stage_spreadsheet_cells(
                "kb", "default", "doc", "v1", "Platform_Options.xlsx", [pricing, management]
            )
            store.stage_document_metadata(
                "kb",
                "default",
                "doc",
                "v1",
                "Platform_Options.xlsx",
                {
                    "title": "Platform Options",
                    "extension": ".xlsx",
                    "pathSegments": ["Platform_Options.xlsx"],
                    "headings": ["Pricing", "Rafay Mgmt Appliance"],
                    "entities": ["Platform", "Rafay"],
                    "summary": "Rafay appliance options.",
                    "sections": [],
                },
            )

            catalog = store.active_source_catalog(["kb"])
            self.assertEqual(catalog[0]["file"], "Platform_Options.xlsx")
            self.assertEqual(
                catalog[0]["sheets"], ["Pricing", "Rafay Mgmt Appliance"]
            )
            selected = store.structured_rows(
                ["kb"],
                "memory configuration",
                ["Platform_Options.xlsx"],
                ["Rafay Mgmt Appliance"],
            )
            self.assertEqual({item["sheet"] for item in selected}, {"Rafay Mgmt Appliance"})


if __name__ == "__main__":
    unittest.main()
