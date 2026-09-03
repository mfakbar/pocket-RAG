import { MoreHorizontal, Trash2 } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import type { PromptTemplate } from '../../config/promptTemplates'
import type { ChatSession } from '../../types/ui'
import HelpTooltip from '../ui/HelpTooltip'

function resourceColor(value: number | null, normal: string): string {
  if (value !== null && value >= 90) return 'var(--status-danger)'
  if (value !== null && value >= 80) return 'var(--status-warning)'
  return normal
}

function MiniSparkline({ values, color }: { values: number[]; color: string }): React.JSX.Element {
  const data = values.length > 1 ? values : [0, values[0] ?? 0]
  const points = data
    .map((value, index) => {
      const x = (index / (data.length - 1)) * 100
      const y = 20 - (Math.min(100, Math.max(0, value)) / 100) * 17
      return `${x},${y}`
    })
    .join(' ')
  return (
    <svg viewBox="0 0 100 22" preserveAspectRatio="none" className="h-6 w-full" aria-hidden>
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

export function ResourceMiniMetric({
  icon,
  label,
  value,
  history,
  normalColor
}: {
  icon: React.ReactNode
  label: string
  value: number | null
  history: number[]
  normalColor: string
}): React.JSX.Element {
  const color = resourceColor(value, normalColor)
  return (
    <div className="rounded-md bg-white/[0.025] px-2 py-1.5">
      <div className="flex items-center justify-between gap-2 text-[10px]">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <span style={{ color }}>{icon}</span>
          {label}
        </span>
        <span className="font-medium tabular-nums" style={{ color }}>
          {value === null ? 'N/A' : `${Math.round(value)}%`}
        </span>
      </div>
      <MiniSparkline values={history} color={color} />
    </div>
  )
}

export function ChoiceHelp({ text }: { text: string }): React.JSX.Element {
  return <HelpTooltip text={text} iconClassName="h-3 w-3" />
}

export function SessionRow({
  session,
  active,
  onSelect,
  onMenu
}: {
  session: ChatSession
  active: boolean
  onSelect: () => void
  onMenu: (event: React.MouseEvent) => void
}): React.JSX.Element {
  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('application/x-pocketrag-chat', session.id)
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        onMenu(event)
      }}
      className={`group chat-session flex cursor-grab items-center rounded-lg active:cursor-grabbing ${
        active ? 'chat-session-active' : ''
      }`}
    >
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 px-2.5 py-2 text-left">
        <p className="truncate text-xs font-medium text-foreground">{session.title}</p>
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          onMenu(event)
        }}
        title="Chat options"
        className="mr-1 hidden rounded p-1 text-muted-foreground hover:bg-white/10 hover:text-foreground group-hover:block group-focus-within:block"
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

export function PromptTemplateRow({
  template,
  onSelect,
  onDelete
}: {
  template: PromptTemplate
  onSelect: () => void
  onDelete: () => void
}): React.JSX.Element {
  const promptRef = useRef<HTMLSpanElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)

  useLayoutEffect(() => {
    const prompt = promptRef.current
    if (!prompt || expanded) return
    const measure = (): void => setOverflows(prompt.scrollHeight > prompt.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(prompt)
    return () => observer.disconnect()
  }, [expanded, template.prompt])

  return (
    <div className="group/template flex min-w-0 items-start rounded-md bg-white/[0.035]">
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 px-2.5 py-2 text-left">
        <span className="block truncate text-[11px] font-medium text-foreground">
          {template.name}
        </span>
        <span
          ref={promptRef}
          className={`mt-0.5 block text-[10px] leading-relaxed text-muted-foreground ${
            expanded ? '' : 'line-clamp-2'
          }`}
        >
          {template.prompt}
        </span>
      </button>
      {(overflows || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="mt-2 flex-shrink-0 rounded px-1.5 py-1 text-[9px] text-primary hover:bg-white/5"
        >
          {expanded ? 'Less' : 'More'}
        </button>
      )}
      {template.custom && (
        <button
          type="button"
          onClick={onDelete}
          title="Delete template"
          className="mr-1 hidden rounded p-1 text-muted-foreground hover:text-red-300 group-hover/template:block"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}
