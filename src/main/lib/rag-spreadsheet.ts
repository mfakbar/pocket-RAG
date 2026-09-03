import { queryTerms as terms } from './rag-terms'
import type { EvidenceChunk, StructuredCell, StructuredRow } from './rag-types'

export function buildSpreadsheetSizingAnswer(
  question: string,
  chunks: EvidenceChunk[]
): string | null {
  if (!/\b(?:GPU|H200)\b/i.test(question) || !/\b(?:sizing|targets?)\b/i.test(question)) {
    return null
  }
  const rows = chunks.flatMap((chunk, sourceIndex) =>
    /\.(?:xlsx|xls|csv)$/i.test(chunk.file)
      ? chunk.text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => /^\|?\s*Total GPUs?\b/i.test(line))
          .map((line) => ({
            line: line
              .split('|')
              .map((cell) => cell.trim())
              .filter(Boolean)
              .join('; '),
            sheet: chunk.location.replace(/,\s*[A-Z]+\d+:[A-Z]+\d+$/i, ''),
            source: sourceIndex + 1
          }))
      : []
  )
  const unique = [...new Map(rows.map((row) => [`${row.sheet}:${row.line}`, row])).values()]
  if (unique.length < 2) return null
  const friendlySheet = (sheet: string): string =>
    sheet
      .replace(/^Sheet\s+/i, '')
      .replace(/^S\d+_UC\d+_?/i, '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/^Dev\b/i, 'Development')
      .trim()
  return [
    '## H200 GPU sizing targets stated in the workbook',
    '',
    ...unique.map(
      (row) => `- **${friendlySheet(row.sheet)} (${row.sheet}):** ${row.line} [${row.source}]`
    )
  ].join('\n')
}

export function buildSpreadsheetLabeledFacts(
  question: string,
  chunks: EvidenceChunk[]
): string | null {
  const spreadsheetChunks = chunks.filter((chunk) => /\.(?:xlsx|xls|csv)$/i.test(chunk.file))
  if (spreadsheetChunks.length === 0) return null
  const wantsTotals =
    /\b(?:product|service|subscription|grand|total)\b[^.\n]{0,50}\b(?:price|prices|total|totals)\b|\b(?:price|prices|total|totals)\b[^.\n]{0,50}\b(?:product|service|subscription|grand|total)\b/i.test(
      question
    )
  const wantsGroups = /\b(?:groups?|worker|control[- ]plane|arrangements?|node count)\b/i.test(
    question
  )
  if (!wantsTotals && !wantsGroups) return null

  const facts = spreadsheetChunks.flatMap((chunk, sourceIndex) =>
    chunk.text.split(/\r?\n/).flatMap((rawLine) => {
      const line = rawLine
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join('; ')
      if (!line || /^-+(?:;\s*-+)*$/.test(line)) return []
      const totalFact =
        wantsTotals &&
        /\b(?:product total|service total|subscription total|total price|grand total)\b/i.test(line)
      const groupFact =
        wantsGroups &&
        (/\bgroup name\b/i.test(line) ||
          /\b(?:worker|control[- ]plane|master)\b.*\b(?:node|h200|gpu)\b/i.test(line))
      return totalFact || groupFact ? [{ line, source: sourceIndex + 1 }] : []
    })
  )
  const unique = [
    ...new Map(
      facts.map((fact) => [fact.line.toLowerCase().replace(/\s+/g, ' ').trim(), fact])
    ).values()
  ].slice(0, 24)
  if (unique.length === 0) return null
  return [
    '## Exact labelled spreadsheet facts',
    '',
    '| Workbook label and value | Citation |',
    '| --- | --- |',
    ...unique.map((fact) => `| ${fact.line.replaceAll('|', '\\|')} | [${fact.source}] |`)
  ].join('\n')
}

interface TableRow {
  headers: string[]
  cells: string[]
  source: number
  file: string
  location: string
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function tableRows(chunks: EvidenceChunk[]): TableRow[] {
  return chunks.flatMap((chunk, source) => {
    const lines = chunk.text.split('\n').filter(Boolean)
    const headers = tableCells(lines[0] ?? '')
    if (
      headers.length < 2 ||
      !tableCells(lines[1] ?? '').every((cell) => /^:?-{3,}:?$/.test(cell))
    ) {
      return []
    }
    return lines.slice(2).flatMap((line) => {
      if (!/^\s*\|.*\|\s*$/.test(line)) return []
      return [
        {
          headers,
          cells: tableCells(line),
          source: source + 1,
          file: chunk.file,
          location: chunk.location
        }
      ]
    })
  })
}

function numericValue(value: string): number | null {
  const match = value.match(/(?:[$€£]\s*)?(-?\d[\d,]*(?:\.\d+)?)/)
  if (!match) return null
  const number = Number(match[1].replaceAll(',', ''))
  if (!Number.isFinite(number)) return null
  const unit = value.toLowerCase().match(/\b(days?|weeks?|months?|years?)\b/)?.[1]
  const multiplier = unit?.startsWith('week')
    ? 7
    : unit?.startsWith('month')
      ? 30.4375
      : unit?.startsWith('year')
        ? 365.25
        : 1
  return number * multiplier
}

function requestedField(question: string): RegExp | null {
  if (/\bunit list prices?\b/i.test(question)) return /^unit list price$/i
  if (/\bunit net prices?\b/i.test(question)) return /^unit net price$/i
  if (/\bextended net prices?\b/i.test(question)) return /^extended net price$/i
  if (/\bunit prices?\b/i.test(question)) return /^unit (?:list |net )?price$/i
  if (/\bprices?|costs?\b/i.test(question)) return /\b(?:unit )?(?:list |net )?price|cost\b/i
  if (/\blead times?\b/i.test(question)) return /\blead time|delivery\b/i
  if (/\bmemory(?: configuration)?|\bram\b/i.test(question)) return /\bmemory|ram\b/i
  if (/\bquantit(?:y|ies)|\bqty\b/i.test(question)) return /\bquantity|qty\b/i
  if (/\btotals?|\bsum\b/i.test(question)) return /\btotal\b/i
  if (/\boccupanc(?:y|ies)\b/i.test(question)) return /\boccupanc(?:y|ies)\b/i
  if (/\bpart numbers?|\bsku|\bpid\b/i.test(question)) return /\bpart number|sku|pid\b/i
  if (
    /\b(?:gpu|h200)\b.*\b(?:sizing|target)|\b(?:sizing|target)\b.*\b(?:gpu|h200)\b/i.test(question)
  ) {
    return /\btotal gpus?|h200 allocation|gpus? per instance\b/i
  }
  if (/\bconfigurations?|\bservers?|\boptions?\b/i.test(question)) {
    return /\bconfiguration|server|option|item|model|description\b/i
  }
  return null
}

function typedRowContext(row: StructuredRow): string {
  return row.cells
    .filter((cell) => cell.value)
    .slice(0, 16)
    .map((cell) => `${cell.column}=${cell.value}`)
    .join('; ')
}

function explicitCellSubject(question: string, row: StructuredRow): boolean {
  const compactQuestion = question.toLowerCase().replace(/[^a-z0-9]+/g, '')
  return row.cells.some((cell) => {
    const compactValue = cell.value.toLowerCase().replace(/[^a-z0-9]+/g, '')
    return compactValue.length >= 6 && compactQuestion.includes(compactValue)
  })
}

function combinedQuantityEvidence(question: string, rows: StructuredRow[]): string {
  if (!/\b(?:combined|sum(?:med)?|add up|total)\b/i.test(question)) return ''
  const matchedRows = rows.filter((row) => explicitCellSubject(question, row))
  const quantities = matchedRows.flatMap((row) => {
    const cell = row.cells.find(
      (candidate) => /\bquantity|qty\b/i.test(candidate.column) && candidate.numericValue != null
    )
    return cell ? [{ row, cell }] : []
  })
  if (quantities.length === 0) return ''
  const total = quantities.reduce((sum, item) => sum + (item.cell.numericValue ?? 0), 0)
  return [
    'VERIFIED TYPED SPREADSHEET RESULT',
    'Method: Added the typed quantity from every row containing the exact item named by the user.',
    ...quantities.map(
      ({ row, cell }) =>
        `- ${row.file}, Sheet ${row.sheet}, row ${row.rowIndex}: ${typedRowContext(row)}; operand ${cell.column}=${cell.value}`
    ),
    `Derived combined quantity: ${total.toLocaleString('en-US', { maximumFractionDigits: 6 })}`,
    'This result was calculated locally from typed cells. Cite the matching raw source passages.'
  ].join('\n')
}

function extremeWithCombinedQuantityEvidence(question: string, rows: StructuredRow[]): string {
  if (
    !/\b(?:highest|maximum|max|lowest|minimum|min)\b/i.test(question) ||
    !/\bcombined\b.*\b(?:quantity|qty)\b|\b(?:quantity|qty)\b.*\bcombined\b/i.test(question)
  )
    return ''
  const priceCells = rows.flatMap((row) => {
    const cell = row.cells.find(
      (candidate) =>
        /\b(?:unit )?(?:net |list )?price|cost\b/i.test(candidate.column) &&
        candidate.numericValue != null
    )
    return cell ? [{ row, cell }] : []
  })
  if (priceCells.length === 0) return ''
  const wantsMinimum = /\b(?:lowest|minimum|min)\b/i.test(question)
  const extreme = Math[wantsMinimum ? 'min' : 'max'](
    ...priceCells.map((item) => item.cell.numericValue ?? 0)
  )
  const extremeRows = priceCells.filter((item) => item.cell.numericValue === extreme)
  const partNumbers = new Set(
    extremeRows.flatMap(({ row }) =>
      row.cells
        .filter((cell) => /\bpart number|sku|pid\b/i.test(cell.column) && cell.value)
        .map((cell) => cell.value)
    )
  )
  if (partNumbers.size !== 1) return ''
  const [partNumber] = [...partNumbers]
  const matchingRows = rows.filter((row) =>
    row.cells.some((cell) => cell.value.toLowerCase() === partNumber.toLowerCase())
  )
  const quantities = matchingRows.flatMap((row) => {
    const cell = row.cells.find(
      (candidate) => /\bquantity|qty\b/i.test(candidate.column) && candidate.numericValue != null
    )
    return cell ? [{ row, cell }] : []
  })
  if (quantities.length === 0) return ''
  const combined = quantities.reduce((sum, item) => sum + (item.cell.numericValue ?? 0), 0)
  return [
    'VERIFIED TYPED SPREADSHEET RESULT',
    `Method: Selected the ${wantsMinimum ? 'minimum' : 'maximum'} typed unit price, then added every typed quantity row for the tied part number.`,
    ...quantities.map(
      ({ row, cell }) =>
        `- ${row.file}, Sheet ${row.sheet}, row ${row.rowIndex}: ${typedRowContext(row)}; quantity operand=${cell.value}`
    ),
    `Selected part number: ${partNumber}`,
    `Selected unit price: ${extreme.toLocaleString('en-US', { maximumFractionDigits: 6 })}`,
    `Derived combined quantity: ${combined.toLocaleString('en-US', { maximumFractionDigits: 6 })}`,
    'This result was calculated locally from typed cells. Cite the matching raw source passages.'
  ].join('\n')
}

type NumericConstraint = {
  column: RegExp
  compare: (value: number) => boolean
}

function numericConstraints(question: string): NumericConstraint[] {
  const fields: Array<{ phrases: string[]; column: RegExp }> = [
    {
      phrases: ['estimated lead time', 'lead time'],
      column: /\blead time|delivery\b/i
    },
    { phrases: ['quantity', 'qty'], column: /\bquantity|qty\b/i },
    {
      phrases: ['unit net price', 'unit list price', 'unit price', 'price'],
      column: /\b(?:unit )?(?:net |list )?price|cost\b/i
    }
  ]
  const constraints: NumericConstraint[] = []
  for (const field of fields) {
    for (const phrase of field.phrases) {
      const match = new RegExp(
        `${phrase.replaceAll(' ', '\\s+')}.{0,32}?(at\\s+least|no\\s+less\\s+than|>=|above|over|more\\s+than|>|at\\s+most|no\\s+more\\s+than|<=|below|under|less\\s+than|<)\\s*(?:usd|idr|[$€£])?\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)`,
        'i'
      ).exec(question)
      if (!match) continue
      const threshold = Number(match[2].replaceAll(',', ''))
      const operator = match[1].toLowerCase().replaceAll(/\s+/g, ' ')
      constraints.push({
        column: field.column,
        compare: (value) =>
          /^(?:at least|no less than|>=)$/.test(operator)
            ? value >= threshold
            : /^(?:above|over|more than|>)$/.test(operator)
              ? value > threshold
              : /^(?:at most|no more than|<=)$/.test(operator)
                ? value <= threshold
                : value < threshold
      })
      break
    }
  }
  return constraints
}

function multiAttributeFilterEvidence(question: string, rows: StructuredRow[]): string {
  const constraints = numericConstraints(question)
  if (constraints.length < 2) return ''
  const selected = rows.filter((row) =>
    constraints.every((constraint) => {
      const cell = row.cells.find((candidate) => constraint.column.test(candidate.column))
      return cell?.numericValue != null && constraint.compare(cell.numericValue)
    })
  )
  if (selected.length === 0) return ''
  if (/\blongest\b.*\bfirst\b/i.test(question)) {
    selected.sort((left, right) => {
      const leftValue = left.cells.find((cell) =>
        /\blead time|delivery\b/i.test(cell.column)
      )?.numericValue
      const rightValue = right.cells.find((cell) =>
        /\blead time|delivery\b/i.test(cell.column)
      )?.numericValue
      return (rightValue ?? 0) - (leftValue ?? 0)
    })
  }
  return [
    'VERIFIED TYPED SPREADSHEET RESULT',
    `Method: Applied ${constraints.length} numeric column constraints to typed rows; non-numeric values such as N/A do not pass numeric thresholds.`,
    ...selected
      .slice(0, 80)
      .map(
        (row) => `- ${row.file}, Sheet ${row.sheet}, row ${row.rowIndex}: ${typedRowContext(row)}`
      ),
    'Use only the rows above. Cite the matching raw source passages.'
  ].join('\n')
}

function labelTokens(value: string): string[] {
  return value
    .replace(/\([^)]*\)/g, ' ')
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !/^(?:estimated|stated|value)$/.test(token))
}

function rowLabelComparisonEvidence(question: string, rows: StructuredRow[]): string {
  if (!/\bcompare\b/i.test(question)) return ''
  const questionTerms = new Set(
    question
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
  )
  const selected = rows.filter((row) =>
    row.cells.some((cell) => {
      const tokens = labelTokens(cell.value)
      return (
        tokens.length >= 2 &&
        !tokens.some((token) => /^(?:total|occupancy|gpus?)$/.test(token)) &&
        tokens.every((token) => questionTerms.has(token))
      )
    })
  )
  if (selected.length === 0) return ''
  return [
    'VERIFIED TYPED SPREADSHEET RESULT',
    'Method: Matched the requested row label, then preserved every non-empty typed column from that row, including composite subheaders.',
    ...selected
      .slice(0, 40)
      .map(
        (row) => `- ${row.file}, Sheet ${row.sheet}, row ${row.rowIndex}: ${typedRowContext(row)}`
      ),
    'Use the complete row mapping above. Cite the matching raw source passages.'
  ].join('\n')
}

function labelValueEvidence(question: string, rows: StructuredRow[]): string {
  const questionTerms = new Set(
    question
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
  )
  const matches = rows.flatMap((row) =>
    row.cells.flatMap((labelCell, labelIndex) => {
      const tokens = labelTokens(labelCell.value)
      if (tokens.length < 2 || !tokens.every((token) => questionTerms.has(token))) return []
      const numeric = row.cells.slice(labelIndex + 1).filter((cell) => cell.numericValue != null)
      return numeric.length > 0 ? [{ row, label: tokens.join(' '), numeric }] : []
    })
  )
  if (matches.length === 0) return ''
  const groups = new Map<string, typeof matches>()
  for (const match of matches) groups.set(match.label, [...(groups.get(match.label) ?? []), match])
  const lines = ['VERIFIED TYPED SPREADSHEET RESULT']
  for (const [label, items] of groups) {
    const operands = items.flatMap((item) => {
      const unique = new Map<number, StructuredCell>()
      for (const cell of item.numeric) unique.set(cell.numericValue ?? 0, cell)
      return [...unique.values()].map((cell) => ({ row: item.row, cell }))
    })
    if (/\b(?:sum|add up)\b/i.test(question) && label.includes('total gpu')) {
      const onePerSheet = new Map<string, (typeof operands)[number]>()
      for (const operand of operands) onePerSheet.set(operand.row.sheet, operand)
      const selected = [...onePerSheet.values()]
      const total = selected.reduce((sum, item) => sum + (item.cell.numericValue ?? 0), 0)
      lines.push(
        'Method: Used one explicit Total GPUs value per sheet, then added those typed values.',
        ...selected.map(
          ({ row, cell }) =>
            `- ${row.file}, Sheet ${row.sheet}, row ${row.rowIndex}: Total GPUs=${cell.value}`
        ),
        `Derived Total GPUs across sheets: ${total.toLocaleString('en-US', { maximumFractionDigits: 6 })}`
      )
      continue
    }
    if (/\b(?:highest|maximum|max)\b/i.test(question) && label.includes('occupancy')) {
      const selected = [...operands].sort(
        (left, right) => (right.cell.numericValue ?? 0) - (left.cell.numericValue ?? 0)
      )[0]
      if (selected) {
        lines.push(
          'Method: Selected the maximum typed occupancy value across the requested sheets and scenarios.',
          `- ${selected.row.file}, Sheet ${selected.row.sheet}, row ${selected.row.rowIndex}: scenario ${selected.cell.column}=${selected.cell.value}`
        )
      }
      continue
    }
    const onePerRow = operands.filter(
      (operand, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.row.file === operand.row.file &&
            candidate.row.sheet === operand.row.sheet &&
            candidate.row.rowIndex === operand.row.rowIndex
        ) === index
    )
    const ordered = /\b(?:order|lowest|highest|compare)\b/i.test(question)
      ? [...onePerRow].sort(
          (left, right) => (left.cell.numericValue ?? 0) - (right.cell.numericValue ?? 0)
        )
      : onePerRow
    lines.push(
      `Method: Matched the row label "${label}" to its adjacent typed numeric value${ordered ? ' and ordered the rows from lowest to highest' : ''}.`,
      ...ordered.map(
        ({ row, cell }) =>
          `- ${row.file}, Sheet ${row.sheet}, row ${row.rowIndex}: ${label}=${cell.value}`
      )
    )
    if (/\bdifference\b/i.test(question) && ordered.length >= 2) {
      const difference =
        (ordered.at(-1)?.cell.numericValue ?? 0) - (ordered[0]?.cell.numericValue ?? 0)
      lines.push(
        `Derived highest-minus-lowest difference: ${difference.toLocaleString('en-US', { maximumFractionDigits: 6 })}`
      )
    }
  }
  lines.push(
    'This result was calculated locally from typed cells. Cite the matching raw source passages.'
  )
  return lines.join('\n')
}

function serverKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/server|requirement|\s+/g, '')
    .replace(/[^a-z0-9]/g, '')
}

function crossTableMemoryEvidence(question: string, rows: StructuredRow[]): string {
  if (
    !/\b(?:combine|join)\b/i.test(question) ||
    !/\bboq\b/i.test(question) ||
    !/\bmemory\b/i.test(question) ||
    !/\bquantit(?:y|ies)\b/i.test(question)
  )
    return ''
  const quantities = new Map<string, { row: StructuredRow; quantity: StructuredCell }>()
  for (const row of rows) {
    const quantity = row.cells.find(
      (cell) => /\bquantity|qty\b/i.test(cell.column) && cell.numericValue != null
    )
    const component = row.cells.find((cell) => /\bserver\s*app\s*\d/i.test(cell.value))
    if (quantity && component) quantities.set(serverKey(component.value), { row, quantity })
  }
  const memoryRows = rows.flatMap((row) => {
    if (!row.cells.some((cell) => /^memory$/i.test(cell.value.trim()))) return []
    const specification = row.cells.find((cell) => /\bgb\s+total\b/i.test(cell.value))
    const match = specification?.value.match(/=\s*([0-9][0-9,.]*)\s*GB\s+total\b/i)
    const memory = match ? Number(match[1].replaceAll(',', '')) : null
    return specification && memory != null
      ? [{ row, specification, memory, key: serverKey(row.sheet) }]
      : []
  })
  const joined = memoryRows.flatMap((memory) => {
    const quantity = quantities.get(memory.key)
    return quantity
      ? [{ ...memory, quantity, total: (quantity.quantity.numericValue ?? 0) * memory.memory }]
      : []
  })
  if (joined.length === 0) return ''
  const total = joined.reduce((sum, item) => sum + item.total, 0)
  return [
    'VERIFIED TYPED SPREADSHEET RESULT',
    'Method: Joined each BOQ server quantity to the matching requirement-sheet Memory row, multiplied quantity by the explicitly stated per-server GB total, then added the products.',
    ...joined.map(
      (item) =>
        `- ${item.row.file}, Sheet ${item.row.sheet}, row ${item.row.rowIndex}: BOQ Sheet ${item.quantity.row.sheet} row ${item.quantity.row.rowIndex} quantity=${item.quantity.quantity.value}; per-server memory=${item.memory} GB; derived=${item.total} GB`
    ),
    `Derived total installed memory: ${total.toLocaleString('en-US', { maximumFractionDigits: 6 })} GB`,
    'This result was calculated locally from typed cells. Cite the matching raw source passages.'
  ].join('\n')
}

function typedSpreadsheetEvidence(question: string, rows: StructuredRow[]): string {
  const field = requestedField(question)
  if (!field || rows.length === 0) return ''
  const deterministic =
    crossTableMemoryEvidence(question, rows) ||
    rowLabelComparisonEvidence(question, rows) ||
    labelValueEvidence(question, rows) ||
    multiAttributeFilterEvidence(question, rows) ||
    extremeWithCombinedQuantityEvidence(question, rows) ||
    combinedQuantityEvidence(question, rows)
  if (deterministic) return deterministic
  const subjectTerms = [...terms(question)].filter(
    (term) =>
      !/^(?:unit|price|cost|lead|time|memory|configuration|quantity|qty|total|longest|highest|lowest|maximum|minimum)$/.test(
        term
      ) && !/\.(?:xlsx|xls|csv)$/.test(term)
  )
  const candidates = rows.flatMap((row) => {
    const searchable = row.cells.map((cell) => `${cell.column} ${cell.value}`).join(' ')
    const subjectMatch =
      subjectTerms.length === 0 ||
      subjectTerms.some((term) => searchable.toLowerCase().includes(term))
    if (
      !subjectMatch &&
      !/\b(?:all|each|every|maximum|max|minimum|min|highest|lowest|longest|total|sum)\b/i.test(
        question
      )
    )
      return []
    const matching = row.cells.filter((cell) => field.test(cell.column))
    if (matching.length === 0) return []
    return matching.map((cell) => ({ row, cell }))
  })
  if (candidates.length === 0) return ''

  if (/\b(?:calculate|compute|derive|recompute|sum|add up)\b/i.test(question)) {
    const calculations = rows.flatMap((row) => {
      const quantity = row.cells.find((cell) => /\bquantity|qty\b/i.test(cell.column))
      const price = row.cells.find((cell) => /\b(?:unit )?price|cost\b/i.test(cell.column))
      if (quantity?.numericValue == null || price?.numericValue == null) return []
      return [{ row, quantity, price, total: quantity.numericValue * price.numericValue }]
    })
    if (calculations.length > 0) {
      const total = calculations.reduce((sum, item) => sum + item.total, 0)
      const unit = calculations.find((item) => item.price.unit)?.price.unit ?? ''
      return [
        'VERIFIED TYPED SPREADSHEET RESULT',
        'Method: Multiplied each typed quantity by its typed unit price, then added the row totals.',
        ...calculations
          .slice(0, 48)
          .map(
            ({ row, quantity, price }) =>
              `- ${row.file}, Sheet ${row.sheet}, row ${row.rowIndex}: ${quantity.column}=${quantity.value}; ${price.column}=${price.value}`
          ),
        `Derived total: ${unit === 'USD' ? '$' : unit === 'IDR' ? 'IDR ' : ''}${total.toLocaleString('en-US', { maximumFractionDigits: 6 })}`,
        'This result was calculated locally from typed cells. Cite the matching raw source passages.'
      ].join('\n')
    }
  }

  const wantsMaximum = /\b(?:maximum|max|highest|longest)\b/i.test(question)
  const wantsMinimum = /\b(?:minimum|min|lowest|shortest)\b/i.test(question)
  let selected = candidates
  if (wantsMaximum || wantsMinimum) {
    const measurable = candidates.filter((item) => item.cell.numericValue != null)
    measurable.sort((left, right) =>
      wantsMaximum
        ? (right.cell.numericValue ?? 0) - (left.cell.numericValue ?? 0)
        : (left.cell.numericValue ?? 0) - (right.cell.numericValue ?? 0)
    )
    if (measurable.length > 0) {
      const extreme = measurable[0].cell.numericValue
      selected = measurable.filter((item) => item.cell.numericValue === extreme)
    }
  }
  return [
    'VERIFIED TYPED SPREADSHEET RESULT',
    `Method: ${wantsMaximum || wantsMinimum ? `${wantsMaximum ? 'Maximum' : 'Minimum'} selected from typed numeric values.` : 'Matched the requested field and subject against typed spreadsheet rows.'}`,
    ...selected.slice(0, 48).map(({ row, cell }) => {
      const context = row.cells
        .filter((item) => item.value)
        .slice(0, 14)
        .map((item) => `${item.column}=${item.value}`)
        .join('; ')
      return `- ${row.file}, Sheet ${row.sheet}, row ${row.rowIndex}: ${context}; requested ${cell.column}=${cell.value}`
    }),
    'Use the exact values and units above. Cite the matching raw source passages.'
  ].join('\n')
}

export function structuredSpreadsheetEvidence(
  question: string,
  chunks: EvidenceChunk[],
  structuredRows: StructuredRow[] = []
): string {
  const typed = typedSpreadsheetEvidence(question, structuredRows)
  if (typed) return typed
  const rows = tableRows(chunks)
  const field = requestedField(question)
  if (rows.length === 0 || !field) return ''

  if (/\b(?:calculate|compute|derive|recompute|sum|add up)\b/i.test(question)) {
    const calculations = rows.flatMap((row) => {
      const quantityIndex = row.headers.findIndex((header) => /\bquantity|qty\b/i.test(header))
      const priceIndex = row.headers.findIndex((header) => /\b(?:unit )?price|cost\b/i.test(header))
      if (quantityIndex < 0 || priceIndex < 0) return []
      const quantityText = row.cells[quantityIndex]?.trim() ?? ''
      const priceText = row.cells[priceIndex]?.trim() ?? ''
      const quantity = numericValue(quantityText)
      const price = numericValue(priceText)
      if (quantity === null || price === null) return []
      return [{ row, quantityText, priceText, value: quantity * price }]
    })
    if (calculations.length > 0) {
      const total = calculations.reduce((sum, item) => sum + item.value, 0)
      const currency = calculations.some((item) => /^\s*[$€£]/.test(item.priceText)) ? '$' : ''
      return [
        'VERIFIED STRUCTURED SPREADSHEET RESULT',
        'Method: Multiplied each exact quantity by its exact unit price, then added the row totals.',
        ...calculations
          .slice(0, 24)
          .map(
            ({ row, quantityText, priceText }) =>
              `- [${row.source}] ${row.file}, ${row.location}: quantity=${quantityText}; unit price=${priceText}`
          ),
        `Derived total: ${currency}${total.toLocaleString('en-US', { maximumFractionDigits: 6 })}`,
        'Use the exact operands and calculation method above. Clearly label the total as calculated.'
      ].join('\n')
    }
  }

  const relevant = rows.flatMap((row) => {
    const fieldIndexes = row.headers
      .map((header, index) => (field.test(header) ? index : -1))
      .filter((index) => index >= 0)
    if (fieldIndexes.length === 0) return []
    const rowText = row.cells.join(' ').toLowerCase()
    const subjectTerms = [...terms(question)].filter(
      (term) =>
        !/^(?:unit|price|cost|lead|time|memory|configuration|quantity|qty|total|longest|highest|lowest|maximum|minimum)$/.test(
          term
        ) && !/\.(?:xlsx|xls|csv)$/.test(term)
    )
    const subjectMatch =
      subjectTerms.length === 0 || subjectTerms.some((term) => rowText.includes(term))
    if (
      !subjectMatch &&
      !/\b(?:all|each|every|maximum|max|minimum|min|highest|lowest|longest|total|sum)\b/i.test(
        question
      )
    )
      return []
    return fieldIndexes.flatMap((fieldIndex) => {
      const value = row.cells[fieldIndex]?.trim()
      if (!value) return []
      const labels = row.headers
        .map((header, index) => ({ header, value: row.cells[index]?.trim() }))
        .filter((item) => item.value)
        .slice(0, 12)
        .map((item) => `${item.header || 'Field'}=${item.value}`)
      return [{ ...row, value, labels }]
    })
  })
  if (relevant.length === 0) return ''

  const wantsMaximum = /\b(?:maximum|max|highest|longest)\b/i.test(question)
  const wantsMinimum = /\b(?:minimum|min|lowest|shortest)\b/i.test(question)
  let verified = relevant
  let method = 'Matched the requested field and subject against synchronized spreadsheet rows.'
  if (wantsMaximum || wantsMinimum) {
    const measurable = relevant
      .map((row) => ({ row, value: numericValue(row.value) }))
      .filter(
        (item): item is { row: (typeof relevant)[number]; value: number } => item.value !== null
      )
    if (measurable.length > 0) {
      measurable.sort((left, right) =>
        wantsMaximum ? right.value - left.value : left.value - right.value
      )
      verified = [measurable[0].row]
      method = `${wantsMaximum ? 'Maximum' : 'Minimum'} selected by comparing the exact source values; duration units were normalized only for ordering.`
    }
  }

  return [
    'VERIFIED STRUCTURED SPREADSHEET RESULT',
    `Method: ${method}`,
    ...verified
      .slice(0, 24)
      .map((row) => `- [${row.source}] ${row.file}, ${row.location}: ${row.labels.join('; ')}`),
    'Use these verified rows for the answer. You may explain the result, but do not change source values or units.'
  ].join('\n')
}

function spreadsheetRowCitations(line: string, chunks: EvidenceChunk[]): number[] {
  const match = /^- (.+), Sheet (.+), row (\d+):/.exec(line)
  if (!match) return []
  const [, file, sheet, rowText] = match
  const findChunk = (targetSheet: string, targetRow: number): number | null => {
    const index = chunks.findIndex((chunk) => {
      if (chunk.file !== file) return false
      const location = new RegExp(
        `^Sheet ${targetSheet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, [A-Z]+(\\d+):[A-Z]+(\\d+)$`
      ).exec(chunk.location)
      if (!location) return false
      return targetRow >= Number(location[1]) && targetRow <= Number(location[2])
    })
    return index >= 0 ? index + 1 : null
  }
  const citations = [findChunk(sheet, Number(rowText))]
  const boq = /BOQ Sheet (.+?) row (\d+)/i.exec(line)
  if (boq) citations.push(findChunk(boq[1], Number(boq[2])))
  return [...new Set(citations.filter((value): value is number => value != null))]
}

export function structuredSpreadsheetAnswer(
  question: string,
  chunks: EvidenceChunk[],
  structuredRows: StructuredRow[] = []
): string {
  const evidence = structuredSpreadsheetEvidence(question, chunks, structuredRows)
  if (!evidence.startsWith('VERIFIED TYPED SPREADSHEET RESULT')) return ''
  const lines = evidence.split('\n').slice(1)
  const answer = ['## Verified spreadsheet result', '']
  for (const line of lines) {
    if (!line.trim()) continue
    if (/^Use |^This result was calculated locally/i.test(line)) continue
    if (/^Method:/i.test(line)) {
      answer.push(`**${line}**`, '')
      continue
    }
    if (line.startsWith('- ')) {
      const citations = spreadsheetRowCitations(line, chunks)
      answer.push(
        citations.length ? `${line} ${citations.map((value) => `[${value}]`).join(' ')}` : line
      )
      continue
    }
    if (/^(?:Derived|Selected)/i.test(line)) {
      answer.push('', `**${line}**`)
      continue
    }
    answer.push(line)
  }
  return answer
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
