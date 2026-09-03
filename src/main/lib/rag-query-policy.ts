import type { InferenceSettings } from '../../shared/contracts'
import { queryTerms } from './rag-terms'
import type { EvidenceChunk, EvidenceCoverage, RetrievalMode, StructuredRow } from './rag-types'

const EVIDENCE_CATEGORIES: Array<{ name: string; request: RegExp; evidence: RegExp }> = [
  {
    name: 'configuration',
    request: /\bconfigurations?\b/i,
    evidence: /\bconfiguration|model|server|item\b/i
  },
  {
    name: 'quantity',
    request: /\bquantit(?:y|ies)|\bqty\b/i,
    evidence: /\bquantit(?:y|ies)|\bqty\b/i
  },
  {
    name: 'lead time',
    request: /\blead times?|delivery\b/i,
    evidence: /\blead times?|delivery|days?|weeks?|months?\b/i
  },
  {
    name: 'price or cost',
    request: /\bprices?|costs?|commercial\b/i,
    evidence: /\bprices?|costs?|usd|idr|[$€£]\b/i
  },
  { name: 'total', request: /\btotals?|sum\b/i, evidence: /\btotal|quantity|qty|unit price\b/i },
  { name: 'memory', request: /\bmemory|ram\b/i, evidence: /\bmemory|ram|gb|tb\b/i },
  {
    name: 'benefits',
    request: /\bbenefits?|advantages?\b/i,
    evidence: /\bbenefits?|advantages?|improves?|reduces?\b/i
  },
  {
    name: 'drawbacks',
    request: /\bdrawbacks?|disadvantages?\b/i,
    evidence: /\bdrawbacks?|disadvantages?|limitations?|constraints?\b/i
  },
  {
    name: 'risks',
    request: /\brisks?|challenges?\b/i,
    evidence: /\brisks?|challenges?|threats?|issues?\b/i
  },
  {
    name: 'procedure',
    request: /\bprocedure|checklist|steps?|workflow\b/i,
    evidence: /\bprocedure|steps?|workflow|first|next|then\b/i
  },
  {
    name: 'timeline',
    request: /\btimeline|dates?|schedule\b/i,
    evidence: /\btimeline|schedule|date|day|week|month|year\b/i
  }
]

export function explicitlyRequestsInterpretation(question: string): boolean {
  return /\b(?:what do you think|your (?:view|opinion)|interpret(?:ation)?|what does .* mean to you|themes? do you see|analyse the (?:poem|story|writing)|analyze the (?:poem|story|writing))\b/i.test(
    question
  )
}

export function isFileInventoryQuestion(question: string): boolean {
  return (
    /\b(?:what|which|list|show)\b.*\b(?:documents?|files?)\b.*\b(?:have|available|indexed|synced|knowledge base)\b/i.test(
      question
    ) || /\bwhat (?:documents?|files?) do you have\b/i.test(question)
  )
}

export function usesExtendedContext(mode: RetrievalMode, question: string): boolean {
  return (
    ['document_summary', 'procedure_checklist', 'cross_document'].includes(mode) ||
    (mode === 'spreadsheet_comparison' &&
      /\b(?:all|each|every|compare|comparison|maximum|max|minimum|min|highest|lowest|longest|total|sum|across|full|complete|exhaustive)\b/i.test(
        question
      ))
  )
}

export function anticipatedRetrievalMode(question: string): RetrievalMode {
  if (
    /\b(?:xlsx|xls|csv|sheet|cell|row|column|unit prices?|prices?|costs?|lead times?|quantity|quantities|qty|memory|ram|total|sum)\b/i.test(
      question
    )
  ) {
    return 'spreadsheet_comparison'
  }
  if (/\b(?:summari[sz]e|overview|executive brief|main points|key themes)\b/i.test(question)) {
    return 'document_summary'
  }
  if (
    /\bsoftware stacks?\b|\btop\s+\d+\b|\b(?:unique|main|key|competitive)\b.*\bdifferentiators?\b|\b(?:benefits|business outcomes|customer outcomes)\b/i.test(
      question
    )
  ) {
    return 'document_summary'
  }
  if (/\b(?:procedure|checklist|steps?|workflow|sequence)\b/i.test(question)) {
    return 'procedure_checklist'
  }
  if (/\b(?:compare|across|differences? between)\b/i.test(question)) return 'cross_document'
  if (/\b(?:what|which|when|where|who|how much|how many|list)\b/i.test(question)) {
    return 'direct_lookup'
  }
  return 'ambiguous'
}

export function adaptiveInference(
  inference: InferenceSettings,
  mode: RetrievalMode,
  question: string
): InferenceSettings {
  if (usesExtendedContext(mode, question)) {
    const broadOutput = mode === 'cross_document' || mode === 'spreadsheet_comparison' ? 2048 : 1536
    return {
      ...inference,
      contextLength: 16384,
      maxOutputTokens: Math.max(inference.maxOutputTokens, broadOutput)
    }
  }
  return {
    ...inference,
    contextLength: Math.max(8192, inference.contextLength) as 8192 | 16384,
    maxOutputTokens:
      mode === 'direct_lookup'
        ? Math.min(inference.maxOutputTokens, 256)
        : inference.maxOutputTokens
  }
}

export function decomposeQuestion(question: string, mode: RetrievalMode): string[] {
  if (mode === 'direct_lookup') return []
  if (/\b(?:benefits|business outcomes|customer outcomes)\b/i.test(question)) {
    return [
      `${question}\nFocus on platform capabilities such as self-service, governance, scheduling, metering, and chargeback.`,
      `${question}\nFocus on explicitly qualified customer outcomes, payback, savings, and cost visibility.`,
      `${question}\nFocus on stated utilization percentages and before-versus-after metrics.`
    ]
  }
  const requested = EVIDENCE_CATEGORIES.filter((category) => category.request.test(question))
  if (requested.length > 1) {
    return requested
      .slice(0, 4)
      .map((category) => `${question}\nFocus only on finding evidence for: ${category.name}.`)
  }
  if (question.trim().split(/\s+/).length < 8) return []
  const clauses = question
    .split(/(?:;|\n|\b(?:and also|as well as)\b)/i)
    .map((part) => part.trim())
    .filter((part) => part.length >= 12)
  return clauses.length > 1 ? clauses.slice(0, 4) : []
}

export function evidenceCoverage(
  question: string,
  chunks: EvidenceChunk[],
  rows: StructuredRow[] = []
): EvidenceCoverage {
  const requested = EVIDENCE_CATEGORIES.filter((category) => category.request.test(question))
  const evidenceText = [
    ...chunks.map((chunk) => `${chunk.file} ${chunk.heading} ${chunk.location} ${chunk.text}`),
    ...rows.map((row) =>
      [row.file, row.sheet, ...row.cells.map((cell) => `${cell.column} ${cell.value}`)].join(' ')
    )
  ].join('\n')
  const covered = requested
    .filter((category) => category.evidence.test(evidenceText))
    .map((category) => category.name)
  const names = requested.map((category) => category.name)
  return {
    requested: names,
    covered,
    missing: names.filter((name) => !covered.includes(name))
  }
}

export const RAG_CONFIDENCE_POLICY_VERSION = '1.0.0'

export const CONFIDENCE_THRESHOLDS: Readonly<
  Record<
    RetrievalMode,
    { highOverlap: number; mediumOverlap: number; highScore: number; mediumScore: number }
  >
> = {
  direct_lookup: { highOverlap: 2, mediumOverlap: 1, highScore: 0.3, mediumScore: 0.1 },
  spreadsheet_comparison: { highOverlap: 2, mediumOverlap: 1, highScore: 0.28, mediumScore: 0.08 },
  document_summary: { highOverlap: 2, mediumOverlap: 1, highScore: 0.22, mediumScore: 0.06 },
  procedure_checklist: { highOverlap: 2, mediumOverlap: 1, highScore: 0.24, mediumScore: 0.08 },
  cross_document: { highOverlap: 2, mediumOverlap: 1, highScore: 0.24, mediumScore: 0.08 },
  ambiguous: { highOverlap: 3, mediumOverlap: 2, highScore: 0.4, mediumScore: 0.18 }
}

export function retrievalConfidence(
  question: string,
  chunks: EvidenceChunk[],
  mode: RetrievalMode = 'ambiguous'
): { level: 'high' | 'medium' | 'low'; reason: string; overlap: number; score: number } {
  if (chunks.length === 0)
    return { level: 'low', reason: 'No passages were retrieved.', overlap: 0, score: 0 }
  const normalized = question.toLowerCase()
  if (chunks.some((chunk) => normalized.includes(chunk.file.toLowerCase()))) {
    return {
      level: 'high',
      reason: 'The requested file was matched exactly.',
      overlap: Number.MAX_SAFE_INTEGER,
      score: Math.max(...chunks.map((chunk) => chunk.score || 0))
    }
  }
  const terms = queryTerms(question)
  const bestOverlap = Math.max(
    ...chunks.map((chunk) => {
      const evidenceTerms = queryTerms(
        `${chunk.file} ${chunk.heading} ${chunk.location} ${chunk.text}`
      )
      return [...terms].filter((term) => evidenceTerms.has(term)).length
    })
  )
  const topScore = Math.max(...chunks.map((chunk) => chunk.score || 0))
  const threshold = CONFIDENCE_THRESHOLDS[mode]
  if (bestOverlap >= threshold.highOverlap || topScore >= threshold.highScore) {
    return {
      level: 'high',
      reason: 'The retrieved passages closely match the question.',
      overlap: bestOverlap,
      score: topScore
    }
  }
  if (bestOverlap >= threshold.mediumOverlap || topScore >= threshold.mediumScore) {
    return {
      level: 'medium',
      reason: 'Some relevant evidence was found.',
      overlap: bestOverlap,
      score: topScore
    }
  }
  return {
    level: 'low',
    reason: 'The retrieved passages do not clearly match the question.',
    overlap: bestOverlap,
    score: topScore
  }
}
