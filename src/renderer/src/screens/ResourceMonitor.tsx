import {
  Activity,
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  Clock3,
  HardDrive,
  Loader2,
  MemoryStick,
  Microchip,
  RefreshCw,
  Thermometer,
  Workflow,
  X
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ResourceMetrics } from '../../../shared/contracts'
import { HelpTooltip } from '../components/ui'
import type { ResourceHistoryPoint } from '../hooks/useResourceHistory'
import { formatBytes, formatDuration, formatLatency, formatTokenSpeed } from '../lib/format'

function clamp(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function formatStoragePair(available: number | null, total: number | null): string {
  if (available === null || total === null) return 'Unavailable'
  const unit = total >= 1024 ** 4 ? 'TB' : 'GB'
  const divisor = unit === 'TB' ? 1024 ** 4 : 1024 ** 3
  const decimals = unit === 'TB' ? 1 : 0
  return `${(available / divisor).toFixed(decimals)} / ${(total / divisor).toFixed(decimals)} ${unit}`
}

function rangeHelp(
  description: string,
  minimum: number | null,
  average: number | null,
  maximum: number | null,
  formatter: (value: number | null) => string
): string {
  return `${description}\nMinimum: ${formatter(minimum)}\nAverage: ${formatter(average)}\nMaximum: ${formatter(maximum)}`
}

function processDescription(type: string): string {
  switch (type.toLowerCase()) {
    case 'browser':
      return 'Runs RavnDock and coordinates the app.'
    case 'tab':
      return 'Displays and updates the screen you are using.'
    case 'gpu':
      return 'Draws the interface and accelerates graphics.'
    case 'utility':
      return 'Handles background work such as networking and files.'
    default:
      return 'Supports a RavnDock background task.'
  }
}

function MetricHeader({ label, help }: { label: string; help: string }): React.JSX.Element {
  return (
    <span className="flex items-center justify-end gap-1">
      {label}
      <HelpTooltip label={`About ${label}`} text={help} iconClassName="h-3 w-3" />
    </span>
  )
}

function MetricValue({
  label,
  value,
  detail
}: {
  label: string
  value: string
  detail: string
}): React.JSX.Element {
  return (
    <span className="flex items-center justify-end gap-1 tabular-nums text-muted-foreground">
      {value}
      <HelpTooltip label={`${label} range`} text={detail} iconClassName="h-3 w-3" />
    </span>
  )
}

function Sparkline({ values, color }: { values: number[]; color: string }): React.JSX.Element {
  const points = useMemo(() => {
    const data = values.length > 1 ? values : [0, values[0] ?? 0]
    return data
      .map((value, index) => {
        const x = (index / (data.length - 1)) * 100
        const y = 32 - (clamp(value) / 100) * 28
        return `${x},${y}`
      })
      .join(' ')
  }, [values])

  return (
    <svg viewBox="0 0 100 34" preserveAspectRatio="none" className="h-9 w-full" aria-hidden>
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

function Gauge({
  value,
  appPercent,
  color
}: {
  value: number | null
  appPercent: number
  color: string
}): React.JSX.Element {
  const radius = 43
  const circumference = 2 * Math.PI * radius
  const appRadius = 31
  const appCircumference = 2 * Math.PI * appRadius
  const percent = value === null ? 0 : clamp(value)
  return (
    <div className="relative mx-auto h-32 w-32">
      <svg viewBox="0 0 112 112" className="h-full w-full -rotate-90" aria-hidden>
        <circle
          cx="56"
          cy="56"
          r={radius}
          fill="none"
          stroke="var(--gauge-track)"
          strokeWidth="9"
        />
        <circle
          cx="56"
          cy="56"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - percent / 100)}
          className="transition-[stroke-dashoffset] duration-500"
        />
        <circle
          cx="56"
          cy="56"
          r={appRadius}
          fill="none"
          stroke="var(--gauge-app)"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={appCircumference}
          strokeDashoffset={appCircumference * (1 - clamp(appPercent) / 100)}
          className="transition-[stroke-dashoffset] duration-500"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-semibold tabular-nums text-foreground">
          {value === null ? 'N/A' : Math.round(value)}
        </span>
        {value !== null && <span className="text-xs text-muted-foreground">%</span>}
      </div>
    </div>
  )
}

function GaugeCard({
  title,
  badge,
  value,
  appPercent,
  color,
  systemLabel,
  systemValue,
  appLabel,
  appValue,
  history
}: {
  title: string
  badge: string
  value: number | null
  appPercent: number
  color: string
  systemLabel: string
  systemValue: string
  appLabel: string
  appValue: string
  history: number[]
}): React.JSX.Element {
  return (
    <section
      className={`min-w-0 rounded-lg border bg-card p-4 ${
        value !== null && value >= 90 ? 'border-amber-400/60' : 'border-white/10'
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
          {title}
          {value !== null && value >= 90 && (
            <AlertTriangle className="h-3.5 w-3.5 text-amber-300" />
          )}
        </div>
        <span
          className="max-w-[58%] truncate rounded-md px-2 py-1 text-[10px] font-medium"
          style={{ color, backgroundColor: `color-mix(in srgb, ${color} 9%, transparent)` }}
          title={badge}
        >
          {badge}
        </span>
      </div>
      <div className="py-2">
        <Gauge value={value} appPercent={appPercent} color={color} />
      </div>
      <div className="space-y-2 text-xs">
        <div className="flex items-center justify-between gap-3">
          <span className="truncate text-muted-foreground">{systemLabel}</span>
          <span className="flex-shrink-0 font-medium text-foreground">{systemValue}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="truncate text-muted-foreground">{appLabel}</span>
          <span className="flex-shrink-0 font-medium" style={{ color }}>
            {appValue}
          </span>
        </div>
      </div>
      <div className="mt-2">
        <Sparkline values={history} color={color} />
      </div>
    </section>
  )
}

function SmallMetric({
  icon,
  value,
  label,
  note,
  action
}: {
  icon: React.ReactNode
  value: string
  label: string
  note: string
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="min-w-0 rounded-lg border border-white/10 bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-white/[0.05]">
          {icon}
        </div>
        {action ?? <span className="truncate text-[10px] text-muted-foreground">{note}</span>}
      </div>
      <p className="truncate text-xl font-semibold text-foreground" title={value}>
        {value}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{label}</p>
    </div>
  )
}

function ComparisonBar({
  label,
  systemPercent,
  appPercent,
  value,
  color
}: {
  label: string
  systemPercent: number
  appPercent: number
  value: string
  color: string
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-[72px_1fr_110px] items-center gap-3 text-xs">
      <span className="font-medium text-muted-foreground">{label}</span>
      <div className="relative h-2 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-white/15 transition-[width] duration-500"
          style={{ width: `${clamp(systemPercent)}%` }}
        />
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
          style={{ width: `${clamp(appPercent)}%`, backgroundColor: color }}
        />
      </div>
      <span className="text-right text-[11px] text-muted-foreground">{value}</span>
    </div>
  )
}

export default function ResourceMonitor({
  onBack,
  metrics,
  history,
  error,
  refreshing,
  refresh
}: {
  onBack: () => void
  metrics: ResourceMetrics | null
  history: ResourceHistoryPoint[]
  error: string | null
  refreshing: boolean
  refresh: () => Promise<void>
}): React.JSX.Element {
  const [showProcesses, setShowProcesses] = useState(false)
  const [showDetails, setShowDetails] = useState(false)

  if (!metrics && !error) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex justify-end px-5 pt-3">
          <button
            type="button"
            onClick={onBack}
            className="control-quiet flex items-center gap-1.5"
          >
            <X className="h-3.5 w-3.5" />
            Close
          </button>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-cyan-400" />
        </div>
      </div>
    )
  }

  const primaryModel = metrics?.localAi.models[0]
  const updatedAt = metrics
    ? new Date(metrics.sampledAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })
    : 'Not available'
  const healthState: 'normal' | 'busy' | 'needs_attention' = !metrics
    ? 'needs_attention'
    : metrics.system.cpuPercent >= 95 ||
        metrics.system.memoryPercent >= 95 ||
        (metrics.gpu.percent !== null && metrics.gpu.percent >= 98) ||
        (metrics.system.temperatureC !== null && metrics.system.temperatureC >= 95)
      ? 'needs_attention'
      : metrics.system.cpuPercent >= 85 ||
          metrics.system.memoryPercent >= 85 ||
          (metrics.gpu.percent !== null && metrics.gpu.percent >= 90)
        ? 'busy'
        : 'normal'
  const aiMemoryPercent = metrics
    ? (metrics.localAi.acceleratorBytes / metrics.system.memoryTotalBytes) * 100
    : 0

  return (
    <div className="h-full overflow-y-auto px-5 pb-6 pt-3">
      <header className="mb-5 flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="monitor-icon flex h-10 w-10 items-center justify-center rounded-lg">
            <Activity className="h-5 w-5 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-foreground">System Resources</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">Updated {updatedAt}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1.5 rounded-md border border-white/10 px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-white/5 hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
            Close
          </button>
          {metrics && (
            <span
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium ${
                healthState === 'normal'
                  ? 'status-healthy'
                  : healthState === 'busy'
                    ? 'border-amber-400/25 bg-amber-400/10 text-amber-200'
                    : 'border-red-400/25 bg-red-400/10 text-red-200'
              }`}
              title={
                healthState === 'normal'
                  ? 'RavnDock is ready.'
                  : healthState === 'busy'
                    ? 'Answers may arrive more slowly. Nothing is wrong.'
                    : 'Pause large tasks for a moment, then try again.'
              }
            >
              {healthState === 'normal' ? (
                <CheckCircle2 className="h-3.5 w-3.5" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5" />
              )}
              {healthState === 'normal'
                ? 'All systems normal'
                : healthState === 'busy'
                  ? 'Your Mac is busy'
                  : 'Your Mac needs a break'}
            </span>
          )}
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            title="Refresh resource data"
            aria-label="Refresh resource data"
            className="native-titlebar-button disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      {metrics && healthState !== 'normal' && (
        <p
          className={`mb-4 rounded-lg px-3 py-2 text-[11px] ${
            healthState === 'busy'
              ? 'border border-amber-400/20 bg-amber-400/[0.07] text-amber-100'
              : 'border border-red-400/20 bg-red-400/[0.07] text-red-100'
          }`}
          role="status"
        >
          {healthState === 'busy'
            ? 'Your Mac is busy, so answers may arrive more slowly. Nothing is wrong.'
            : 'Pause large tasks for a moment, then try again. Your chats and files are safe.'}
        </p>
      )}

      {error && (
        <div className="mb-4 rounded-lg border border-red-400/20 bg-red-500/10 p-3 text-xs">
          <p className="font-medium text-foreground">
            RavnDock could not read resource usage right now.
          </p>
          <p className="mt-1 text-muted-foreground">
            Try refreshing. Your chats and documents are unaffected.
          </p>
          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              onClick={() => void refresh()}
              className="rounded-md bg-primary px-2.5 py-1.5 text-[11px] font-medium text-primary-foreground"
            >
              Refresh
            </button>
            <details className="text-muted-foreground">
              <summary className="cursor-pointer">Technical details</summary>
              <p className="mt-1 break-words">{error}</p>
            </details>
          </div>
        </div>
      )}

      {metrics && (
        <>
          <div className="grid grid-cols-3 gap-3">
            <GaugeCard
              title="CPU"
              badge={`${metrics.system.logicalCores} cores`}
              value={metrics.system.cpuPercent}
              appPercent={metrics.app.cpuPercent}
              color="var(--chart-1)"
              systemLabel="Mac total"
              systemValue={`${metrics.system.cpuPercent.toFixed(1)}%`}
              appLabel="RavnDock"
              appValue={`${metrics.app.cpuPercent.toFixed(1)}%`}
              history={history.map((point) => point.cpu)}
            />
            <GaugeCard
              title="Memory"
              badge={formatBytes(metrics.system.memoryTotalBytes)}
              value={metrics.system.memoryPercent}
              appPercent={metrics.app.memoryPercent}
              color="var(--metric-memory)"
              systemLabel="Used"
              systemValue={formatBytes(metrics.system.memoryUsedBytes)}
              appLabel="RavnDock"
              appValue={formatBytes(metrics.app.memoryBytes)}
              history={history.map((point) => point.memory)}
            />
            <GaugeCard
              title="GPU"
              badge={metrics.gpu.coreCount ? `${metrics.gpu.coreCount} cores` : metrics.gpu.model}
              value={metrics.gpu.percent}
              appPercent={aiMemoryPercent}
              color="var(--metric-gpu)"
              systemLabel="Mac total"
              systemValue={
                metrics.gpu.percent === null ? 'Not exposed' : `${metrics.gpu.percent.toFixed(1)}%`
              }
              appLabel="AI model memory"
              appValue={formatBytes(metrics.localAi.acceleratorBytes)}
              history={history.map((point) => point.gpu)}
            />
          </div>

          <details className="section-disclosure native-surface mt-3">
            <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 hover:bg-secondary/60">
              <span>
                <span className="block text-xs font-semibold text-foreground">
                  Storage and RavnDock activity
                </span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  Model memory, temperature, uptime, storage, and helper processes.
                </span>
              </span>
              <ChevronDown className="native-disclosure-chevron h-4 w-4 text-muted-foreground" />
            </summary>
            <div className="p-4">
              <div className="grid grid-cols-6 gap-3">
                <SmallMetric
                  icon={<HardDrive className="h-4 w-4 text-primary" />}
                  value={formatStoragePair(
                    metrics.system.diskAvailableBytes,
                    metrics.system.diskTotalBytes
                  )}
                  label="Storage available"
                  note="This Mac"
                />
                <SmallMetric
                  icon={<BrainCircuit className="h-4 w-4 text-violet-300" />}
                  value={formatBytes(metrics.localAi.totalModelBytes)}
                  label="Loaded model memory"
                  note={primaryModel?.name ?? 'No model loaded'}
                />
                <SmallMetric
                  icon={<MemoryStick className="h-4 w-4 text-violet-300" />}
                  value={
                    metrics.system.swapUsedBytes === null
                      ? 'Unavailable'
                      : formatBytes(metrics.system.swapUsedBytes)
                  }
                  label="Swap used"
                  note={
                    metrics.system.swapOutBytesPerSecond && metrics.system.swapOutBytesPerSecond > 0
                      ? `${formatBytes(metrics.system.swapOutBytesPerSecond)}/s writing`
                      : metrics.system.swapTotalBytes === null
                        ? 'Not exposed'
                        : `${formatBytes(metrics.system.swapTotalBytes)} available`
                  }
                />
                <SmallMetric
                  icon={<Thermometer className="h-4 w-4 text-amber-300" />}
                  value={
                    metrics.system.temperatureC === null
                      ? 'Unavailable'
                      : `${metrics.system.temperatureC.toFixed(1)}°C`
                  }
                  label={`${metrics.system.temperatureLabel} temperature`}
                  note="Hardware sensor"
                />
                <SmallMetric
                  icon={<Clock3 className="h-4 w-4 text-cyan-300" />}
                  value={formatDuration(metrics.app.uptimeSeconds)}
                  label="RavnDock uptime"
                  note={`Mac ${formatDuration(metrics.system.uptimeSeconds)}`}
                />
                <SmallMetric
                  icon={<Workflow className="h-4 w-4 text-emerald-300" />}
                  value={String(metrics.app.processCount)}
                  label="App helper processes"
                  note="RavnDock parts"
                  action={
                    <button
                      type="button"
                      onClick={() => setShowProcesses((current) => !current)}
                      className="rounded-md bg-white/[0.05] px-2 py-1 text-[10px] text-primary hover:bg-white/10"
                    >
                      {showProcesses ? 'Hide' : 'View'}
                    </button>
                  }
                />
              </div>

              {showProcesses && (
                <section className="mt-3 rounded-lg bg-card p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <h2 className="text-xs font-semibold uppercase text-muted-foreground">
                        Active RavnDock processes
                      </h2>
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        Separate app parts keep the window responsive and stable. This is normal.
                      </p>
                    </div>
                    <span className="text-[10px] text-muted-foreground">
                      {metrics.app.processes.length} running
                    </span>
                  </div>
                  <div className="divide-y divide-white/[0.06]">
                    {metrics.app.processes.map((process, index) => (
                      <div
                        key={`${process.type}-${index}`}
                        className="grid grid-cols-[1fr_90px_90px] items-center gap-3 py-2 text-xs"
                      >
                        <span className="min-w-0">
                          <span className="block text-foreground">{process.type}</span>
                          <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                            {processDescription(process.type)}
                          </span>
                        </span>
                        <span className="text-right text-muted-foreground">
                          {process.cpuPercent.toFixed(1)}% CPU
                        </span>
                        <span className="text-right text-muted-foreground">
                          {formatBytes(process.memoryBytes)}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          </details>

          <details
            className="section-disclosure native-surface mt-3"
            open={showDetails}
            onToggle={(event) => setShowDetails(event.currentTarget.open)}
          >
            <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 hover:bg-secondary/60">
              <span>
                <span className="block text-xs font-semibold text-foreground">
                  Detailed usage and model statistics
                </span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  Compare RavnDock with your Mac and review model performance.
                </span>
              </span>
              <span className="text-[11px] font-medium text-primary">
                {showDetails ? 'Hide' : 'Show'}
              </span>
            </summary>
            <div className="p-4">
              <section className="rounded-lg bg-card p-4">
                <div className="mb-4 flex items-center justify-between gap-4">
                  <div>
                    <h2 className="text-xs font-semibold uppercase text-muted-foreground">
                      RavnDock vs Mac usage
                    </h2>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Colored bars show RavnDock. Gray bars show your Mac total.
                    </p>
                  </div>
                  <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <span className="h-2 w-2 rounded-sm bg-white/15" /> Mac
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="h-2 w-2 rounded-sm bg-primary" /> RavnDock
                    </span>
                  </div>
                </div>
                <div className="space-y-4">
                  <ComparisonBar
                    label="CPU"
                    systemPercent={metrics.system.cpuPercent}
                    appPercent={metrics.app.cpuPercent}
                    value={`${metrics.app.cpuPercent.toFixed(1)}% of ${metrics.system.cpuPercent.toFixed(1)}%`}
                    color="var(--chart-1)"
                  />
                  <ComparisonBar
                    label="Memory"
                    systemPercent={metrics.system.memoryPercent}
                    appPercent={metrics.app.memoryPercent}
                    value={`${formatBytes(metrics.app.memoryBytes)} used`}
                    color="var(--metric-memory)"
                  />
                  <ComparisonBar
                    label="AI memory"
                    systemPercent={100}
                    appPercent={aiMemoryPercent}
                    value={`${formatBytes(metrics.localAi.acceleratorBytes)} loaded`}
                    color="var(--metric-gpu)"
                  />
                </div>
                <div className="mt-4 flex items-start gap-2 border-t border-white/[0.07] pt-3 text-[10px] leading-relaxed text-muted-foreground">
                  <Microchip className="mt-0.5 h-3 w-3 flex-shrink-0" />
                  <span>{metrics.gpu.note}</span>
                </div>
              </section>

              <section className="mt-3 rounded-lg bg-card p-4">
                <div className="mb-4 flex items-end justify-between gap-4">
                  <div>
                    <h2 className="text-xs font-semibold uppercase text-muted-foreground">
                      Model performance
                    </h2>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Based on completed chats on this Mac. The table shows averages.
                    </p>
                  </div>
                  <span className="text-[10px] text-muted-foreground">
                    {metrics.modelPerformance.reduce((sum, model) => sum + model.responses, 0)}{' '}
                    samples
                  </span>
                </div>
                {metrics.modelPerformance.length === 0 ? (
                  <p className="py-4 text-center text-xs text-muted-foreground">
                    Complete a chat to start measuring model speed.
                  </p>
                ) : (
                  <>
                    <div className="mb-4 grid grid-cols-3 gap-2">
                      {metrics.modelPerformance.slice(0, 3).map((model, index) => (
                        <div key={model.model} className="rounded-lg bg-white/[0.035] p-3">
                          <p className="text-[10px] font-semibold text-primary">
                            #{index + 1} SPEED
                          </p>
                          <p
                            className="mt-1 truncate text-xs font-medium text-foreground"
                            title={model.model}
                          >
                            {model.model}
                          </p>
                          <p className="mt-1 text-lg font-semibold text-foreground">
                            {model.tokensPerSecondAverage === null
                              ? 'N/A'
                              : `${model.tokensPerSecondAverage.toFixed(1)} tok/s`}
                          </p>
                        </div>
                      ))}
                    </div>
                    <div className="overflow-x-auto">
                      <div className="min-w-[760px]">
                        <div className="grid grid-cols-[1.35fr_0.55fr_repeat(4,0.9fr)] gap-3 border-b border-white/[0.07] pb-2 text-[10px] text-muted-foreground">
                          <span>Model</span>
                          <MetricHeader
                            label="Requests"
                            help="Completed answers measured for this model."
                          />
                          <MetricHeader
                            label="TTFT"
                            help="Time to first token: how long you wait before the answer starts."
                          />
                          <MetricHeader
                            label="Speed"
                            help="How many answer tokens the model generates each second. Higher is faster."
                          />
                          <MetricHeader
                            label="ITL"
                            help="Inter-token latency: the average pause between generated tokens. Lower feels smoother."
                          />
                          <MetricHeader
                            label="E2E"
                            help="End-to-end latency: total time from sending your message until the answer finishes."
                          />
                        </div>
                        {metrics.modelPerformance.map((model) => (
                          <div
                            key={model.model}
                            className="grid grid-cols-[1.35fr_0.55fr_repeat(4,0.9fr)] gap-3 border-b border-white/[0.05] py-2 text-[10px]"
                          >
                            <span className="truncate text-foreground" title={model.model}>
                              {model.model}
                            </span>
                            <span
                              className="text-right tabular-nums text-muted-foreground"
                              title="Completed answers measured for this model."
                            >
                              {model.responses}
                            </span>
                            <MetricValue
                              label="TTFT"
                              value={formatLatency(model.ttftAverageMs)}
                              detail={rangeHelp(
                                'Time to first token',
                                model.ttftMinMs,
                                model.ttftAverageMs,
                                model.ttftMaxMs,
                                formatLatency
                              )}
                            />
                            <MetricValue
                              label="Speed"
                              value={formatTokenSpeed(model.tokensPerSecondAverage)}
                              detail={rangeHelp(
                                'Generation speed',
                                model.tokensPerSecondMin,
                                model.tokensPerSecondAverage,
                                model.tokensPerSecondMax,
                                formatTokenSpeed
                              )}
                            />
                            <MetricValue
                              label="ITL"
                              value={formatLatency(model.interTokenLatencyAverageMs)}
                              detail={rangeHelp(
                                'Inter-token latency',
                                model.interTokenLatencyMinMs,
                                model.interTokenLatencyAverageMs,
                                model.interTokenLatencyMaxMs,
                                formatLatency
                              )}
                            />
                            <MetricValue
                              label="E2E"
                              value={formatLatency(model.endToEndLatencyAverageMs)}
                              detail={rangeHelp(
                                'End-to-end latency',
                                model.endToEndLatencyMinMs,
                                model.endToEndLatencyAverageMs,
                                model.endToEndLatencyMaxMs,
                                formatLatency
                              )}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </section>
            </div>
          </details>
        </>
      )}
    </div>
  )
}
