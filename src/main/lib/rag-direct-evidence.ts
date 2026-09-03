import { queryTerms as terms } from './rag-terms'
import type { EvidenceChunk } from './rag-types'

const DIRECT_LOOKUP_NOISE = new Set([
  'admin',
  'credential',
  'credentials',
  'detail',
  'details',
  'find',
  'give',
  'information',
  'lab',
  'listed',
  'local',
  'password',
  'please',
  'show',
  'source',
  'value',
  'values',
  'what',
  'where',
  'which'
])

export function requestsSensitiveValue(question: string): boolean {
  const mentionsSensitive =
    /\b(?:password|passwd|passphrase|secret|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|private[ _-]?key|client[ _-]?secret|credentials?)\b/i.test(
      question
    )
  if (!mentionsSensitive) return false
  return !/\b(?:without|never|do not|don't|dont)\s+(?:show|showing|display|displaying|reveal|revealing|include|including|expose|exposing)?\s*(?:the\s+)?(?:password|passwd|passphrase|secret|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|private[ _-]?key|client[ _-]?secret|credentials?)\b/i.test(
    question
  )
}

function directLookupTerms(question: string): string[] {
  return [...terms(question)].filter(
    (term) => !DIRECT_LOOKUP_NOISE.has(term) && !/\.(?:pdf|docx|pptx|xlsx|csv|txt|md)$/i.test(term)
  )
}

function narrowedLocation(location: string, selectedIndexes: number[]): string {
  const lineMatch = /\bLines?\s+(\d+)(?:-(\d+))?/i.exec(location)
  if (!lineMatch || selectedIndexes.length === 0) return location
  const originalStart = Number(lineMatch[1])
  const start = originalStart + Math.min(...selectedIndexes)
  const end = originalStart + Math.max(...selectedIndexes)
  return location.replace(lineMatch[0], start === end ? `Line ${start}` : `Lines ${start}-${end}`)
}

export function narrowDirectLookupEvidence(
  question: string,
  chunks: EvidenceChunk[]
): EvidenceChunk[] {
  const queryTerms = directLookupTerms(question)
  if (queryTerms.length === 0) return chunks
  return chunks.map((chunk) => {
    // Page, slide, paragraph, and sheet boundaries carry semantic context and exact
    // provenance. Line pruning is safe only for plain-text/Markdown chunks where the
    // citation can be narrowed to the retained source lines.
    if (!/\bLines?\s+\d+/i.test(chunk.location)) return chunk
    if (
      queryTerms.some((term) => chunk.heading.toLowerCase().includes(term.toLowerCase())) ||
      /\b(?:address-family|interface|ip router|neighbor|router ospf|switchport|vrf context)\b/i.test(
        chunk.text
      )
    ) {
      return chunk
    }
    const lines = chunk.text.split('\n')
    const isTable =
      lines.length >= 3 &&
      /^\s*\|/.test(lines[0] ?? '') &&
      /^\s*\|(?:\s*:?-{3,}:?\s*\|)+/.test(lines[1] ?? '')
    const offset = isTable ? 2 : 0
    const scored = lines.slice(offset).map((line, index) => ({
      index: index + offset,
      line,
      score: queryTerms.reduce(
        (total, term) => total + (line.toLowerCase().includes(term.toLowerCase()) ? 1 : 0),
        0
      )
    }))
    const best = Math.max(0, ...scored.map((item) => item.score))
    if (best === 0) return chunk
    const selected = scored.filter((item) => item.score >= Math.max(1, best - 1)).slice(0, 12)
    const selectedIndexes = selected.map((item) => item.index)
    const text = isTable
      ? [lines[0], lines[1], ...selected.map((item) => item.line)].join('\n')
      : selected.map((item) => item.line).join('\n')
    return {
      ...chunk,
      text,
      location: narrowedLocation(chunk.location, selectedIndexes)
    }
  })
}

export function placeStrongEvidenceAtEdges(chunks: EvidenceChunk[]): EvidenceChunk[] {
  if (chunks.length < 3) return chunks
  return [chunks[0], ...chunks.slice(2), chunks[1]]
}
