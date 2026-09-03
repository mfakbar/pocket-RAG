export type RetrievalMode =
  | 'direct_lookup'
  | 'document_summary'
  | 'spreadsheet_comparison'
  | 'procedure_checklist'
  | 'cross_document'
  | 'ambiguous'

export interface EvidenceChunk {
  text: string
  file: string
  path: string
  location: string
  heading: string
  score: number
  knowledgeBaseId?: string
  documentId?: string
  chunkIndex?: number
}

export interface StructuredCell {
  columnIndex: number
  column: string
  address: string
  value: string
  rawValue: string
  valueType: string
  numericValue: number | null
  unit: string
  formula: string
}

export interface StructuredRow {
  knowledgeBaseId: string
  documentId: string
  path: string
  file: string
  sheet: string
  rowIndex: number
  cells: StructuredCell[]
  score: number
}

export interface HierarchicalSummary {
  knowledgeBaseId: string
  documentId: string
  path: string
  file: string
  heading: string
  location: string
  summary: string
  score: number
}

export interface EvidenceCoverage {
  requested: string[]
  covered: string[]
  missing: string[]
}
