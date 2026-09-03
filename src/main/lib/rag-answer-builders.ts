import { queryTerms as terms, topicTerms } from './rag-terms'
import type { EvidenceChunk } from './rag-types'

function canonicalInventoryTerms(value: string): Set<string> {
  const normalized = value
    .toLowerCase()
    .replace(/\bepgs?\b/g, ' endpoint grouping ')
    .replace(/\bvlans?\b/g, ' vlan ')
    .replace(/[^a-z0-9]+/g, ' ')
  return new Set(
    normalized
      .split(/\s+/)
      .filter((term) => term.length >= 3 && !/^(?:aci|apic|cisco|using|with|from|same)$/.test(term))
  )
}

function duplicateInventoryItem(candidate: string, selected: string[]): boolean {
  const candidateTerms = canonicalInventoryTerms(candidate)
  return selected.some((item) => {
    const selectedTerms = canonicalInventoryTerms(item)
    const shared = [...candidateTerms].filter((term) => selectedTerms.has(term)).length
    return shared >= 2 && shared / Math.min(candidateTerms.size, selectedTerms.size) >= 0.5
  })
}

function explicitInventoryItems(text: string): string[] {
  const tableStart = /\bFeature\s+Cisco\s+AC[Il1]\s+Competition\b/i.exec(text)
  if (tableStart) {
    const body = text.slice((tableStart.index ?? 0) + tableStart[0].length)
    const parts = body.split(/\s+Yes\s+No(?:\s+|$)/i)
    if (parts.length >= 4) {
      return parts
        .slice(0, -1)
        .map((item) => item.replace(/\s+/g, ' ').trim())
        .filter((item) => item.length >= 8 && item.length <= 240 && !/[,;:]$/.test(item))
    }
  }
  if (/\bDifferentiators?\b/i.test(text)) {
    return [...text.matchAll(/\b\d+\.\s+(.+?)(?=\s+\d+\.\s+|$)/g)]
      .map((match) => match[1].replace(/\s+/g, ' ').trim())
      .filter((item) => item.length >= 8 && item.length <= 240)
  }
  return []
}

export function buildEvidenceListAnswer(question: string, chunks: EvidenceChunk[]): string | null {
  const requestedMatch = /\b(?:top|up to)\s+(\d{1,2})\b/i.exec(question)
  if (!requestedMatch || !/\b(?:competitive|differentiators?)\b/i.test(question)) return null
  const requested = Math.min(25, Number(requestedMatch[1]))
  if (!Number.isInteger(requested) || requested < 1) return null

  const candidates = chunks.flatMap((chunk, index) =>
    explicitInventoryItems(chunk.text).map((item) => ({ item, citation: index + 1 }))
  )
  // Prefer explicit Yes/No comparison rows, then fill from a labelled differentiator list.
  candidates.sort((left, right) => {
    const leftTable = /\bFeature\s+Cisco\s+AC[Il1]\s+Competition\b/i.test(
      chunks[left.citation - 1]?.text ?? ''
    )
    const rightTable = /\bFeature\s+Cisco\s+AC[Il1]\s+Competition\b/i.test(
      chunks[right.citation - 1]?.text ?? ''
    )
    return Number(rightTable) - Number(leftTable)
  })
  const selected: Array<{ item: string; citation: number }> = []
  for (const candidate of candidates) {
    if (
      duplicateInventoryItem(
        candidate.item,
        selected.map((item) => item.item)
      )
    )
      continue
    selected.push(candidate)
    if (selected.length >= requested) break
  }
  if (selected.length < requested) return null
  return [
    `## ${requested} source-supported differentiators`,
    '',
    'This is a source-supported selection, not a ranking stated by the document.',
    '',
    ...selected.map((candidate, index) => `${index + 1}. ${candidate.item} [${candidate.citation}]`)
  ].join('\n')
}

function cleanStackOption(value: string): string {
  return value
    .replace(/^[-*]\s*/, '')
    .replace(/^Options?:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function buildSoftwareStackAnswer(question: string, chunks: EvidenceChunk[]): string | null {
  if (!/\bsoftware stacks?\b/i.test(question)) return null
  const sections: Array<{ heading: string; items: string[]; citation: number }> = []
  const sectionItems = (lines: string[], start: number, boundaries: RegExp): string[] => {
    if (start < 0) return []
    const following = lines.slice(start + 1)
    const boundary = following.findIndex((line) => boundaries.test(line))
    return (boundary >= 0 ? following.slice(0, boundary) : following)
      .flatMap((line) => cleanStackOption(line).split(/\s*[|,]\s*/))
      .map(cleanStackOption)
      .filter((line) => line.length >= 3 && line.length <= 120)
  }
  for (const [index, chunk] of chunks.entries()) {
    const lines = chunk.text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const combinedIndex = lines.findIndex((line) =>
      /^AI Software\s*&\s*Kubernetes Platform$/i.test(line)
    )
    if (combinedIndex >= 0) {
      const items = sectionItems(
        lines,
        combinedIndex,
        /^(?:Cisco AI Networking|Cisco Compute|Partner storage|AI Observability|AI Security)$/i
      )
      if (items.length >= 2) {
        sections.push({
          heading: 'Integrated AI software and Kubernetes platform option',
          items,
          citation: index + 1
        })
      }
    }

    const kubernetesIndex = lines.findIndex((line) => /^Kubernetes platform$/i.test(line))
    const aiSoftwareIndex = lines.findIndex((line) => /^AI software$/i.test(line))
    if (kubernetesIndex >= 0 || aiSoftwareIndex >= 0) {
      const boundaries =
        /^(?:AI software|Kubernetes platform|Cisco AI Networking|Cisco Compute|Partner storage|AI Observability|AI Security)$/i
      const namedSoftware =
        /\b(?:AI Enterprise|Blueprints?|Cisco|Isovalent|Kubernetes|NeMo|NIM|NKP|Nutanix|NVIDIA|OpenShift|Rafay|Red Hat|Splunk|Upstream)\b/i
      const kubernetesItems = sectionItems(lines, kubernetesIndex, boundaries).filter((item) =>
        namedSoftware.test(item)
      )
      const aiItems = sectionItems(lines, aiSoftwareIndex, boundaries).filter((item) =>
        namedSoftware.test(item)
      )
      if (kubernetesItems.length >= 2) {
        sections.push({
          heading: 'Kubernetes platform options',
          items: kubernetesItems,
          citation: index + 1
        })
      }
      if (aiItems.length >= 2) {
        sections.push({ heading: 'AI software stack', items: aiItems, citation: index + 1 })
      }
    }

    const observabilityIndex = lines.findIndex((line) => /^AI Observability$/i.test(line))
    const securityIndex = lines.findIndex((line) => /^AI Security$/i.test(line))
    const observabilityItems = sectionItems(
      lines,
      observabilityIndex,
      /^(?:AI Security|Cisco AI PODs|AI software|Kubernetes platform)$/i
    )
    const securityItems = sectionItems(
      lines,
      securityIndex,
      /^(?:Cisco AI PODs|AI software|Kubernetes platform|Cisco AI Networking)$/i
    )
    if (observabilityItems.length >= 1) {
      sections.push({
        heading: 'Observability software',
        items: observabilityItems,
        citation: index + 1
      })
    }
    if (securityItems.length >= 1) {
      sections.push({ heading: 'Security software', items: securityItems, citation: index + 1 })
    }
    const management = lines.find((line) => /^Options for Network Management:/i.test(line))
    if (management) {
      const items = cleanStackOption(
        management.replace(/^Options for Network Management:/i, '')
      ).split(/\s*\|\s*|\s+or\s+/i)
      if (items.length > 0) {
        sections.push({ heading: 'Network management software', items, citation: index + 1 })
      }
    }
  }
  const seenHeadings = new Set<string>()
  const sectionOrder = new Map([
    ['Kubernetes platform options', 0],
    ['AI software stack', 1],
    ['Integrated AI software and Kubernetes platform option', 2],
    ['Security software', 3],
    ['Observability software', 4],
    ['Network management software', 5]
  ])
  const uniqueSections = sections
    .filter((section) => {
      if (seenHeadings.has(section.heading)) return false
      seenHeadings.add(section.heading)
      return true
    })
    .sort(
      (left, right) =>
        (sectionOrder.get(left.heading) ?? 99) - (sectionOrder.get(right.heading) ?? 99)
    )
  if (uniqueSections.length < 2) return null
  return [
    '## Software stacks stated in the validated design',
    '',
    ...uniqueSections.flatMap((section) => [
      `### ${section.heading} [${section.citation}]`,
      '',
      ...[...new Set(section.items)].map((item) => `- ${item} [${section.citation}]`),
      ''
    ])
  ]
    .join('\n')
    .trim()
}

export function buildExtractiveAnswer(question: string, chunks: EvidenceChunk[]): string | null {
  if (chunks.length === 0) return null
  const focused = new Set(topicTerms(question))
  if (/\b(?:AI|GPU|H200)\b/i.test(question) && /\bsizing\b/i.test(question)) {
    for (const term of [
      'concurrent',
      'gpu',
      'gpus',
      'model',
      'power',
      'quantity',
      'token',
      'total'
    ]) {
      focused.add(term)
    }
  }
  if (/\bfacilit(?:y|ies)|readiness\b/i.test(question)) {
    for (const term of ['cool', 'cooling', 'liquid', 'power', 'rack']) focused.add(term)
  }
  const prepared = chunks.map((chunk, sourceIndex) => {
    const headingTerms = terms(chunk.heading)
    const headingMatches = [...focused].filter((term) => headingTerms.has(term)).length
    return { chunk, sourceIndex, headingMatches }
  })
  const strongestHeading = Math.max(0, ...prepared.map((item) => item.headingMatches))
  const focusedChunks =
    strongestHeading > 0
      ? prepared.filter((item) => item.headingMatches === strongestHeading)
      : prepared
  const candidates = focusedChunks.flatMap(({ chunk, sourceIndex, headingMatches }) => {
    const chunkTerms = terms(`${chunk.heading} ${chunk.text}`)
    const chunkMatches = [...focused].filter((term) => chunkTerms.has(term)).length
    return chunk.text
      .split(/\r?\n/)
      .flatMap((line, lineIndex) => {
        const segments =
          line.length > 700 ? line.split(/(?<=[.!?])\s+(?=[A-Z0-9])/).filter(Boolean) : [line]
        return segments.map((segment, segmentIndex) => ({
          line: segment,
          lineIndex: lineIndex + segmentIndex / 100
        }))
      })
      .map(({ line, lineIndex }) => {
        const trimmed = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()
        const tableCells = trimmed.startsWith('|')
          ? trimmed
              .split('|')
              .map((cell) => cell.trim())
              .filter(Boolean)
          : []
        return {
          line: tableCells.length > 0 ? tableCells.join('; ') : trimmed,
          lineIndex,
          source: sourceIndex + 1,
          headingMatches,
          chunkMatches,
          heading: chunk.heading
        }
      })
  })
  const selected = candidates
    .filter(({ line, heading }) => {
      const conciseNumericFact =
        line.length >= 8 &&
        /\d/.test(line) &&
        /\b(?:kw|gb|tb|days?|months?|years?|g|mbps|gbps)\b/i.test(line)
      const conciseConfigFact =
        /^(?:address-family|interface|ip address|ip router|name|neighbor|router|switchport|vlan|vrf)\b/i.test(
          line
        )
      const conciseProductFact = /\bUCS\s+C\d{3}\s+M\d\b/i.test(line)
      if (
        (!conciseNumericFact && !conciseConfigFact && !conciseProductFact && line.length < 24) ||
        line.length > 700
      )
        return false
      if (/^(?:[-:;|\s]+|design highlights?|reference|sources?|©|cisco confidential)$/i.test(line))
        return false
      if (heading && line.toLowerCase() === heading.toLowerCase()) return false
      return true
    })
    .map((candidate) => {
      const lineTerms = terms(candidate.line)
      const overlap = [...focused].filter((term) => lineTerms.has(term)).length
      const guidance =
        /\b(?:recommend|recommended|required|use|uses|using|will|must|should|need)\b/i.test(
          candidate.line
        )
          ? 1
          : 0
      const numeric = /\d/.test(candidate.line) ? 1 : 0
      return {
        ...candidate,
        overlap,
        score:
          overlap * 3 +
          candidate.headingMatches * 2 +
          Math.min(2, candidate.chunkMatches) +
          guidance +
          numeric
      }
    })
    .filter(
      (candidate) =>
        candidate.score > 0 &&
        (candidate.overlap > 0 || candidate.headingMatches > 0 || candidate.chunkMatches >= 2)
    )
    .sort(
      (left, right) =>
        right.score - left.score || left.source - right.source || left.lineIndex - right.lineIndex
    )

  const seen = new Set<string>()
  const requestedCount = /\b(?:top|up to)\s+(\d{1,2})\b/i.exec(question)
  const answerLimit = requestedCount
    ? Math.min(25, Number(requestedCount[1]))
    : /\b(?:summari[sz]e|list|which|what|compare)\b.*\b(?:configuration|listed|makers?|steps?|items?|options?|arrangements?|sizing|storage|memory)\b/i.test(
          question
        )
      ? /\bconfiguration\b/i.test(question)
        ? 30
        : 20
      : 8
  const unique = selected
    .filter(({ line }) => {
      const key = line
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, answerLimit)
  if (unique.length === 0) return null
  if (
    /\b(?:use|return|provide|create)\b[^.\n]{0,40}\btable\b|\bcomparison table\b/i.test(question)
  ) {
    return [
      '## Source-supported comparison',
      '',
      '| Source-supported fact | Citation |',
      '| --- | --- |',
      ...unique.map(
        (candidate) => `| ${candidate.line.replaceAll('|', '\\|')} | [${candidate.source}] |`
      )
    ].join('\n')
  }
  return [
    '## Source-supported answer',
    '',
    ...unique.map((candidate) => `- ${candidate.line} [${candidate.source}]`)
  ].join('\n')
}

export function buildDiagramFlowAnswer(question: string, chunks: EvidenceChunk[]): string | null {
  if (!/\boffline\b/i.test(question) || !/\bonline\b/i.test(question)) return null
  const lines = chunks.flatMap((chunk, sourceIndex) =>
    /\.(?:png|jpe?g)$/i.test(chunk.file)
      ? chunk.text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => ({ line, source: sourceIndex + 1 }))
      : []
  )
  if (lines.length === 0) return null
  const exactLine = (pattern: RegExp): { line: string; source: number } | null =>
    lines.find((item) => pattern.test(item.line)) ?? null
  const offline = [
    exactLine(/^Data Sources$/i),
    exactLine(/^Extract\s*\/\s*Chunk$/i),
    exactLine(/^Create Embeddings$/i),
    exactLine(/^Store in Vector DB$/i)
  ].filter((item): item is { line: string; source: number } => Boolean(item))
  const online = [
    exactLine(/^User\s*\/\s*Application$/i),
    exactLine(/^Query$/i),
    exactLine(/^Retrieve Context$/i),
    exactLine(/^LLM Service$/i),
    exactLine(/^Generate Response$/i),
    exactLine(/^Response to User$/i)
  ].filter((item): item is { line: string; source: number } => Boolean(item))
  if (offline.length < 3 || online.length < 4) return null
  return [
    '## Offline ingestion and indexing [1]',
    '',
    offline.map((item, index) => `${index + 1}. ${item.line} [${item.source}]`).join('\n'),
    '',
    '## Online query and inference [1]',
    '',
    online.map((item, index) => `${index + 1}. ${item.line} [${item.source}]`).join('\n')
  ].join('\n')
}

export function buildBenefitOutcomeAnswer(
  question: string,
  chunks: EvidenceChunk[]
): string | null {
  if (!/\b(?:benefits|business outcomes|customer outcomes)\b/i.test(question)) return null
  const lines = chunks.flatMap((chunk, sourceIndex) =>
    chunk.text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => ({ line, source: sourceIndex + 1 }))
  )
  const capabilities = lines.filter(({ line }) =>
    /\b(?:self-service|metering|chargeback|governance|scheduling|resource pooling|optimization)\b/i.test(
      line
    )
  )
  const outcomes = lines.filter(({ line }) =>
    /\b(?:customers? report|typical enterprise|payback|annual savings|cost visibility|transparency|utilization from\s+\d+%|\d+%\s+to\s+\d+%\+?)/i.test(
      line
    )
  )
  const unique = (
    items: Array<{ line: string; source: number }>
  ): Array<{ line: string; source: number }> => [
    ...new Map(items.map((item) => [item.line.toLowerCase(), item])).values()
  ]
  const selectedCapabilities = unique(capabilities).slice(0, 10)
  const selectedOutcomes = unique(outcomes).slice(0, 10)
  if (selectedCapabilities.length < 2 || selectedOutcomes.length < 2) return null
  return [
    '## Platform capabilities stated in the source',
    '',
    ...selectedCapabilities.map((item) => `- ${item.line} [${item.source}]`),
    '',
    '## Qualified customer and business outcomes',
    '',
    ...selectedOutcomes.map((item) => `- ${item.line} [${item.source}]`)
  ].join('\n')
}
