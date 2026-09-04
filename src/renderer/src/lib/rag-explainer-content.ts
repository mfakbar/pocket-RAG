export type RagStageId =
  | 'local-folder'
  | 'extract'
  | 'chunk'
  | 'document-embedding'
  | 'vector-database'
  | 'user-prompt'
  | 'query-embedding'
  | 'hybrid-search'
  | 'reranker'
  | 'grounded-context'
  | 'output-tokens'
  | 'verify-citations'

export type RagStagePhase = 'prepare' | 'answer'

export type RagExplainerStage = {
  id: RagStageId
  phase: RagStagePhase
  number: number
  title: string
  shortTitle: string
  summary: string
  detail: string
  inputLabel: string
  outputLabel: string
  keyIdea: string
  optional?: boolean
}

export type GenerationInputId = 'answer-rules' | 'user-context' | 'grounded-evidence'

export type GenerationInput = {
  id: GenerationInputId
  title: string
  source: string
  description: string
}

export type RagJourneyRelationId = 'embedding-space' | 'search-index' | 'source-provenance'

export type RagJourneyRelation = {
  id: RagJourneyRelationId
  kind: 'shared' | 'data' | 'provenance'
  fromLabel: string
  toLabel: string
  connectorLabel: string
  description: string
  fromStageIds: RagStageId[]
  toStageIds: RagStageId[]
}

export const GENERATION_INPUTS: GenerationInput[] = [
  {
    id: 'answer-rules',
    title: 'Answer rules',
    source: 'Created by RavnDock',
    description:
      'Instructions to use local evidence, cite factual claims, preserve exact values and avoid unsupported facts.'
  },
  {
    id: 'user-context',
    title: 'User context',
    source: 'Output of Question',
    description:
      'The current question plus relevant recent messages when they are needed to understand a follow-up.'
  },
  {
    id: 'grounded-evidence',
    title: 'Grounded evidence',
    source: 'Output of Prepare evidence',
    description:
      'The selected local passages labeled [1], [2] and so on, with their source locations.'
  }
]

export const RAG_JOURNEY_RELATIONS: RagJourneyRelation[] = [
  {
    id: 'embedding-space',
    kind: 'shared',
    fromLabel: 'Embed documents',
    toLabel: 'Embed query',
    connectorLabel: 'Same model and vector space',
    description:
      'Stage 2 uses the same local embedding model so the question and stored passages can be compared by meaning.',
    fromStageIds: ['document-embedding'],
    toStageIds: ['query-embedding']
  },
  {
    id: 'search-index',
    kind: 'data',
    fromLabel: 'Vector DB',
    toLabel: 'Retrieve',
    connectorLabel: 'Stored searchable index',
    description:
      'Retrieve searches the chunks, vectors, keywords and source metadata prepared in Stage 1.',
    fromStageIds: ['vector-database'],
    toStageIds: ['hybrid-search']
  },
  {
    id: 'source-provenance',
    kind: 'provenance',
    fromLabel: 'Read + Chunk',
    toLabel: 'Prepare evidence → Verify',
    connectorLabel: 'Source locations travel with passages',
    description:
      'Page, slide, sheet, cell, heading and line locations stay attached through search, then become traceable citations.',
    fromStageIds: ['extract', 'chunk'],
    toStageIds: ['grounded-context', 'verify-citations']
  }
]

export function relationsForStage(id: RagStageId): RagJourneyRelation[] {
  return RAG_JOURNEY_RELATIONS.filter((relation) =>
    [...relation.fromStageIds, ...relation.toStageIds].includes(id)
  )
}

export function relatedStageIds(id: RagStageId): RagStageId[] {
  const related = new Set<RagStageId>()
  for (const relation of relationsForStage(id)) {
    for (const stageId of [...relation.fromStageIds, ...relation.toStageIds]) {
      if (stageId !== id) related.add(stageId)
    }
  }
  return [...related]
}

export const RAG_EXPLAINER_STAGES: RagExplainerStage[] = [
  {
    id: 'local-folder',
    phase: 'prepare',
    number: 1,
    title: 'Local knowledge folder',
    shortTitle: 'Local files',
    summary: 'You choose which private files belong to this knowledge base.',
    detail:
      'RavnDock scans supported documents on this Mac. The original files stay in place and are never changed by indexing.',
    inputLabel: 'PDF, Word, PowerPoint, Excel, CSV, Markdown, text and images',
    outputLabel: 'A local file manifest with names, types and change fingerprints',
    keyIdea: 'The folder is the source of truth.'
  },
  {
    id: 'extract',
    phase: 'prepare',
    number: 2,
    title: 'Read and preserve structure',
    shortTitle: 'Read files',
    summary: 'Text, tables, headings and source locations are extracted.',
    detail:
      'Each file type has a local reader. Scanned pages can use OCR. Page, slide, sheet, cell, heading or line locations travel with the extracted content.',
    inputLabel: 'A source document such as Security_Guide.pdf',
    outputLabel: 'Structured text plus precise source metadata',
    keyIdea: 'Location metadata is what makes later citations traceable.'
  },
  {
    id: 'chunk',
    phase: 'prepare',
    number: 3,
    title: 'Split into useful sections',
    shortTitle: 'Chunk',
    summary: 'Long files become smaller, overlapping passages.',
    detail:
      'Smaller sections are easier to retrieve accurately. A little overlap preserves ideas that cross a boundary, while headings and table headers keep each section understandable.',
    inputLabel: 'Structured document text',
    outputLabel: 'Searchable chunks with source locations and overlap',
    keyIdea: 'A chunk is a passage, not a whole copy of the file.'
  },
  {
    id: 'document-embedding',
    phase: 'prepare',
    number: 4,
    title: 'Create document embeddings',
    shortTitle: 'Embed',
    summary: 'A local model converts each passage into numbers that represent meaning.',
    detail:
      'Semantically similar passages land near one another in mathematical space even when they use different words. The displayed vector is shortened for teaching; real vectors contain many more values.',
    inputLabel: 'One text chunk',
    outputLabel: 'A high-dimensional numeric vector',
    keyIdea: 'Embeddings store meaning for comparison, not readable prose.'
  },
  {
    id: 'vector-database',
    phase: 'prepare',
    number: 5,
    title: 'Store the searchable index',
    shortTitle: 'Vector DB',
    summary: 'Passages, vectors and citation metadata are stored together in LanceDB.',
    detail:
      'The vector database is a local table built from derived search data. It connects every embedding back to its readable passage and original source location.',
    inputLabel: 'Chunks, vectors and metadata',
    outputLabel: 'A local searchable index',
    keyIdea:
      'The Retrieve step searches this index. The database does not replace the original documents.'
  },
  {
    id: 'user-prompt',
    phase: 'answer',
    number: 1,
    title: 'Understand the question',
    shortTitle: 'Question',
    summary: 'The app keeps the user request intact and identifies its likely scope.',
    detail:
      'The question is tokenized for model processing. RavnDock also looks for named files, sheets and query intent so a direct lookup stays narrow while a summary can search more broadly.',
    inputLabel: 'The user prompt',
    outputLabel: 'Tokens, scope and retrieval mode',
    keyIdea: 'Tokens are small pieces of text a model can process.'
  },
  {
    id: 'query-embedding',
    phase: 'answer',
    number: 2,
    title: 'Embed the question',
    shortTitle: 'Embed query',
    summary: 'The same local embedding model converts the question into a vector.',
    detail:
      'Because document passages and the question share the same embedding space, the database can compare their meaning with cosine similarity.',
    inputLabel: 'The retrieval question',
    outputLabel: 'A query vector compatible with the document vectors',
    keyIdea: 'Changing the embedding model requires rebuilding the derived index.'
  },
  {
    id: 'hybrid-search',
    phase: 'answer',
    number: 3,
    title: 'Search by meaning and keywords',
    shortTitle: 'Retrieve',
    summary: 'Vector similarity and exact-term search find candidate passages.',
    detail:
      'Hybrid retrieval is useful when a question mixes concepts with exact product names, filenames or numbers. The app filters to the active knowledge base and any named source scope.',
    inputLabel: 'Question text, query vector, source scope and the local searchable index',
    outputLabel: 'Candidate passages ranked for relevance, not yet accepted as verified evidence',
    keyIdea: 'Retrieval finds evidence; it does not write the answer.'
  },
  {
    id: 'reranker',
    phase: 'answer',
    number: 4,
    title: 'Rerank ambiguous matches',
    shortTitle: 'Rerank',
    summary:
      'When enabled and useful, a local reranker reads the question and candidates together.',
    detail:
      'The reranker can promote the passage that answers the question most directly. RavnDock skips it for fast direct lookups, full-document mode and other cases where it is not applicable.',
    inputLabel: 'Question plus retrieved candidates',
    outputLabel: 'A more focused passage order',
    keyIdea: 'This is an optional quality pass, not a second database search.',
    optional: true
  },
  {
    id: 'grounded-context',
    phase: 'answer',
    number: 5,
    title: 'Prepare evidence for the model',
    shortTitle: 'Prepare evidence',
    summary: 'The strongest passages become a compact, traceable evidence package.',
    detail:
      'RavnDock balances relevance, coverage and the model context budget. Sensitive fields are redacted, and each selected passage receives a source label such as [1]. This produces grounded evidence; it does not create the answer rules.',
    inputLabel: 'Retrieved passages after optional reranking, plus source metadata',
    outputLabel: 'Grounded evidence: selected passages labeled [1], [2] and so on',
    keyIdea: 'This step prepares the facts. RavnDock separately provides rules for using them.'
  },
  {
    id: 'output-tokens',
    phase: 'answer',
    number: 6,
    title: 'Generate output tokens',
    shortTitle: 'Generate',
    summary: 'The local chat model writes a draft answer one token at a time.',
    detail:
      'RavnDock combines three inputs for the local model: answer rules it creates, user context from the Question step and grounded evidence from Prepare evidence. Tokens stream into the chat as they are generated.',
    inputLabel: 'Answer rules, user context and grounded evidence',
    outputLabel: 'A streamed draft answer with citation markers',
    keyIdea: 'Rules say how to answer; grounded evidence supplies the facts and citations.'
  },
  {
    id: 'verify-citations',
    phase: 'answer',
    number: 7,
    title: 'Check sources and deliver',
    shortTitle: 'Verify',
    summary: 'The draft is checked against the retrieved passages before the final answer settles.',
    detail:
      'RavnDock removes invalid citation numbers, checks factual support and preserves exact source values. If a draft is not grounded well enough, the app can replace it with a safer source-supported answer.',
    inputLabel: 'The streamed draft, grounded evidence and citation map',
    outputLabel: 'The final answer plus clickable source citations',
    keyIdea: 'A fluent draft is not accepted as proof by itself.'
  }
]

export function stagesForPhase(phase: RagStagePhase): RagExplainerStage[] {
  return RAG_EXPLAINER_STAGES.filter((stage) => stage.phase === phase)
}

export function getRagExplainerStage(id: RagStageId): RagExplainerStage {
  const stage = RAG_EXPLAINER_STAGES.find((candidate) => candidate.id === id)
  if (!stage) throw new Error(`Unknown RAG explainer stage: ${id}`)
  return stage
}

export function ragStageJourneyLabel(stage: RagExplainerStage): string {
  const stageLabel = stage.phase === 'prepare' ? 'Stage 1' : 'Stage 2'
  return `${stageLabel} · Step ${stage.number} · ${stage.shortTitle}`
}
