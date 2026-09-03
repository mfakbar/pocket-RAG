from __future__ import annotations

import unittest

from pocketrag_backend.engine import (
    AMBIGUOUS,
    CROSS_DOCUMENT,
    DIRECT_LOOKUP,
    DOCUMENT_SUMMARY,
    PROCEDURE_CHECKLIST,
    SPREADSHEET_COMPARISON,
    _balance_by_file,
    _broad_query,
    _chunks_for_named_file,
    _confidence_score,
    _cover_major_sections,
    _diversify_by_section,
    _diversify_by_file,
    _exhaustive_query,
    _exact_spreadsheet_field,
    _named_files,
    _requested_file_references,
    _resolve_version_conflicts,
    _result_score,
    _retrieval_mode,
    _search_question,
    _source_scope,
    _topic_relevance_score,
    RagEngine,
)


class ResultScoreTests(unittest.TestCase):
    def test_topic_title_outscores_generic_neighboring_slide(self) -> None:
        question = "What are ACI load balancer design best practices?"
        focused = _topic_relevance_score(
            question,
            {"heading": "Load Balancer Design (LTM)", "text": "Use SNAT and route domains."},
        )
        generic = _topic_relevance_score(
            question,
            {"heading": "ACI Fabric Design", "text": "Service leaf for firewall and load balancer."},
        )
        self.assertGreater(focused, generic)

    def test_named_file_confidence_does_not_claim_answer_certainty(self) -> None:
        score = _confidence_score(
            'Summarize everything in "proposal.xlsx".',
            [{"file_name": "proposal.xlsx", "text": "One relevant row.", "_relevance_score": 1.0}],
            ["proposal.xlsx"],
        )
        self.assertGreaterEqual(score, 0.75)
        self.assertLessEqual(score, 0.9)

    def test_scope_normalizes_compact_capacity_and_core_sheet_names(self) -> None:
        scope = _source_scope(
            "Which configuration meets the customer 24-core 48TB HDD requirement?",
            [
                {
                    "file": "Customer Server.xlsx",
                    "title": "Customer Server",
                    "sheets": [
                        "Rackmount 24 Core + 20TB SSD",
                        "Rackmount 24core + 48TB HDD",
                    ],
                }
            ],
        )
        self.assertEqual(scope["sheets"], ["Rackmount 24core + 48TB HDD"])

    def test_explicit_file_resolves_compact_application_sheet_identifiers(self) -> None:
        scope = _source_scope(
            "Compare App1a and App2a in BI requirements.xlsx.",
            [
                {
                    "file": "BI requirements.xlsx",
                    "sheets": [
                        "App1a Server Requirement",
                        "App2a Server Requirement",
                        "App3a Server Requirement",
                    ],
                }
            ],
        )
        self.assertEqual(
            scope["sheets"],
            ["App1a Server Requirement", "App2a Server Requirement"],
        )

    def test_exact_quoted_sheet_wins_over_overlapping_capacity_identifier(self) -> None:
        scope = _source_scope(
            'In "options.xlsx" -> sheet "UCS C845 (8xH200)", find the highest price.',
            [
                {
                    "file": "options.xlsx",
                    "sheets": ["UCS-X (8xH200)", "UCS C845 (8xH200)"],
                }
            ],
        )
        self.assertEqual(scope["sheets"], ["UCS C845 (8xH200)"])

    def test_explicit_unique_sheet_shorthand_resolves_trailing_qualifier(self) -> None:
        scope = _source_scope(
            "What component has the longest lead time in "
            "AI_Pod_Options.xlsx, sheet UCS-X?",
            [
                {
                    "file": "AI_Pod_Options.xlsx",
                    "sheets": [
                        "UCS-X (8xH200)",
                        "UCS C845 (8xH200)",
                        "UCS C880 (8xB300)",
                    ],
                }
            ],
        )
        self.assertEqual(scope["sheets"], ["UCS-X (8xH200)"])

    def test_ambiguous_sheet_shorthand_does_not_select_multiple_tabs(self) -> None:
        scope = _source_scope(
            'In "options.xlsx", compare sheet UCS-X.',
            [
                {
                    "file": "options.xlsx",
                    "sheets": ["UCS-X (8xH200)", "UCS-X (8xB300)"],
                }
            ],
        )
        self.assertEqual(scope["sheets"], [])

    def test_boq_word_selects_the_boq_sheet_with_other_named_sheets(self) -> None:
        scope = _source_scope(
            'Using "requirements.xlsx", combine the BOQ quantities with App1a.',
            [
                {
                    "file": "requirements.xlsx",
                    "sheets": ["BOQ", "App1a Server Requirement"],
                }
            ],
        )
        self.assertEqual(scope["sheets"], ["BOQ", "App1a Server Requirement"])

    @staticmethod
    def _engine(chunks: list[dict[str, object]], files: list[str]):
        class Store:
            def __init__(self) -> None:
                self.query_args = None
                self.query_calls = 0

            def active_file_names(self, _ids):
                return files

            def query(self, *args):
                self.query_args = args
                self.query_calls += 1
                return chunks

        class Embedder:
            def embed(self, texts, **_kwargs):
                return [[0.1, 0.2] for _ in texts]

        class Reranker:
            def __init__(self) -> None:
                self.calls = 0

            def rerank(self, _question, candidates, _limit):
                self.calls += 1
                return candidates, {"rerankerApplied": True, "rerankLatencyMs": 1.0}

        engine = RagEngine.__new__(RagEngine)
        engine.store = Store()
        engine.embedder = Embedder()
        engine.reranker = Reranker()
        return engine

    @staticmethod
    def _chunk(file_name: str, location: str, index: int) -> dict[str, object]:
        return {
            "text": f"Evidence {index} for {file_name}",
            "file_name": file_name,
            "relative_path": file_name,
            "location": location,
            "heading": "",
            "knowledge_base_id": "kb",
            "_relevance_score": 0.9 - index / 100,
        }

    def test_reranker_score_does_not_evaluate_null_distance(self) -> None:
        self.assertEqual(_result_score({"_relevance_score": 0.75, "_distance": None}), 0.75)

    def test_vector_distance_is_converted_to_similarity(self) -> None:
        self.assertAlmostEqual(_result_score({"_distance": 0.2}), 0.8)

    def test_explicit_file_name_filters_other_documents(self) -> None:
        chunks = [
            {"file_name": "target.xlsx", "text": "relevant"},
            {"file_name": "other.xlsx", "text": "other"},
        ]
        self.assertEqual(
            _chunks_for_named_file('Summarize "target.xlsx".', chunks),
            [chunks[0]],
        )

    def test_query_without_file_name_keeps_all_candidates(self) -> None:
        chunks = [
            {"file_name": "one.pdf", "text": "first"},
            {"file_name": "two.pdf", "text": "second"},
        ]
        self.assertIs(_chunks_for_named_file("Compare the available options.", chunks), chunks)

    def test_broad_queries_expand_retrieval_scope(self) -> None:
        self.assertTrue(_broad_query("Prepare an executive summary of the selected files."))
        self.assertTrue(_broad_query("Prepare a concise checklist grouped by topic."))
        self.assertTrue(_broad_query("List each configuration and its lead time."))
        self.assertTrue(_broad_query("Identify quantities, prices, totals, and missing information."))
        self.assertTrue(_broad_query("What are the main architecture and operational differentiators?"))
        self.assertTrue(_broad_query("What are the software stacks in the validated design?"))
        self.assertTrue(_broad_query("Top 10 unique competitive differentiators of Cisco ACI"))
        self.assertFalse(_broad_query("What is the listed price for UCS C880?"))
        self.assertTrue(_exhaustive_query("List each configuration and its lead time."))
        self.assertTrue(_exhaustive_query("Prepare a checklist grouped by topic."))
        self.assertTrue(_exhaustive_query("Top 10 unique competitive differentiators of Cisco ACI"))
        self.assertFalse(_exhaustive_query("Summarize the main differentiators."))

    def test_named_file_is_detected_before_search(self) -> None:
        files = ["target.xlsx", "other.xlsx"]
        self.assertEqual(_named_files('Compare "target.xlsx".', files), ["target.xlsx"])
        self.assertEqual(_search_question('Compare "target.xlsx" by price.', ["target.xlsx"]), "Compare by price")

    def test_named_file_matching_tolerates_typographic_separators(self) -> None:
        files = ["Commercial Proposal_v2.xlsx", "other.xlsx"]
        self.assertEqual(
            _named_files("Find the price in Commercial-Proposal v2.xlsx.", files),
            ["Commercial Proposal_v2.xlsx"],
        )
        self.assertEqual(
            _requested_file_references('Find the price in "Commercial Proposal_v2.xlsx".'),
            ["Commercial Proposal_v2.xlsx"],
        )

    def test_project_and_sheet_aliases_resolve_management_appliance(self) -> None:
        catalog = [
            {
                "file": "ExampleCorp_AI_Pod_Options.xlsx",
                "title": "ExampleCorp AI Pods",
                "pathSegments": "ExampleCorp",
                "headings": "Rafay Mgmt Appliance",
                "entities": "Rafay",
                "sheets": ["UCS-X (8xH200)", "Rafay Mgmt Appliance"],
            },
            {
                "file": "ExampleCorp_Control_Plane.xlsx",
                "title": "ExampleCorp control plane",
                "pathSegments": "ExampleCorp",
                "headings": "Control Plane",
                "entities": "OpenShift",
                "sheets": ["Control Plane"],
            },
        ]
        for question in (
            "Summarize server specifications for Rafay management appliance in ExampleCorp.",
            "Summarize server specifications for Rafay mgmt appliance in ExampleCorp.",
        ):
            scope = _source_scope(question, catalog)
            self.assertEqual(scope["files"], ["ExampleCorp_AI_Pod_Options.xlsx"])
            self.assertEqual(scope["sheets"], ["Rafay Mgmt Appliance"])
            self.assertFalse(scope["ambiguous"])

    def test_project_reference_resolves_unique_agency_workbook(self) -> None:
        catalog = [
            {"file": "BoQ - ExampleAgency - Proposal.xlsx", "sheets": ["Server"]},
            {"file": "ExampleCorp_AI_Pod_Options.xlsx", "sheets": ["UCS-X"]},
            {"file": "GPU_Use_Cases.xlsx", "sheets": ["Price Estimate"]},
        ]
        scope = _source_scope(
            "What components are proposed for the ExampleAgency server BoQ?", catalog
        )
        self.assertEqual(scope["files"], ["BoQ - ExampleAgency - Proposal.xlsx"])
        self.assertFalse(scope["ambiguous"])

    def test_explicit_filename_takes_precedence_over_conflicting_project_terms(self) -> None:
        catalog = [
            {"file": "ExampleCorp_AI_Pod_Options.xlsx", "sheets": []},
            {"file": "BoQ - ExampleAgency - Proposal.xlsx", "sheets": []},
        ]
        scope = _source_scope(
            'Use "BoQ - ExampleAgency - Proposal.xlsx" even if the notes mention ExampleCorp.', catalog
        )
        self.assertEqual(scope["files"], ["BoQ - ExampleAgency - Proposal.xlsx"])
        self.assertEqual(scope["reason"], "explicit_filename")

    def test_close_source_matches_request_clarification(self) -> None:
        catalog = [
            {"file": "Customer proposal v1.xlsx", "sheets": []},
            {"file": "Customer proposal v2.xlsx", "sheets": []},
        ]
        scope = _source_scope("Summarize the customer proposal.", catalog)
        self.assertTrue(scope["ambiguous"])
        self.assertEqual(len(scope["candidates"]), 2)

    def test_version_conflicts_prefer_newest_marker_unless_user_names_a_version(self) -> None:
        files = ["Proposal v1.xlsx", "Proposal v2.xlsx"]
        conflicts, excluded = _resolve_version_conflicts(files, [])
        self.assertEqual(conflicts[0]["selectedFile"], "Proposal v2.xlsx")
        self.assertIn("proposal v1.xlsx", excluded)

        conflicts, excluded = _resolve_version_conflicts(files, ["Proposal v1.xlsx"])
        self.assertEqual(conflicts[0]["resolution"], "explicit_file")
        self.assertEqual(conflicts[0]["selectedFile"], "Proposal v1.xlsx")
        self.assertFalse(excluded)

    def test_broad_results_are_diversified_by_file(self) -> None:
        chunks = [
            {"knowledge_base_id": "one", "file_name": "a.pdf", "text": "a1"},
            {"knowledge_base_id": "one", "file_name": "a.pdf", "text": "a2"},
            {"knowledge_base_id": "one", "file_name": "b.pdf", "text": "b1"},
        ]
        selected = _diversify_by_file(chunks, 2)
        self.assertEqual([item["file_name"] for item in selected], ["a.pdf", "b.pdf"])

    def test_broad_results_are_diversified_by_section(self) -> None:
        chunks = [
            {"knowledge_base_id": "one", "file_name": "a.pdf", "location": "Page 1"},
            {"knowledge_base_id": "one", "file_name": "a.pdf", "location": "Page 1"},
            {"knowledge_base_id": "one", "file_name": "a.pdf", "location": "Page 2"},
        ]
        selected = _diversify_by_section(chunks, 2)
        self.assertEqual([item["location"] for item in selected], ["Page 1", "Page 2"])

    def test_retrieval_modes_match_question_shape(self) -> None:
        self.assertEqual(_retrieval_mode('What is listed in "one.pdf"?', ["one.pdf"]), DIRECT_LOOKUP)
        self.assertEqual(_retrieval_mode('Summarize "one.pdf".', ["one.pdf"]), DOCUMENT_SUMMARY)
        self.assertEqual(
            _retrieval_mode(
                "What are the software stacks in Cisco Secure AI Factory validated design?",
                ["Cisco Secure AI Factory with NVIDIA BDM.PPTX"],
            ),
            DOCUMENT_SUMMARY,
        )
        self.assertEqual(
            _retrieval_mode(
                "Top 10 unique competitive differentiators of Cisco ACI",
                ["aci-competitive.pdf"],
            ),
            DOCUMENT_SUMMARY,
        )
        self.assertEqual(
            _retrieval_mode('Compare quantities in sheet Hardware of "one.xlsx".', ["one.xlsx"]),
            SPREADSHEET_COMPARISON,
        )

    def test_exact_spreadsheet_fields_route_without_an_explicit_file_extension(self) -> None:
        self.assertTrue(_exact_spreadsheet_field("What is the unit price of NVIDIA H200?"))
        self.assertEqual(
            _retrieval_mode("What is the unit price of NVIDIA H200?", []),
            SPREADSHEET_COMPARISON,
        )
        self.assertEqual(_retrieval_mode('Give the complete procedure in "one.pdf".', ["one.pdf"]), PROCEDURE_CHECKLIST)
        self.assertEqual(
            _retrieval_mode('Compare "one.pdf" and "two.pdf".', ["one.pdf", "two.pdf"]),
            CROSS_DOCUMENT,
        )
        self.assertEqual(_retrieval_mode('Tell me what matters here.', []), AMBIGUOUS)

    def test_summary_coverage_uses_each_slide_group_before_repeats(self) -> None:
        chunks = [
            {"knowledge_base_id": "one", "file_name": "a.pptx", "location": "Slide 1"},
            {"knowledge_base_id": "one", "file_name": "a.pptx", "location": "Slide 2"},
            {"knowledge_base_id": "one", "file_name": "a.pptx", "location": "Slide 5"},
        ]
        selected = _cover_major_sections(chunks, 2)
        self.assertEqual([item["location"] for item in selected], ["Slide 1", "Slide 5"])

    def test_cross_document_results_are_round_robin_balanced(self) -> None:
        chunks = [
            {"knowledge_base_id": "one", "file_name": "a.pdf", "text": "a1"},
            {"knowledge_base_id": "one", "file_name": "a.pdf", "text": "a2"},
            {"knowledge_base_id": "one", "file_name": "b.pdf", "text": "b1"},
            {"knowledge_base_id": "one", "file_name": "b.pdf", "text": "b2"},
        ]
        selected = _balance_by_file(chunks, 4)
        self.assertEqual([item["text"] for item in selected], ["a1", "b1", "a2", "b2"])

    def test_direct_lookup_uses_four_to_six_passages_and_skips_reranker(self) -> None:
        chunks = [self._chunk("one.pdf", f"Page {index}", index) for index in range(1, 9)]
        engine = self._engine(chunks, ["one.pdf"])
        result = engine.query(
            {
                "query": 'What is the exact value in "one.pdf"?',
                "knowledgeBaseIds": ["kb"],
                "settings": {"topK": 4, "improveDocumentMatching": True},
            }
        )
        self.assertEqual(result["metrics"]["retrievalMode"], DIRECT_LOOKUP)
        self.assertEqual(len(result["chunks"]), 4)
        self.assertEqual(engine.reranker.calls, 0)

    def test_named_spreadsheet_discards_hard_negative_files_defensively(self) -> None:
        chunks = [
            self._chunk("target.xlsx", "Sheet Pricing, A1:C10", 1),
            self._chunk("hard-negative.xlsx", "Sheet Pricing, A1:C10", 2),
        ]
        engine = self._engine(chunks, ["target.xlsx", "hard-negative.xlsx"])
        result = engine.query(
            {
                "query": 'What is the unit price in "target.xlsx"?',
                "knowledgeBaseIds": ["kb"],
                "settings": {"topK": 4, "improveDocumentMatching": True},
            }
        )
        self.assertEqual([item["file"] for item in result["chunks"]], ["target.xlsx"])
        self.assertEqual(result["metrics"]["namedFiles"], ["target.xlsx"])

    def test_unknown_requested_file_returns_no_cross_document_results(self) -> None:
        chunks = [self._chunk("other.xlsx", "Sheet Pricing, A1:C10", 1)]
        engine = self._engine(chunks, ["other.xlsx"])
        result = engine.query(
            {
                "query": 'What is the unit price in "missing.xlsx"?',
                "knowledgeBaseIds": ["kb"],
                "settings": {"topK": 4},
            }
        )
        self.assertEqual(result["chunks"], [])
        self.assertEqual(result["metrics"]["requestedFileNotFound"], ["missing.xlsx"])

    def test_ambiguous_question_skips_reranker_when_disabled(self) -> None:
        chunks = [self._chunk("one.pdf", "Page 1", 1)]
        engine = self._engine(chunks, ["one.pdf"])
        result = engine.query(
            {
                "query": "Tell me what matters here.",
                "knowledgeBaseIds": ["kb"],
                "settings": {"topK": 4, "improveDocumentMatching": False},
            }
        )
        self.assertEqual(result["metrics"]["retrievalMode"], AMBIGUOUS)
        self.assertEqual(engine.reranker.calls, 0)

    def test_ambiguous_question_uses_reranker_when_enabled(self) -> None:
        chunks = [self._chunk("one.pdf", "Page 1", 1)]
        engine = self._engine(chunks, ["one.pdf"])
        result = engine.query(
            {
                "query": "Tell me what matters here.",
                "knowledgeBaseIds": ["kb"],
                "settings": {"topK": 4, "improveDocumentMatching": True},
            }
        )
        self.assertEqual(result["metrics"]["retrievalMode"], AMBIGUOUS)
        self.assertEqual(engine.reranker.calls, 1)

    def test_subqueries_are_embedded_in_one_batch_and_merged(self) -> None:
        chunks = [self._chunk("one.pdf", "Page 1", 1)]
        engine = self._engine(chunks, ["one.pdf"])
        result = engine.query(
            {
                "query": "Compare benefits and risks.",
                "subqueries": ["Find benefits.", "Find risks."],
                "knowledgeBaseIds": ["kb"],
                "settings": {"topK": 4},
            }
        )
        self.assertEqual(engine.store.query_calls, 3)
        self.assertEqual(result["metrics"]["subqueryCount"], 2)
        self.assertEqual(len(result["chunks"]), 1)

    def test_procedure_expands_the_named_document(self) -> None:
        chunks = [self._chunk("one.pdf", "Page 1", 1)]
        engine = self._engine(chunks, ["one.pdf"])
        engine.query(
            {
                "query": 'Give the complete procedure in "one.pdf".',
                "knowledgeBaseIds": ["kb"],
                "settings": {"topK": 4},
            }
        )
        self.assertTrue(engine.store.query_args[6])

    def test_spreadsheet_mode_keeps_all_rows_from_requested_sheets(self) -> None:
        chunks = [
            self._chunk("one.xlsx", "Sheet Hardware, A1:C20", 1),
            self._chunk("one.xlsx", "Sheet Hardware, A21:C40", 2),
            self._chunk("one.xlsx", "Sheet Licensing, A1:C20", 3),
        ]
        engine = self._engine(chunks, ["one.xlsx"])
        result = engine.query(
            {
                "query": 'List quantities in Sheet Hardware of "one.xlsx".',
                "knowledgeBaseIds": ["kb"],
                "settings": {"topK": 4},
            }
        )
        self.assertEqual(result["metrics"]["retrievalMode"], SPREADSHEET_COMPARISON)
        self.assertEqual(len(result["chunks"]), 2)
        self.assertTrue(all("Sheet Hardware" in item["location"] for item in result["chunks"]))


if __name__ == "__main__":
    unittest.main()
