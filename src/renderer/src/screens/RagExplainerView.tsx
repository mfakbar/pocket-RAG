import {
  ArrowLeft,
  ArrowRight,
  Binary,
  Bot,
  Check,
  CheckCircle2,
  Database,
  FileSearch,
  FolderOpen,
  Layers3,
  ListFilter,
  Lock,
  MessageSquareText,
  Quote,
  Scissors,
  Search,
  ShieldCheck,
  Sparkles,
  type LucideIcon
} from 'lucide-react'
import { useRef, useState } from 'react'
import type { AppSettings } from '../../../shared/contracts'
import { Panel } from '../components/ui'
import {
  GENERATION_INPUTS,
  getRagExplainerStage,
  RAG_JOURNEY_RELATIONS,
  ragStageJourneyLabel,
  relatedStageIds,
  relationsForStage,
  stagesForPhase,
  type GenerationInputId,
  type RagExplainerStage,
  type RagStageId
} from '../lib/rag-explainer-content'

const STAGE_ICONS: Record<RagStageId, LucideIcon> = {
  'local-folder': FolderOpen,
  extract: FileSearch,
  chunk: Scissors,
  'document-embedding': Binary,
  'vector-database': Database,
  'user-prompt': MessageSquareText,
  'query-embedding': Sparkles,
  'hybrid-search': Search,
  reranker: ListFilter,
  'grounded-context': Quote,
  'output-tokens': Bot,
  'verify-citations': ShieldCheck
}

const GENERATION_INPUT_ICONS: Record<GenerationInputId, LucideIcon> = {
  'answer-rules': ShieldCheck,
  'user-context': MessageSquareText,
  'grounded-evidence': Quote
}

const PREPARE_STAGES = stagesForPhase('prepare')
const ANSWER_STAGES = stagesForPhase('answer')

function Pipeline({
  label,
  description,
  stages,
  selected,
  relatedStages,
  onSelect
}: {
  label: string
  description: string
  stages: RagExplainerStage[]
  selected: RagStageId
  relatedStages: ReadonlySet<RagStageId>
  onSelect: (id: RagStageId) => void
}): React.JSX.Element {
  return (
    <Panel className="p-4">
      <div className="mb-3 flex items-center justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md bg-primary/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-primary">
              {label}
            </span>
            <span className="text-xs text-muted-foreground">{description}</span>
          </div>
        </div>
      </div>
      <div className="relative overflow-x-auto pb-1">
        <div className="absolute left-[7%] right-[7%] top-7 h-px bg-border" aria-hidden="true" />
        <div
          className="relative z-10 grid gap-2"
          style={{
            gridTemplateColumns: `repeat(${stages.length}, minmax(96px, 1fr))`,
            minWidth: `${stages.length * 104}px`
          }}
        >
          {stages.map((stage) => {
            const Icon = STAGE_ICONS[stage.id]
            const active = selected === stage.id
            const related = relatedStages.has(stage.id)
            return (
              <button
                key={stage.id}
                type="button"
                onClick={() => onSelect(stage.id)}
                aria-pressed={active}
                aria-label={`Open ${stage.title}`}
                className={`flex min-h-[88px] min-w-0 flex-col items-center justify-center rounded-xl border px-2 py-2.5 text-center transition-colors ${
                  active
                    ? 'selected-primary border-primary/30 text-foreground'
                    : related
                      ? 'border-primary/35 bg-primary/10 text-foreground ring-1 ring-primary/15'
                      : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground'
                }`}
              >
                <span
                  className={`mb-2 flex h-9 w-9 items-center justify-center rounded-full border ${
                    active
                      ? 'border-primary/30 bg-primary text-primary-foreground'
                      : 'border-border bg-background text-primary'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 text-[11px] font-semibold leading-tight text-foreground">
                  {stage.shortTitle}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </Panel>
  )
}

function JourneyConnectionMap({
  selected,
  onSelect
}: {
  selected: RagStageId
  onSelect: (id: RagStageId) => void
}): React.JSX.Element {
  const activeRelationIds = new Set(relationsForStage(selected).map((relation) => relation.id))

  return (
    <Panel className="p-4" aria-label="How the two RAG journeys connect">
      <div className="mb-3 flex items-start justify-between gap-5">
        <div>
          <h3 className="text-xs font-semibold text-foreground">How Journey 1 powers Journey 2</h3>
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
            Your files build a searchable local index. They do not retrain the chat model.
          </p>
        </div>
        <span className="hidden rounded-full border border-border bg-background px-2 py-1 text-[9px] text-muted-foreground md:block">
          Select a connection to trace it
        </span>
      </div>

      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        {RAG_JOURNEY_RELATIONS.map((relation) => {
          const active = activeRelationIds.has(relation.id)
          const kindLabel =
            relation.kind === 'shared'
              ? 'Shared capability'
              : relation.kind === 'data'
                ? 'Data flow'
                : 'Citation provenance'
          return (
            <button
              key={relation.id}
              type="button"
              onClick={() => onSelect(relation.fromStageIds[0])}
              aria-pressed={active}
              className={`rounded-xl border p-3 text-left transition-colors ${
                active
                  ? 'border-primary/40 bg-primary/10 ring-1 ring-primary/15'
                  : 'border-border bg-background hover:bg-accent'
              }`}
            >
              <p className="text-[9px] font-semibold uppercase tracking-[0.11em] text-primary">
                {kindLabel}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <span className="min-w-0 flex-1 rounded-md border border-border bg-card px-2 py-1.5 text-center text-[10px] font-semibold leading-tight text-foreground">
                  {relation.fromLabel}
                </span>
                <span className="flex min-w-8 items-center gap-1" aria-hidden="true">
                  <span
                    className={`h-px flex-1 ${
                      relation.kind === 'shared'
                        ? 'border-t border-dashed border-[var(--chart-2)]'
                        : relation.kind === 'provenance'
                          ? 'border-t border-dotted border-[var(--status-success)]'
                          : 'bg-primary'
                    }`}
                  />
                  <ArrowRight
                    className={`h-3.5 w-3.5 ${
                      relation.kind === 'shared'
                        ? 'text-[var(--chart-2)]'
                        : relation.kind === 'provenance'
                          ? 'text-[var(--status-success)]'
                          : 'text-primary'
                    }`}
                  />
                </span>
                <span className="min-w-0 flex-1 rounded-md border border-border bg-card px-2 py-1.5 text-center text-[10px] font-semibold leading-tight text-foreground">
                  {relation.toLabel}
                </span>
              </div>
              <p className="mt-2 text-[10px] font-semibold leading-relaxed text-foreground">
                {relation.connectorLabel}
              </p>
              <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                {relation.description}
              </p>
            </button>
          )
        })}
      </div>
    </Panel>
  )
}

function ExampleFrame({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="native-subtle min-h-[230px] overflow-hidden p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Representative view
        </span>
        <span className="rounded-full border border-border bg-background px-2 py-1 text-[10px] text-muted-foreground">
          Illustrative data
        </span>
      </div>
      {children}
    </div>
  )
}

function Tag({
  children,
  tone = 'default'
}: {
  children: React.ReactNode
  tone?: 'default' | 'blue' | 'green'
}): React.JSX.Element {
  const className =
    tone === 'blue'
      ? 'border-primary/25 bg-primary/10 text-primary'
      : tone === 'green'
        ? 'border-[color-mix(in_srgb,var(--status-success)_25%,transparent)] bg-[var(--status-success-surface)] text-[var(--status-success)]'
        : 'border-border bg-background text-muted-foreground'
  return <span className={`rounded-md border px-2 py-1 text-[10px] ${className}`}>{children}</span>
}

function Vector({ values }: { values: number[] }): React.JSX.Element {
  return (
    <div className="grid grid-cols-8 gap-1.5">
      {values.map((value, index) => (
        <div
          key={`${value}-${index}`}
          className="rounded-md border border-primary/20 bg-primary/10 px-1 py-2 text-center font-mono text-[10px] text-primary"
        >
          {value > 0 ? '+' : ''}
          {value.toFixed(2)}
        </div>
      ))}
    </div>
  )
}

function StageExample({ id }: { id: RagStageId }): React.JSX.Element {
  switch (id) {
    case 'local-folder':
      return (
        <ExampleFrame>
          <div className="rounded-lg border border-border bg-background p-3">
            <div className="mb-3 flex items-center gap-2 border-b border-border pb-2.5">
              <FolderOpen className="h-4 w-4 text-primary" />
              <span className="text-xs font-semibold text-foreground">Customer Knowledge</span>
              <Tag tone="green">Local only</Tag>
            </div>
            {[
              ['Security_Guide.pdf', '42 pages', 'PDF'],
              ['Network_Design.docx', '18 sections', 'DOCX'],
              ['Bill_of_Materials.xlsx', '3 sheets', 'XLSX'],
              ['Deployment_Notes.md', '126 lines', 'MD']
            ].map(([name, detail, type]) => (
              <div key={name} className="flex items-center gap-3 py-2 text-xs">
                <FileSearch className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">{name}</span>
                <span className="text-[10px] text-muted-foreground">{detail}</span>
                <Tag>{type}</Tag>
              </div>
            ))}
          </div>
        </ExampleFrame>
      )
    case 'extract':
      return (
        <ExampleFrame>
          <div className="grid grid-cols-[130px_1fr] gap-3">
            <div className="space-y-2">
              <Tag tone="blue">Security_Guide.pdf</Tag>
              <div className="rounded-lg border border-border bg-background p-3 text-[10px] leading-relaxed text-muted-foreground">
                <p className="font-semibold text-foreground">Source map</p>
                <p className="mt-2">Page 12</p>
                <p>Heading: Access control</p>
                <p>Paragraphs 3–5</p>
              </div>
            </div>
            <div className="rounded-lg border border-border bg-background p-3 font-mono text-[11px] leading-relaxed text-foreground">
              <span className="text-primary"># Access control</span>
              <br />
              Administrators must use role-based access. Production changes require an approved
              change record and a second reviewer.
              <br />
              <br />
              <span className="text-muted-foreground">
                [table preserved: Role | Permission | Scope]
              </span>
            </div>
          </div>
        </ExampleFrame>
      )
    case 'chunk':
      return (
        <ExampleFrame>
          <div className="grid grid-cols-3 gap-2">
            {[
              ['Chunk 07', 'Page 12', 'Administrators must use role-based access…'],
              [
                'Chunk 08',
                'Pages 12–13',
                '…approved change record and a second reviewer. Emergency access…'
              ],
              ['Chunk 09', 'Page 13', 'Emergency access expires after four hours…']
            ].map(([label, location, text], index) => (
              <div key={label} className="rounded-lg border border-border bg-background p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-semibold text-primary">{label}</span>
                  <span className="text-[9px] text-muted-foreground">{location}</span>
                </div>
                <p className="mt-3 text-[11px] leading-relaxed text-foreground">{text}</p>
                {index === 1 && (
                  <div className="mt-3 rounded bg-primary/10 px-2 py-1 text-[9px] text-primary">
                    100-token overlap keeps the idea connected
                  </div>
                )}
              </div>
            ))}
          </div>
        </ExampleFrame>
      )
    case 'document-embedding':
      return (
        <ExampleFrame>
          <div className="rounded-lg border border-border bg-background p-3">
            <p className="text-[11px] text-muted-foreground">Chunk text</p>
            <p className="mt-1 text-xs font-medium text-foreground">
              “Production changes require an approved change record.”
            </p>
          </div>
          <div className="my-3 flex items-center justify-center gap-2 text-[10px] font-semibold text-primary">
            <Sparkles className="h-3.5 w-3.5" />
            LOCAL EMBEDDING MODEL
          </div>
          <Vector values={[0.18, -0.22, 0.74, 0.05, -0.31, 0.61, 0.09, -0.14]} />
          <p className="mt-2 text-center text-[10px] text-muted-foreground">
            abbreviated vector · real output contains many more dimensions
          </p>
        </ExampleFrame>
      )
    case 'vector-database':
      return (
        <ExampleFrame>
          <div className="overflow-hidden rounded-lg border border-border bg-background">
            <div className="grid grid-cols-[56px_1fr_92px_1.4fr_1fr] gap-2 border-b border-border bg-secondary px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
              <span>ID</span>
              <span>Source</span>
              <span>Location</span>
              <span>Passage</span>
              <span>Vector</span>
            </div>
            {[
              [
                'c-008',
                'Security_Guide.pdf',
                'Page 12',
                'Production changes require…',
                '[+.18, −.22, …]'
              ],
              [
                'c-021',
                'Network_Design.docx',
                'Access model',
                'Reviewers validate the…',
                '[+.11, −.29, …]'
              ],
              [
                'c-034',
                'Bill_of_Materials.xlsx',
                'Sheet BOM, A2:F18',
                'Part | Qty | Price…',
                '[−.04, +.52, …]'
              ]
            ].map((row) => (
              <div
                key={row[0]}
                className="grid grid-cols-[56px_1fr_92px_1.4fr_1fr] gap-2 border-b border-border px-3 py-2.5 text-[10px] last:border-0"
              >
                {row.map((cell, index) => (
                  <span
                    key={cell}
                    className={
                      index === 0 || index === 4
                        ? 'font-mono text-primary'
                        : 'truncate text-foreground'
                    }
                  >
                    {cell}
                  </span>
                ))}
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Tag tone="green">Stored on this Mac</Tag>
            <Tag>Searchable derivatives</Tag>
            <Tag>Linked to originals</Tag>
          </div>
        </ExampleFrame>
      )
    case 'user-prompt':
      return (
        <ExampleFrame>
          <div className="rounded-xl bg-primary px-4 py-3 text-sm text-primary-foreground">
            What approval is required before a production change?
          </div>
          <p className="mb-2 mt-4 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            One possible token view
          </p>
          <div className="flex flex-wrap gap-1.5">
            {[
              'What',
              ' approval',
              ' is',
              ' required',
              ' before',
              ' a',
              ' production',
              ' change',
              '?'
            ].map((token, index) => (
              <span
                key={`${token}-${index}`}
                className="rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[10px] text-foreground"
              >
                {token}
              </span>
            ))}
          </div>
          <div className="mt-4 flex gap-2">
            <Tag tone="blue">Direct lookup</Tag>
            <Tag>Topic: change approval</Tag>
          </div>
        </ExampleFrame>
      )
    case 'query-embedding':
      return (
        <ExampleFrame>
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
            <div className="rounded-lg border border-border bg-background p-3 text-xs text-foreground">
              What approval is required before a production change?
            </div>
            <Sparkles className="h-5 w-5 text-primary" />
            <div className="rounded-lg border border-primary/20 bg-primary/10 p-3 font-mono text-[10px] text-primary">
              [+0.21, −0.19, +0.68, +0.08, …]
            </div>
          </div>
          <div className="mt-4 rounded-lg border border-border bg-background p-3">
            <p className="text-[10px] font-semibold text-foreground">Shared meaning space</p>
            <div className="mt-3 space-y-2 text-[10px]">
              <div className="flex items-center gap-2">
                <span className="w-24 text-muted-foreground">Question vector</span>
                <div className="h-2 flex-1 rounded-full bg-primary/80" />
              </div>
              <div className="flex items-center gap-2">
                <span className="w-24 text-muted-foreground">Relevant passage</span>
                <div className="h-2 w-[88%] rounded-full bg-primary/60" />
              </div>
              <div className="flex items-center gap-2">
                <span className="w-24 text-muted-foreground">Unrelated passage</span>
                <div className="h-2 w-[24%] rounded-full bg-secondary" />
              </div>
            </div>
          </div>
        </ExampleFrame>
      )
    case 'hybrid-search':
      return (
        <ExampleFrame>
          <div className="mb-3 grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-primary/25 bg-primary/10 p-2.5">
              <p className="text-[10px] font-semibold text-primary">Meaning · 50% influence</p>
              <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                Compares the question vector with passage vectors, so similar ideas can match even
                when the wording differs.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-background p-2.5">
              <p className="text-[10px] font-semibold text-foreground">Keywords · 50% influence</p>
              <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                Rewards exact terms such as filenames, product names, numbers and phrases.
              </p>
            </div>
          </div>
          <div className="space-y-2">
            {[
              [
                '1',
                'Security_Guide.pdf · Page 12',
                'Production changes require an approved change record…',
                '0.91'
              ],
              [
                '2',
                'Network_Design.docx · Access model',
                'A second reviewer validates production access…',
                '0.78'
              ],
              [
                '3',
                'Deployment_Notes.md · Lines 44–51',
                'The production window begins after approval…',
                '0.63'
              ]
            ].map(([rank, source, text, score]) => (
              <div
                key={rank}
                className="grid grid-cols-[28px_1fr_auto] items-center gap-3 rounded-lg border border-border bg-background p-2.5"
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                  {rank}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[10px] font-semibold text-foreground">
                    {source}
                  </span>
                  <span className="block truncate text-[10px] text-muted-foreground">{text}</span>
                </span>
                <span className="font-mono text-[10px] text-primary">{score}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
            The decimal is an illustrative combined relevance score used to order these candidates.
            Higher means a stronger match within this search; compare it only with the other results
            shown here. It is not a probability or a measure of factual correctness. The 50/50
            balance is an example; the actual balance follows Advanced Settings.
          </p>
        </ExampleFrame>
      )
    case 'reranker':
      return (
        <ExampleFrame>
          <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-3">
            <div>
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Before
              </p>
              {['Deployment notes', 'Security guide', 'Network design'].map((item, index) => (
                <div
                  key={item}
                  className="mb-1.5 rounded-lg border border-border bg-background px-3 py-2 text-[10px] text-foreground"
                >
                  <span className="mr-2 text-muted-foreground">{index + 1}</span>
                  {item}
                </div>
              ))}
            </div>
            <ListFilter className="mt-12 h-5 w-5 text-primary" />
            <div>
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                After reading together
              </p>
              {[
                ['Security guide', '0.96'],
                ['Network design', '0.81'],
                ['Deployment notes', '0.54']
              ].map(([item, score], index) => (
                <div
                  key={item}
                  className={`mb-1.5 flex justify-between rounded-lg border px-3 py-2 text-[10px] ${index === 0 ? 'border-primary/30 bg-primary/10 text-foreground' : 'border-border bg-background text-foreground'}`}
                >
                  <span>
                    <span className="mr-2 text-primary">{index + 1}</span>
                    {item}
                  </span>
                  <span className="font-mono text-primary">{score}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 rounded-lg border border-border bg-background px-3 py-2 text-[10px] leading-relaxed text-muted-foreground">
            <span className="font-semibold text-foreground">What the decimals mean: </span>
            the reranker assigns each question-passage pair a relevance score from 0 to 1. Higher
            means the passage appears to answer the question more directly relative to these
            candidates. It is a ranking signal, not a probability or factual-confidence score.
            Direct lookups can skip this optional step.
          </div>
        </ExampleFrame>
      )
    case 'grounded-context':
      return (
        <ExampleFrame>
          <div className="mb-3 flex items-center justify-between gap-3">
            <Tag tone="blue">Output · Grounded evidence</Tag>
            <span className="text-[10px] text-muted-foreground">Used by Generate</span>
          </div>
          <div className="grid grid-cols-[1fr_170px] gap-3">
            <div className="rounded-lg border border-border bg-background p-3 font-mono text-[10px] leading-relaxed text-foreground">
              <span className="text-primary">GROUNDED EVIDENCE</span>
              <br />
              <br />
              <span className="text-primary">[1]</span> File: Security_Guide.pdf
              <br />
              Location: Page 12
              <br />
              Content: Production changes require an approved change record and a second reviewer.
              <br />
              <br />
              <span className="text-primary">[2]</span> File: Network_Design.docx
              <br />
              Section: Access model
              <br />
              Content: Reviewers validate production access.
            </div>
            <div className="space-y-2">
              {[
                'Best evidence selected',
                'Locations preserved',
                'Secrets redacted',
                'Context budget respected'
              ].map((item) => (
                <div
                  key={item}
                  className="flex items-center gap-2 rounded-lg border border-border bg-background p-2 text-[10px] text-foreground"
                >
                  <Check className="h-3.5 w-3.5 text-[var(--status-success)]" />
                  {item}
                </div>
              ))}
            </div>
          </div>
        </ExampleFrame>
      )
    case 'output-tokens':
      return (
        <ExampleFrame>
          <div className="mb-2 grid grid-cols-3 gap-2">
            {GENERATION_INPUTS.map((input) => {
              const Icon = GENERATION_INPUT_ICONS[input.id]
              return (
                <div key={input.id} className="rounded-lg border border-border bg-background p-2.5">
                  <div className="flex items-center gap-1.5 text-[10px] font-semibold text-foreground">
                    <Icon className="h-3.5 w-3.5 text-primary" />
                    {input.title}
                  </div>
                  <p className="mt-1 text-[9px] font-semibold uppercase tracking-wide text-primary">
                    {input.source}
                  </p>
                  <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
                    {input.description}
                  </p>
                </div>
              )
            })}
          </div>
          <div className="mb-2 text-center text-[10px] font-medium text-primary">
            Combined as one model input ↓
          </div>
          <div className="rounded-lg border border-primary/20 bg-primary/10 p-4">
            <div className="mb-2 flex items-center gap-2">
              <Bot className="h-4 w-4 text-primary" />
              <span className="text-[10px] font-semibold text-primary">
                LOCAL CHAT MODEL · STREAMING
              </span>
            </div>
            <p className="text-sm leading-relaxed text-foreground">
              Production <span className="rounded bg-background px-1">changes</span> require{' '}
              <span className="rounded bg-background px-1">an approved</span>{' '}
              <span className="rounded bg-background px-1">change record</span> and{' '}
              <span className="rounded bg-background px-1">a second reviewer</span>{' '}
              <span className="text-primary">[1]</span>
              <span className="ml-1 inline-block h-4 w-1 animate-pulse bg-primary align-middle" />
            </p>
          </div>
          <p className="mt-3 text-[10px] text-muted-foreground">
            Answer rules control how the model responds, user context tells it what is being asked,
            and grounded evidence supplies the facts. They guide every next-token choice but do not
            become separate token types. Citation marker [1] links the generated claim back to
            grounded evidence [1]. Highlighted groups illustrate tokens arriving over time; actual
            boundaries vary by model.
          </p>
        </ExampleFrame>
      )
    case 'verify-citations':
      return (
        <ExampleFrame>
          <div className="grid grid-cols-[180px_1fr] gap-3">
            <div className="space-y-2">
              {[
                'Citation [1] exists',
                'Claim matches passage',
                'Numbers copied exactly',
                'Sensitive values absent'
              ].map((item) => (
                <div
                  key={item}
                  className="flex items-center gap-2 rounded-lg border border-[color-mix(in_srgb,var(--status-success)_22%,transparent)] bg-[var(--status-success-surface)] p-2 text-[10px] text-[var(--status-success)]"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {item}
                </div>
              ))}
            </div>
            <div className="rounded-lg border border-border bg-background p-4">
              <div className="mb-2 flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-primary" />
                <span className="text-[10px] font-semibold text-foreground">Verified answer</span>
              </div>
              <p className="text-xs leading-relaxed text-foreground">
                A production change requires an approved change record and a second reviewer{' '}
                <span className="font-semibold text-primary">[1]</span>.
              </p>
              <div className="mt-4 border-t border-border pt-3">
                <p className="text-[10px] font-semibold text-primary">[1] Security_Guide.pdf</p>
                <p className="text-[10px] text-muted-foreground">Page 12 · Access control</p>
              </div>
            </div>
          </div>
        </ExampleFrame>
      )
  }
}

export default function RagExplainerView({
  settings,
  onBack
}: {
  settings: AppSettings
  onBack: () => void
}): React.JSX.Element {
  const [selected, setSelected] = useState<RagStageId>('local-folder')
  const detailRef = useRef<HTMLDivElement>(null)
  const stage = getRagExplainerStage(selected)
  const StageIcon = STAGE_ICONS[selected]
  const relatedStages = new Set(relatedStageIds(selected))
  const activeRelations = relationsForStage(selected)
  const selectFromConnection = (id: RagStageId): void => {
    setSelected(id)
    requestAnimationFrame(() =>
      detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    )
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-3 sm:p-6">
      <div className="mx-auto w-full max-w-5xl pb-8">
        <div className="mb-5 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center sm:gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <button
              onClick={onBack}
              className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Back to advanced settings"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-foreground">
                What happens behind the scenes
              </h2>
              <p className="text-xs text-muted-foreground">
                Follow a document in, then follow a grounded answer out
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-[color-mix(in_srgb,var(--status-success)_24%,transparent)] bg-[var(--status-success-surface)] px-3 py-1.5 text-[10px] font-medium text-[var(--status-success)]">
            <Lock className="h-3.5 w-3.5" />
            Runs locally on this Mac
          </div>
        </div>

        <Panel className="mb-3 overflow-hidden p-4 sm:p-5">
          <div className="grid grid-cols-1 items-center gap-6 md:grid-cols-[1fr_auto]">
            <div>
              <div className="mb-2 flex items-center gap-2">
                <Layers3 className="h-5 w-5 text-primary" />
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">
                  RAG · Retrieval-Augmented Generation
                </span>
              </div>
              <h3 className="text-xl font-semibold text-foreground">
                The model answers with evidence from your files
              </h3>
              <p className="mt-2 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                RAG first retrieves the most useful local passages, then gives that evidence to the
                chat model. Select any stage below to inspect what goes in, what comes out, and why
                the step matters.
              </p>
            </div>
            <div className="hidden min-w-[210px] space-y-2 rounded-xl border border-border bg-background p-3 md:block">
              <div className="flex items-center justify-between gap-3 text-[10px]">
                <span className="text-muted-foreground">Embedding</span>
                <span
                  className="max-w-[130px] truncate font-mono text-foreground"
                  title={settings.embeddingModel}
                >
                  {settings.embeddingModel}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 text-[10px]">
                <span className="text-muted-foreground">Reranker</span>
                <span
                  className="max-w-[130px] truncate font-mono text-foreground"
                  title={
                    settings.rag.improveDocumentMatching
                      ? settings.rerankerModel
                      : 'Off in current settings'
                  }
                >
                  {settings.rag.improveDocumentMatching
                    ? settings.rerankerModel
                    : 'Off in current settings'}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 text-[10px]">
                <span className="text-muted-foreground">Vector store</span>
                <span className="font-medium text-foreground">LanceDB · local</span>
              </div>
            </div>
          </div>
        </Panel>

        <div className="space-y-3">
          <Pipeline
            label="Journey 1 · Prepare knowledge"
            description="Runs when local files are synced"
            stages={PREPARE_STAGES}
            selected={selected}
            relatedStages={relatedStages}
            onSelect={setSelected}
          />
          <Pipeline
            label="Journey 2 · Answer a question"
            description="Uses the prepared index for every prompt"
            stages={ANSWER_STAGES}
            selected={selected}
            relatedStages={relatedStages}
            onSelect={setSelected}
          />
        </div>

        <div ref={detailRef} className="mt-3 scroll-mt-4">
          <Panel className="p-4 sm:p-5" aria-live="polite">
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(210px,0.72fr)_minmax(0,1.7fr)]">
              <div>
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                    <StageIcon className="h-5 w-5" />
                  </span>
                  <div>
                    <p className="text-[10px] font-semibold tracking-[0.04em] text-primary">
                      {ragStageJourneyLabel(stage)}
                    </p>
                    <h3 className="mt-1 text-base font-semibold text-foreground">{stage.title}</h3>
                  </div>
                </div>
                <p className="mt-4 text-xs leading-relaxed text-muted-foreground">{stage.detail}</p>
                {stage.optional && (
                  <div className="mt-3 rounded-lg border border-primary/20 bg-primary/10 px-3 py-2 text-[10px] leading-relaxed text-primary">
                    Optional step ·{' '}
                    {settings.rag.improveDocumentMatching
                      ? 'Enabled in the current settings and applied only when useful.'
                      : 'Currently off. The walkthrough still shows what it does when enabled.'}
                  </div>
                )}
                {activeRelations.length > 0 && (
                  <div className="mt-3 rounded-lg border border-primary/20 bg-primary/10 px-3 py-2.5">
                    <p className="text-[9px] font-semibold uppercase tracking-[0.11em] text-primary">
                      Connected across the journeys
                    </p>
                    <div className="mt-1.5 space-y-1.5">
                      {activeRelations.map((relation) => (
                        <p
                          key={relation.id}
                          className="text-[10px] leading-relaxed text-foreground"
                        >
                          <span className="font-semibold">{relation.connectorLabel}: </span>
                          {relation.description}
                        </p>
                      ))}
                    </div>
                  </div>
                )}
                <dl className="mt-4 space-y-3 border-t border-border pt-4 text-[10px]">
                  <div>
                    <dt className="font-semibold uppercase tracking-wide text-muted-foreground">
                      Goes in
                    </dt>
                    <dd className="mt-1 leading-relaxed text-foreground">{stage.inputLabel}</dd>
                  </div>
                  <div>
                    <dt className="font-semibold uppercase tracking-wide text-muted-foreground">
                      Comes out
                    </dt>
                    <dd className="mt-1 leading-relaxed text-foreground">{stage.outputLabel}</dd>
                  </div>
                  <div className="rounded-lg bg-primary/10 p-3">
                    <dt className="font-semibold text-primary">Key idea</dt>
                    <dd className="mt-1 leading-relaxed text-foreground">{stage.keyIdea}</dd>
                  </div>
                </dl>
              </div>
              <StageExample id={selected} />
            </div>
          </Panel>
        </div>

        <div className="mt-3">
          <JourneyConnectionMap selected={selected} onSelect={selectFromConnection} />
        </div>

        <p className="mt-3 text-center text-[10px] leading-relaxed text-muted-foreground">
          This walkthrough uses simplified, representative examples. Exact chunks, vectors, scores,
          tokens and timings vary by document, model and settings.
        </p>
      </div>
    </div>
  )
}
