import { queryTerms, topicTerms } from './rag-terms'
import type { EvidenceChunk } from './rag-types'

function evidenceRank(question: string, chunk: EvidenceChunk): number {
  const terms = queryTerms(question)
  const evidenceTerms = queryTerms(`${chunk.file} ${chunk.heading} ${chunk.location} ${chunk.text}`)
  const overlap = [...terms].filter((term) => evidenceTerms.has(term)).length
  const exactFile = question.toLowerCase().includes(chunk.file.toLowerCase()) ? 5 : 0
  const text = `${chunk.heading} ${chunk.text}`
  const normalizedText = text.toLowerCase().replace(/\s+/g, ' ')
  const headingTerms = queryTerms(chunk.heading)
  const focusedTerms = topicTerms(question)
  const headingAuthority = focusedTerms.filter((term) => headingTerms.has(term)).length * 4
  const focusedPhrases = focusedTerms
    .slice(0, -1)
    .map((term, index) => `${term} ${focusedTerms[index + 1]}`)
  const phraseAuthority =
    focusedPhrases.filter((phrase) => normalizedText.includes(phrase)).length * 5
  let inventoryAuthority = 0
  if (/\bsoftware stacks?\b/i.test(question)) {
    if (/\bAI Software\s*&\s*Kubernetes Platform\b/i.test(text)) inventoryAuthority += 10
    if (/\bKubernetes platform\b/i.test(text)) inventoryAuthority += 6
    if (/\bAI software\b/i.test(text)) inventoryAuthority += 6
  }
  if (/\bdifferentiators?\b/i.test(question)) {
    if (/\b(?:Cisco )?ACI Differentiators\b/i.test(text)) inventoryAuthority += 12
    if (/\bUnmatched Feature Benefits\b[\s\S]*\bCompetition\b/i.test(text)) {
      inventoryAuthority += 11
    }
    if (/\bCompetitive Summary\b/i.test(text)) inventoryAuthority += 7
  }
  return (
    inventoryAuthority +
    headingAuthority +
    phraseAuthority +
    exactFile +
    overlap * 0.5 +
    (chunk.score || 0)
  )
}

export function packEvidence(question: string, chunks: EvidenceChunk[]): EvidenceChunk[] {
  const deduplicated = [
    ...new Map(
      chunks.map((chunk) => [
        `${chunk.knowledgeBaseId ?? ''}:${chunk.file}:${chunk.location}:${chunk.text}`,
        chunk
      ])
    ).values()
  ]
  return deduplicated
    .map((chunk, index) => ({ chunk, index, rank: evidenceRank(question, chunk) }))
    .sort((left, right) => right.rank - left.rank || left.index - right.index)
    .map(({ chunk }) => chunk)
}

export function focusEvidenceByHeading(question: string, chunks: EvidenceChunk[]): EvidenceChunk[] {
  const focused = new Set(topicTerms(question))
  const scored = chunks.map((chunk) => ({
    chunk,
    matches: [...focused].filter((term) => queryTerms(chunk.heading).has(term)).length
  }))
  const strongest = Math.max(0, ...scored.map((item) => item.matches))
  // Two matching title terms (for example, "Load Balancer") form an explicit
  // section boundary. Do not expose unrelated neighboring slides to generation.
  return strongest >= 2
    ? scored.filter((item) => item.matches === strongest).map((item) => item.chunk)
    : chunks
}
