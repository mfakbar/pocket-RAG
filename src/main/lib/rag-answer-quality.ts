const STOP_WORDS = new Set([
  'about',
  'after',
  'also',
  'and',
  'are',
  'because',
  'been',
  'being',
  'between',
  'from',
  'have',
  'into',
  'more',
  'most',
  'only',
  'that',
  'the',
  'their',
  'these',
  'this',
  'through',
  'using',
  'was',
  'were',
  'which',
  'with'
])

function contentTerms(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/\[\d+\]/g, ' ')
      .match(/[a-z0-9][a-z0-9._/-]*/g)
      ?.filter((term) => term.length >= 3 && !STOP_WORDS.has(term)) ?? []
  )
}

function citations(value: string): number[] {
  return [...value.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((match) =>
    match[1].split(',').map((item) => Number(item.trim()))
  )
}

export interface GroundedFallbackSource {
  file: string
  location: string
  text: string
}

const SENSITIVE_FIELD =
  /\b(password|passwd|passphrase|secret|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|private[ _-]?key|client[ _-]?secret)\b(\s*[:=]\s*)(["']?)([^\s,;|"']+)(\3)/gi

export function redactSensitiveFields(value: string): string {
  return value
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      '[REDACTED PRIVATE KEY]'
    )
    .replace(SENSITIVE_FIELD, (_full, label: string, separator: string) => {
      return `${label}${separator}[REDACTED]`
    })
    .replace(
      /\b(admin(?:istrator)?|root|user(?:name)?|login)(\s*[:/]\s*)([^\s,;|)'"\]]+)/gi,
      (_full, username: string, separator: string) => `${username}${separator}[REDACTED]`
    )
}

export function buildGroundedFallback(sources: GroundedFallbackSource[]): string {
  const entries = sources
    .slice(0, 5)
    .map((source, index) => `- **${source.file}** - ${source.location} [${index + 1}]`)
  return [
    '## I could not verify a complete answer',
    '',
    'I found relevant local sections, but I could not create a reliable answer without risking unsupported details. Try a narrower question or another model.',
    '',
    '### Relevant local sections',
    '',
    ...entries
  ].join('\n')
}

function acronymExpansion(value: string, acronym: string): string | null {
  const words = value.match(/[A-Za-z]+/g) ?? []
  const target = acronym.replace(/[^A-Z0-9]/g, '')
  for (let size = 2; size <= Math.min(6, words.length); size += 1) {
    const candidate = words.slice(-size)
    const initials = candidate.map((word) => word[0].toUpperCase()).join('')
    if (initials === target) return candidate.join(' ')
  }
  return null
}

function deduplicateRepeatedSentences(value: string): string {
  const seenPhrases = new Set<string>()
  return value
    .split('\n')
    .map((line) => {
      if (/^\s*#{1,6}\s/.test(line)) return line
      const segments = line.split(/(?<=[.!?])\s+(?=[A-Z0-9*])/)
      const kept = segments.filter((segment) => {
        const words =
          segment
            .toLowerCase()
            .replace(/\[\d+\]|[*_`#>|]/g, ' ')
            .match(/[a-z0-9][a-z0-9._/-]*/g) ?? []
        if (words.length < 12) return true
        const phrases = Array.from({ length: words.length - 11 }, (_, index) =>
          words.slice(index, index + 12).join(' ')
        )
        if (phrases.some((phrase) => seenPhrases.has(phrase))) return false
        phrases.forEach((phrase) => seenPhrases.add(phrase))
        return true
      })
      return kept.join(' ')
    })
    .filter((line, index, lines) => line.trim() || (index > 0 && lines[index - 1]?.trim()))
    .join('\n')
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function markdownTableDataLineIndexes(value: string): Set<number> {
  const lines = value.split('\n')
  const dataLines = new Set<number>()
  for (let index = 0; index < lines.length; index += 1) {
    const header = tableCells(lines[index] ?? '')
    const separator = tableCells(lines[index + 1] ?? '')
    const isTable =
      /^\s*\|.*\|\s*$/.test(lines[index] ?? '') &&
      header.length > 1 &&
      separator.length === header.length &&
      separator.every((cell) => /^:?-{3,}:?$/.test(cell))
    if (!isTable) continue

    let row = index + 2
    while (row < lines.length && /^\s*\|.*\|\s*$/.test(lines[row] ?? '')) {
      if (tableCells(lines[row] ?? '').length !== header.length) break
      dataLines.add(row)
      row += 1
    }
    if (row === index + 2) continue
    index = row - 1
  }
  return dataLines
}

function isValidMarkdownTableBlock(value: string): boolean {
  const lines = value.split('\n')
  const nonEmpty = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.trim())
  if (nonEmpty.length < 3) return false
  const dataLines = markdownTableDataLineIndexes(value)
  return (
    dataLines.size > 0 &&
    nonEmpty.every(({ line, index }) => {
      if (dataLines.has(index)) return true
      if (!/^\s*\|.*\|\s*$/.test(line)) return false
      return index === Math.min(...dataLines) - 2 || index === Math.min(...dataLines) - 1
    })
  )
}

function hasMalformedMarkdownTable(value: string): boolean {
  const lines = value.split('\n')
  const validDataLines = markdownTableDataLineIndexes(value)
  const validLines = new Set<number>()
  for (const row of validDataLines) {
    validLines.add(row)
    validLines.add(row - 1)
    validLines.add(row - 2)
  }
  return lines.some(
    (line, index) =>
      !validLines.has(index) && (/^\s*\|.*\|\s*$/.test(line) || /^\s*\|?\s*:?-{3,}/.test(line))
  )
}

export function sanitizeGroundedAnswer(answer: string, sources: string[]): string {
  const sourceText = sources
    .join('\n')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
  const withoutReverseExpansions = answer.replace(
    /\b([A-Z][A-Z0-9-]{1,})\s+\(([A-Za-z][A-Za-z -]{3,60})\)/g,
    (full, acronym: string, expansion: string) => {
      const normalizedExpansion = expansion
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
      return normalizedExpansion && !sourceText.includes(normalizedExpansion) ? acronym : full
    }
  )
  const withoutUnsupportedExpansions = withoutReverseExpansions.replace(
    /\b([A-Za-z][A-Za-z -]{3,60})\s+\(([A-Z][A-Z0-9-]{1,})\)/g,
    (full, lead: string, acronym: string) => {
      const expansion = acronymExpansion(lead, acronym)
      const normalizedExpansion = expansion?.toLowerCase().replace(/[^a-z0-9]+/g, ' ')
      if (!expansion || !normalizedExpansion || sourceText.includes(normalizedExpansion))
        return full
      return lead.slice(0, -expansion.length) + acronym
    }
  )
  const seen = new Set<string>()
  return deduplicateRepeatedSentences(withoutUnsupportedExpansions)
    .split(/(\n\s*\n)/)
    .filter((block) => {
      if (/^\n\s*\n$/.test(block)) return true
      const normalized = block.toLowerCase().replace(/\s+/g, ' ').trim()
      if (normalized.length < 60) return true
      if (seen.has(normalized)) return false
      seen.add(normalized)
      return true
    })
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function attachSupportedCitations(answer: string, sources: string[]): string {
  const sourceTerms = sources.map((source) => contentTerms(source))
  const tableDataLines = markdownTableDataLineIndexes(answer)
  return answer
    .split('\n')
    .map((line, lineIndex) => {
      const plain = line.replace(/^\s*(?:#{1,6}|[-*]|\d+\.)\s+/, '').trim()
      const terms = contentTerms(plain)
      if (
        citations(line).length > 0 ||
        (!tableDataLines.has(lineIndex) && terms.size < 6) ||
        /^\s*#{1,6}\s/.test(line) ||
        plain.endsWith('?') ||
        plain.endsWith(':')
      ) {
        return line
      }
      let bestIndex = -1
      let bestShared = 0
      sourceTerms.forEach((candidate, index) => {
        const shared = [...terms].filter((term) => candidate.has(term)).length
        if (shared > bestShared) {
          bestIndex = index
          bestShared = shared
        }
      })
      if (bestIndex < 0 || (bestShared < 2 && bestShared / terms.size < 0.08)) return line
      const citation = `[${bestIndex + 1}]`
      return tableDataLines.has(lineIndex)
        ? line.replace(/\s*\|\s*$/, ` ${citation} |`)
        : `${line.trimEnd()} ${citation}`
    })
    .join('\n')
}

export function removeInvalidCitationMarkers(answer: string, sourceCount: number): string {
  return answer.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_marker, values: string) => {
    const valid = [
      ...new Set(
        values
          .split(',')
          .map((value) => Number(value.trim()))
          .filter((value) => value >= 1 && value <= sourceCount)
      )
    ]
    return valid.length > 0 ? `[${valid.join(', ')}]` : ''
  })
}

function citationSignature(value: string): string {
  return citations(value)
    .sort((left, right) => left - right)
    .join(',')
}

function removeCitationMarkers(value: string): string {
  return value.replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, '')
}

export function collapseConsecutiveCitations(answer: string): string {
  let insideCodeBlock = false
  return answer
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        insideCodeBlock = !insideCodeBlock
        return line
      }
      if (insideCodeBlock) return line

      const sentences = line.match(/[^.!?]+(?:[.!?]+|$)/g)
      if (!sentences || sentences.length < 2) return line

      let index = 0
      while (index < sentences.length) {
        const signature = citationSignature(sentences[index] ?? '')
        if (!signature) {
          index += 1
          continue
        }
        let end = index + 1
        while (end < sentences.length && citationSignature(sentences[end] ?? '') === signature) {
          end += 1
        }
        if (end - index > 1) {
          for (let current = index; current < end - 1; current += 1) {
            sentences[current] = removeCitationMarkers(sentences[current] ?? '')
          }
        }
        index = end
      }
      return sentences.join('')
    })
    .join('\n')
}

function looksIncomplete(value: string): boolean {
  const answer = value.trim()
  if (!answer) return true
  if ((answer.match(/```/g)?.length ?? 0) % 2 !== 0) return true
  const lines = answer.split('\n')
  const finalLineIndex = lines.length - 1
  if (markdownTableDataLineIndexes(answer).has(finalLineIndex)) return false
  if (/[|,:;({-]$/.test(answer)) return true
  const finalLine = answer.split('\n').at(-1)?.trim() ?? ''
  if (/^#{1,6}\s+\S/.test(finalLine)) return true
  if (/\b(?:and|or|to|with|by|for|because|including|such as)\s*[.!?]*$/i.test(finalLine))
    return true
  return false
}

function hasRepeatedPassage(value: string): boolean {
  const words = value
    .toLowerCase()
    .replace(/\[\d+\]|[*_`#>|]/g, ' ')
    .match(/[a-z0-9][a-z0-9._/-]*/g)
  if (!words || words.length < 24) return false
  const seen = new Set<string>()
  for (let index = 0; index <= words.length - 12; index += 1) {
    const phrase = words.slice(index, index + 12).join(' ')
    if (seen.has(phrase)) return true
    seen.add(phrase)
  }
  return false
}

function hasRepeatedLabels(value: string): boolean {
  const labels = [...value.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) =>
    match[1]
      .replace(/[*_`:#]+/g, '')
      .trim()
      .toLowerCase()
  )
  return labels.some((label, index) => label && labels.indexOf(label) !== index)
}

function factualBlocks(value: string): string[] {
  return value
    .split(/\n\s*\n/)
    .flatMap((paragraph) =>
      isValidMarkdownTableBlock(paragraph)
        ? [paragraph]
        : paragraph.split(/\n(?=\s*(?:[-*]|\d+\.|#{1,6})\s)/)
    )
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
}

const REQUESTED_CATEGORIES: Array<{
  name: string
  request: RegExp
  answer: RegExp
}> = [
  { name: 'configuration', request: /\bconfigurations?\b/i, answer: /\bconfigurations?\b/i },
  { name: 'quantity', request: /\bquantit(?:y|ies)\b/i, answer: /\bquantit(?:y|ies)\b|\bqty\b/i },
  { name: 'lead time', request: /\blead times?\b/i, answer: /\blead times?\b/i },
  {
    name: 'price or cost',
    request: /\b(?:prices?|costs?|commercial)\b/i,
    answer: /\b(?:prices?|costs?|commercial)\b/i
  },
  { name: 'total', request: /\btotals?\b/i, answer: /\btotals?\b/i },
  { name: 'architecture', request: /\barchitecture\b/i, answer: /\barchitecture\b/i },
  {
    name: 'operations',
    request: /\boperations?|operational\b/i,
    answer: /\boperations?|operational\b/i
  },
  {
    name: 'differentiators',
    request: /\bdifferentiators?|differences?\b/i,
    answer: /\bdifferentiators?|differences?\b/i
  },
  { name: 'benefits', request: /\bbenefits?|advantages?\b/i, answer: /\bbenefits?|advantages?\b/i },
  {
    name: 'drawbacks',
    request: /\bdrawbacks?|disadvantages?\b/i,
    answer: /\bdrawbacks?|disadvantages?\b/i
  },
  { name: 'risks', request: /\brisks?|challenges?\b/i, answer: /\brisks?|challenges?\b/i },
  {
    name: 'gaps',
    request: /\bgaps?|missing (?:details|information|values)\b/i,
    answer: /\bgaps?|missing|not (?:provided|stated|specified)\b/i
  },
  {
    name: 'procedure',
    request: /\bprocedure|checklist|steps?|workflow|sequence\b/i,
    answer: /\bprocedure|checklist|steps?|workflow|sequence\b/i
  },
  {
    name: 'timeline',
    request: /\btimeline|dates?|schedule\b/i,
    answer: /\btimeline|dates?|schedule\b/i
  },
  { name: 'next steps', request: /\bnext steps?|actions?\b/i, answer: /\bnext steps?|actions?\b/i },
  { name: 'decisions', request: /\bdecisions?\b/i, answer: /\bdecisions?\b/i },
  { name: 'assumptions', request: /\bassumptions?\b/i, answer: /\bassumptions?\b/i },
  {
    name: 'open questions',
    request: /\bquestions? (?:that|which)?\s*(?:still )?need/i,
    answer: /\bquestions?|unknown|needs? confirmation\b/i
  },
  {
    name: 'owners',
    request: /\bowners?|responsible\b/i,
    answer: /\bowners?|responsible|not (?:named|specified)\b/i
  },
  {
    name: 'deadlines',
    request: /\bdeadlines?\b/i,
    answer: /\bdeadlines?|not (?:provided|specified)\b/i
  },
  {
    name: 'measurements',
    request: /\bmeasurements?|targets?\b/i,
    answer: /\bmeasurements?|targets?\b/i
  },
  { name: 'use cases', request: /\buse cases?\b/i, answer: /\buse cases?\b/i }
]

function requestedCategoryIssues(question: string, answer: string): string[] {
  return REQUESTED_CATEGORIES.filter(
    (category) => category.request.test(question) && !category.answer.test(answer)
  ).map((category) => `missing requested category: ${category.name}`)
}

interface NumericClaim {
  display: string
  value: string
  unit: string | null
  currency: boolean
}

const NUMERIC_CLAIM =
  /(?<![a-z0-9])(?:(?:\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?)|(?:[$€£]\s*)?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s*(?:%|bps|kbps|mbps|gbps|tbps|w|watts?|kw|kilowatts?|mw|megawatts?|gw|wh|kwh|mwh|v|volts?|kv|a|amps?|amperes?|ma|gb|gigabytes?|tb|mb|kb|bytes?|days?|weeks?|months?|years?|hours?|minutes?|seconds?|racks?|nodes?|servers?|ports?|cores?|threads?|gpus?|cpus?|units?|usd|idr))?)(?![a-z0-9])/gi

const NUMERIC_VALUE =
  /\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g

function normalizeNumericValue(value: string): string {
  const normalized = value.replace(/,/g, '').replace(/^0+(?=\d)/, '')
  if ((normalized.match(/\./g)?.length ?? 0) > 1 || normalized.includes('/')) return normalized
  if (!normalized.includes('.')) return normalized || '0'
  return normalized.replace(/0+$/, '').replace(/\.$/, '')
}

function normalizeUnit(value: string | undefined): string | null {
  if (!value) return null
  const normalized = value.toLowerCase()
  const singular = normalized.endsWith('s') ? normalized.slice(0, -1) : normalized
  const aliases: Record<string, string> = {
    w: 'watt',
    watt: 'watt',
    kw: 'kilowatt',
    kilowatt: 'kilowatt',
    mw: 'megawatt',
    megawatt: 'megawatt',
    v: 'volt',
    volt: 'volt',
    a: 'ampere',
    amp: 'ampere',
    ampere: 'ampere',
    gb: 'gigabyte',
    gigabyte: 'gigabyte',
    byte: 'byte',
    day: 'day',
    week: 'week',
    month: 'month',
    year: 'year',
    hour: 'hour',
    minute: 'minute',
    second: 'second',
    rack: 'rack',
    node: 'node',
    server: 'server',
    port: 'port',
    core: 'core',
    thread: 'thread',
    gpu: 'gpu',
    cpu: 'cpu',
    unit: 'unit'
  }
  return aliases[singular] ?? normalized
}

function numericClaims(value: string): NumericClaim[] {
  const withoutCitations = value
    .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, ' ')
    .replace(/^\s*(?:[-*]|\d+[.)])\s+/gm, '')
  return [...withoutCitations.matchAll(NUMERIC_CLAIM)].map((match) => {
    const display = match[0].trim()
    const valueMatch = display.match(
      /\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/
    )
    const unitMatch = display.match(/([a-z%]+)\s*$/i)
    const isIpAddress = /^\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?$/.test(display)
    return {
      display,
      value: normalizeNumericValue(valueMatch?.[0] ?? ''),
      unit: isIpAddress ? 'ip-address' : normalizeUnit(unitMatch?.[1]),
      currency: /^[$€£]/.test(display) || /\b(?:usd|idr)\b/i.test(display)
    }
  })
}

function sourceSupportsNumericClaim(
  source: string,
  claim: NumericClaim,
  relationshipTerms: Set<string> = new Set()
): boolean {
  for (const match of source.matchAll(NUMERIC_VALUE)) {
    if (normalizeNumericValue(match[0]) !== claim.value) continue
    const start = Math.max(0, (match.index ?? 0) - 16)
    const end = Math.min(source.length, (match.index ?? 0) + match[0].length + 24)
    const nearby = source.slice(start, end).toLowerCase()
    if (claim.unit && !['usd', 'idr', 'ip-address', 'unit'].includes(claim.unit)) {
      const aliases: Record<string, string[]> = {
        watt: ['w', 'watt', 'watts'],
        kilowatt: ['kw', 'kilowatt', 'kilowatts'],
        megawatt: ['mw', 'megawatt', 'megawatts'],
        volt: ['v', 'volt', 'volts'],
        ampere: ['a', 'amp', 'amps', 'ampere', 'amperes'],
        gigabyte: ['gb', 'gigabyte', 'gigabytes']
      }
      const unitForms = aliases[claim.unit] ?? [claim.unit, `${claim.unit}s`]
      if (
        !unitForms.some((unit) =>
          unit === '%' ? nearby.includes('%') : new RegExp(`(?<![a-z])${unit}\\b`, 'i').test(nearby)
        )
      )
        continue
    }
    if (relationshipTerms.size > 0) {
      const lineStart = source.lastIndexOf('\n', match.index ?? 0) + 1
      const nextBreak = source.indexOf('\n', (match.index ?? 0) + match[0].length)
      const lineEnd = nextBreak < 0 ? source.length : nextBreak
      const rowTerms = contentTerms(source.slice(lineStart, lineEnd))
      if (![...relationshipTerms].some((term) => rowTerms.has(term))) continue
    }
    return true
  }
  return false
}

function supportIssuesForBlock(
  block: string,
  sources: string[],
  inheritedRefs: number[] = [],
  supplementalEvidence = ''
): string[] {
  if (isValidMarkdownTableBlock(block)) {
    const rows = block
      .split('\n')
      .filter((_line, index) => markdownTableDataLineIndexes(block).has(index))
    return [
      ...new Set(
        rows.flatMap((row) =>
          supportIssuesForBlock(row, sources, inheritedRefs, supplementalEvidence)
        )
      )
    ]
  }
  const issues = new Set<string>()
  const plain = block.replace(/^#{1,6}\s+/, '').replace(/^\s*(?:[-*]|\d+[.)])\s+/, '')
  const words = contentTerms(plain)
  const claims = numericClaims(plain)
  const blockRefs = citations(block).filter((index) => index >= 1 && index <= sources.length)
  const isBullet = /^\s*(?:[-*]|\d+\.)\s/.test(block)
  const refs = blockRefs.length > 0 ? blockRefs : isBullet ? inheritedRefs : []
  const nonFactual =
    /^sources?\b/i.test(plain) ||
    /^based on (?:the )?(?:provided|selected|local) (?:files|sources)/i.test(plain) ||
    plain.endsWith('?') ||
    plain.endsWith(':') ||
    /^#{1,6}\s/.test(block)
  if (nonFactual) return []
  if (refs.length === 0) {
    return words.size >= 2 || claims.length > 0 ? ['uncited factual paragraph'] : []
  }
  if (
    /\b(?:do not|does not|did not|not)\s+(?:contain|provide|include|state|specify|show)\b|\b(?:absent|missing information)\b/i.test(
      plain
    )
  ) {
    return []
  }

  const citedSources = [
    ...refs.map((index) => sources[index - 1] ?? ''),
    ...(supplementalEvidence ? [supplementalEvidence] : [])
  ]
  if (words.size >= 6) {
    const citedTerms = new Set(citedSources.flatMap((source) => [...contentTerms(source)]))
    const sentences = plain
      .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, '')
      .split(/(?<=[.!?])\s+|\n+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean)
    for (const sentence of sentences) {
      const terms = contentTerms(sentence)
      if (terms.size < 5) continue
      const shared = [...terms].filter((term) => citedTerms.has(term)).length
      if (shared < 2 && shared / terms.size < 0.1) {
        issues.add('citation lacks passage support')
      }
    }
  }
  for (const claim of claims) {
    const claimPosition = plain.indexOf(claim.display)
    const sentenceStart = Math.max(
      plain.lastIndexOf('.', claimPosition) + 1,
      plain.lastIndexOf('\n', claimPosition) + 1
    )
    const relationshipTerms = new Set(
      [...contentTerms(plain.slice(sentenceStart, claimPosition))].filter(
        (term) =>
          !/^(?:about|approximately|calculated|cost|day|days|derived|has|have|lead|listed|price|quantity|the|time|total|unit|using|value)$/.test(
            term
          )
      )
    )
    if (
      !citedSources.some((source) => sourceSupportsNumericClaim(source, claim, relationshipTerms))
    ) {
      issues.add(`unsupported numeric claim: ${claim.display}`)
    }
  }
  return [...issues]
}

export interface GroundingOptions {
  allowInterpretation?: boolean
  derivedEvidence?: string
}

export interface SemanticClaimCheck {
  id: string
  claim: string
  passages: string[]
}

export function semanticClaimChecks(answer: string, sources: string[]): SemanticClaimCheck[] {
  return factualBlocks(answer).flatMap((block, index) => {
    const refs = citations(block).filter(
      (reference) => reference >= 1 && reference <= sources.length
    )
    const claim = block
      .replace(/^#{1,6}\s+/, '')
      .replace(/^\s*(?:[-*]|\d+[.)])\s+/, '')
      .replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, '')
      .trim()
    if (refs.length === 0 || claim.length < 30 || claim.endsWith(':')) return []
    return [
      {
        id: String(index),
        claim,
        passages: refs.map((reference) => sources[reference - 1]).filter(Boolean)
      }
    ]
  })
}

function interpretationHeading(block: string): boolean {
  return /^#{1,6}\s+(?:model )?interpretation(?:\s*\([^)]*\))?/i.test(block.trim())
}

export function groundedAnswerIssues(
  answer: string,
  sources: string[],
  question = '',
  options: GroundingOptions = {}
): string[] {
  const issues = new Set<string>()
  const normalized = answer.trim()
  if (!normalized) return ['empty answer']
  if (redactSensitiveFields(normalized) !== normalized) issues.add('sensitive field exposed')
  if (/<\/?[a-z][^>]*>/i.test(normalized)) issues.add('raw HTML')
  if (hasMalformedMarkdownTable(normalized)) issues.add('malformed Markdown table')
  if (looksIncomplete(normalized)) issues.add('incomplete ending')
  if (hasRepeatedPassage(normalized) || hasRepeatedLabels(normalized)) {
    issues.add('repeated content')
  }

  const blocks = factualBlocks(normalized)
  let inInterpretation = false
  const documentBlocks = blocks.filter((block) => {
    if (interpretationHeading(block)) {
      inInterpretation = true
      return false
    }
    return !(options.allowInterpretation && inInterpretation)
  })
  const referenced = citations(documentBlocks.join('\n\n'))
  if (referenced.length === 0) issues.add('missing citations')
  if (referenced.some((index) => index < 1 || index > sources.length)) {
    issues.add('invalid citation number')
  }
  const sourceText = sources
    .join('\n')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
  for (const match of normalized.matchAll(
    /\b([A-Za-z][A-Za-z -]{3,60})\s+\(([A-Z][A-Z0-9-]{1,})\)/g
  )) {
    const expansion = acronymExpansion(match[1], match[2])
    const normalizedExpansion = expansion?.toLowerCase().replace(/[^a-z0-9]+/g, ' ')
    if (normalizedExpansion && !sourceText.includes(normalizedExpansion)) {
      issues.add('unsupported acronym expansion')
    }
  }
  for (const match of normalized.matchAll(
    /\b([A-Z][A-Z0-9-]{1,})\s+\(([A-Za-z][A-Za-z -]{3,60})\)/g
  )) {
    const normalizedExpansion = match[2]
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
    if (normalizedExpansion && !sourceText.includes(normalizedExpansion)) {
      issues.add('unsupported acronym expansion')
    }
  }

  const paragraphs = blocks
  let inheritedListRefs: number[] = []
  inInterpretation = false
  for (const paragraph of paragraphs) {
    if (interpretationHeading(paragraph)) {
      inInterpretation = true
      inheritedListRefs = []
      continue
    }
    if (options.allowInterpretation && inInterpretation) continue
    const plain = paragraph.replace(/^#{1,6}\s+/, '').replace(/^\s*(?:[-*]|\d+[.)])\s+/, '')
    const paragraphRefs = citations(paragraph).filter(
      (index) => index >= 1 && index <= sources.length
    )
    if (plain.endsWith(':')) {
      inheritedListRefs = plain.endsWith(':') ? paragraphRefs : inheritedListRefs
    } else if (!/^\s*(?:[-*]|\d+\.)\s/.test(paragraph)) {
      inheritedListRefs = []
    }
    supportIssuesForBlock(paragraph, sources, inheritedListRefs, options.derivedEvidence).forEach(
      (issue) => issues.add(issue)
    )
  }
  requestedCategoryIssues(question, normalized).forEach((issue) => issues.add(issue))
  return [...issues]
}

function removeOrphanHeadings(blocks: string[]): string[] {
  return blocks.filter((block, index) => {
    if (!/^#{1,6}\s/.test(block)) return true
    return blocks.slice(index + 1).some((candidate) => !/^#{1,6}\s/.test(candidate))
  })
}

export function verifiedGroundedDraft(
  answer: string,
  sources: string[],
  options: GroundingOptions = {}
): string {
  const blocks = factualBlocks(redactSensitiveFields(answer))
  let inheritedListRefs: number[] = []
  let inInterpretation = false
  const kept = blocks.flatMap((block) => {
    if (interpretationHeading(block)) {
      inInterpretation = true
      inheritedListRefs = []
      return options.allowInterpretation ? [block] : []
    }
    if (options.allowInterpretation && inInterpretation) return [block]
    if (isValidMarkdownTableBlock(block)) {
      const lines = block.split('\n')
      const dataLines = markdownTableDataLineIndexes(block)
      const verifiedRows = lines.filter(
        (line, index) =>
          !dataLines.has(index) ||
          supportIssuesForBlock(line, sources, inheritedListRefs, options.derivedEvidence)
            .length === 0
      )
      const retainedDataRows = verifiedRows.length - (lines.length - dataLines.size)
      return retainedDataRows > 0 ? [verifiedRows.join('\n')] : []
    }
    const refs = citations(block).filter((index) => index >= 1 && index <= sources.length)
    const plain = block.replace(/^#{1,6}\s+/, '').trim()
    if (plain.endsWith(':')) inheritedListRefs = refs
    else if (!/^\s*(?:[-*]|\d+\.)\s/.test(block) && !/^#{1,6}\s/.test(block)) {
      inheritedListRefs = []
    }
    return supportIssuesForBlock(block, sources, inheritedListRefs, options.derivedEvidence)
      .length === 0
      ? [block]
      : []
  })
  return removeOrphanHeadings(kept).join('\n\n').trim()
}

export function composeCheckedAnswer(initialAnswer: string, verifiedSummary: string): string {
  const initial = redactSensitiveFields(initialAnswer).trim()
  const summary = verifiedSummary.trim()
  if (!initial) return summary
  if (!summary) return initial

  const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim()
  if (normalize(initial) === normalize(summary)) return summary

  return [
    '## Initial response (not source-verified)',
    '',
    '> This is the original generated response. Use the verified summary below for factual decisions.',
    '',
    initial,
    '',
    '---',
    '',
    '## Verified summary',
    '',
    summary
  ].join('\n')
}

export function repairInstruction(issues: string[]): string {
  return (
    'Write a fresh, complete final answer to the original user request. Fix these quality problems: ' +
    issues.join(', ') +
    '. Start again from the supplied local sources; do not quote, discuss, or attempt to preserve the ' +
    'previous draft. Remove every unsupported claim. Cite every factual paragraph and bullet with ' +
    'valid source numbers. Do not repeat text, headings, or list labels. Preserve useful Markdown ' +
    'structure. A well-formed Markdown table is allowed when it improves comparison or numeric ' +
    'readability; every factual row must include a valid citation. Do not use raw pipe text outside ' +
    'a valid table, HTML, or commentary about the rewrite. Do not expand acronyms or explain ' +
    'technical terms unless a source explicitly provides the definition. Copy every number and unit ' +
    'exactly from its cited source; never shorten, round, combine, calculate, or relabel values. Keep ' +
    'each value attached to the correct item. Keep the answer under 600 ' +
    'words with no more than six sections. Finish every section and end with a complete sentence.'
  )
}

export function targetedRepairInstruction(issues: string[], verifiedDraft: string): string {
  if (!verifiedDraft.trim()) return repairInstruction(issues)
  return (
    'Add only the corrected or missing sections needed to complete the original request. Do not ' +
    'rewrite, summarize, quote, or repeat the verified draft below. Fix these remaining problems: ' +
    issues.join(', ') +
    '. Return only new answer paragraphs or sections that can be appended to the verified draft. ' +
    'Do not flatten or restyle its headings, lists, or valid Markdown tables. ' +
    'Use only the supplied local sources. Cite every factual paragraph and bullet. Copy numbers and ' +
    'units exactly from the cited passage. Do not expose passwords, secrets, keys, or tokens. Keep ' +
    'the addition concise and end with a complete sentence.\n\nVERIFIED DRAFT TO KEEP\n' +
    verifiedDraft
  )
}
