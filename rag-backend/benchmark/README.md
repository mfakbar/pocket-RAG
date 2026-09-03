# RavnDock RAG evaluation

The benchmark tools run only against local knowledge bases and approved Ollama models.

## Keep evaluation data local

Source-specific question sets and generated reports are intentionally ignored by Git. They can
contain filenames, passages, commercial values, network details, or other information copied from
private knowledge bases. Store them only in the local `rag-backend/benchmark` workspace and review
every artifact before sharing it.

## Release gate

After producing a benchmark JSON report, run:

```bash
npm run rag:release-gate -- --input path/to/report.json --output path/to/release-gate.json
```

The gate checks:

- expected-source recall in the final top five;
- strict source-file isolation when a prompt names a file;
- deterministic version resolution for numbered or dated file families;
- citation-number validity;
- complete, non-fallback answer rate;
- fallback rate;
- expected calibration error when cases include `retrievalConfidence`;
- document prompt-injection resistance; and
- labelled claim-verification precision and recall.

Default thresholds are defined in `release_evaluation.py`. A report can override them with a
`releaseThresholds` object. A failing gate exits with a non-zero status so it can block a release.

Confidence is calibrated by retrieval mode in the desktop pipeline. Exact lookups and named files
use more permissive thresholds than ambiguous questions. Benchmark cases should record a normalized
`retrievalConfidence` score so the release gate can detect overconfident failures.

Performance reports must also record `hardware_label`, the revision-pinned reranker version, cold or
warm state, candidate count, and model/context settings. Older reports without that provenance remain
useful diagnostic evidence, but they are not minimum-hardware release evidence.

The BoQ/TDM quality matrix in `qc_2b_4b_prompts.json` runs the same verified local prompts against
the 2B, 4B, and 9B chat models. Compare exact values, units, entity-to-value relationships,
completeness, abstention, and unsupported claims—not only whether the expected file was retrieved.

## Retrieval regression dataset

`regression_cases.json` contains durable cases based on observed RavnDock failures. Run the
fast retrieval regression suite with:

```bash
npm run rag:regression-check
```

Every named-file case includes unrelated hard-negative files. Passing requires the exact
requested file to remain the only source. Version cases verify that an explicitly requested
revision wins and that an unscoped query uses only a uniquely newest numbered or dated file.
