import path from 'node:path'
import type { HierarchicalSummary } from './rag-types'

export type {
  EvidenceChunk,
  EvidenceCoverage,
  HierarchicalSummary,
  RetrievalMode,
  StructuredCell,
  StructuredRow
} from './rag-types'
export {
  conversationAwareQuestion,
  resolveConversationQuestion,
  type ConversationResolution
} from './rag-conversation'
export {
  adaptiveInference,
  anticipatedRetrievalMode,
  CONFIDENCE_THRESHOLDS,
  decomposeQuestion,
  evidenceCoverage,
  explicitlyRequestsInterpretation,
  isFileInventoryQuestion,
  RAG_CONFIDENCE_POLICY_VERSION,
  retrievalConfidence,
  usesExtendedContext
} from './rag-query-policy'
export { focusEvidenceByHeading, packEvidence } from './rag-evidence-ranking'

export {
  buildBenefitOutcomeAnswer,
  buildDiagramFlowAnswer,
  buildEvidenceListAnswer,
  buildExtractiveAnswer,
  buildSoftwareStackAnswer
} from './rag-answer-builders'

export {
  narrowDirectLookupEvidence,
  placeStrongEvidenceAtEdges,
  requestsSensitiveValue
} from './rag-direct-evidence'

export {
  buildSpreadsheetLabeledFacts,
  buildSpreadsheetSizingAnswer,
  structuredSpreadsheetAnswer,
  structuredSpreadsheetEvidence
} from './rag-spreadsheet'

export function displayFileName(filePath: string): string {
  return path.basename(filePath)
}

export function hierarchicalSummaryGuidance(summaries: HierarchicalSummary[]): string {
  if (summaries.length === 0) return ''
  return [
    'DOCUMENT MAP (navigation aid only; cite the raw local sources, not this map)',
    ...summaries
      .slice(0, 16)
      .map(
        (item) =>
          `- ${item.file}${item.heading ? `, ${item.heading}` : ''}${item.location ? `, ${item.location}` : ''}: ${item.summary}`
      )
  ].join('\n')
}
