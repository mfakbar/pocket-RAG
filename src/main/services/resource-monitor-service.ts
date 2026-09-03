import { statfs } from 'node:fs/promises'
import os from 'node:os'
import { app } from 'electron'
import type { ResourceMetrics } from '../../shared/contracts'
import { runCommand } from '../lib/command'
import { readConfig } from '../settings'
import { OllamaService } from './ollama-service'

interface CpuSnapshot {
  idle: number
  total: number
}

interface GpuSnapshot {
  available: boolean
  percent: number | null
  model: string
  coreCount: number | null
}

interface SwapSnapshot {
  sampledAt: number
  pageSize: number
  swapIns: number
  swapOuts: number
}

interface SwapMetrics {
  swapUsedBytes: number | null
  swapTotalBytes: number | null
  swapInBytesPerSecond: number | null
  swapOutBytesPerSecond: number | null
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Number(value.toFixed(1))))
}

function cpuSnapshot(): CpuSnapshot {
  return os.cpus().reduce(
    (snapshot, cpu) => {
      const total = Object.values(cpu.times).reduce((sum, time) => sum + time, 0)
      return { idle: snapshot.idle + cpu.times.idle, total: snapshot.total + total }
    },
    { idle: 0, total: 0 }
  )
}

export function parseAppleGpuMetrics(output: string): GpuSnapshot {
  const utilization = output.match(/"Device Utilization %"=(\d+(?:\.\d+)?)/)
  const model = output.match(/"model"\s*=\s*"([^"]+)"/)
  const cores = output.match(/"gpu-core-count"\s*=\s*(\d+)/)

  return {
    available: Boolean(utilization || model),
    percent: utilization ? clampPercent(Number(utilization[1])) : null,
    model: model?.[1] ?? 'Graphics processor',
    coreCount: cores ? Number(cores[1]) : null
  }
}

export function parseMacMemoryPressure(output: string): number | null {
  const match = output.match(/System-wide memory free percentage:\s*(\d+(?:\.\d+)?)%/)
  return match ? clampPercent(100 - Number(match[1])) : null
}

export function parseAppleBatteryTemperature(output: string): number | null {
  const match = output.match(/"Temperature"\s*=\s*(\d+(?:\.\d+)?)/)
  if (!match) return null
  const celsius = Number(match[1]) / 100
  return celsius > -20 && celsius < 100 ? Number(celsius.toFixed(1)) : null
}

function byteValue(value: string, unit: string): number {
  const multiplier =
    unit.toUpperCase() === 'G' ? 1024 ** 3 : unit.toUpperCase() === 'M' ? 1024 ** 2 : 1024
  return Number(value) * multiplier
}

export function parseMacSwapUsage(
  output: string
): Pick<SwapMetrics, 'swapUsedBytes' | 'swapTotalBytes'> {
  const total = output.match(/total\s*=\s*(\d+(?:\.\d+)?)([KMG])/i)
  const used = output.match(/used\s*=\s*(\d+(?:\.\d+)?)([KMG])/i)
  return {
    swapUsedBytes: used ? byteValue(used[1], used[2]) : null,
    swapTotalBytes: total ? byteValue(total[1], total[2]) : null
  }
}

export function parseMacVmStat(output: string, sampledAt = Date.now()): SwapSnapshot | null {
  const pageSize = output.match(/page size of\s+(\d+)\s+bytes/i)
  const swapIns = output.match(/^Swapins:\s+(\d+)\.?$/im)
  const swapOuts = output.match(/^Swapouts:\s+(\d+)\.?$/im)
  if (!pageSize || !swapIns || !swapOuts) return null
  return {
    sampledAt,
    pageSize: Number(pageSize[1]),
    swapIns: Number(swapIns[1]),
    swapOuts: Number(swapOuts[1])
  }
}

export class ResourceMonitorService {
  private previousCpu = cpuSnapshot()
  private gpuCache: { sampledAt: number; value: GpuSnapshot } | null = null
  private previousSwap: SwapSnapshot | null = null

  constructor(private readonly ollama: OllamaService) {}

  private systemCpuPercent(): number {
    const current = cpuSnapshot()
    const idleDelta = current.idle - this.previousCpu.idle
    const totalDelta = current.total - this.previousCpu.total
    this.previousCpu = current
    return totalDelta > 0 ? clampPercent((1 - idleDelta / totalDelta) * 100) : 0
  }

  private async gpuMetrics(): Promise<GpuSnapshot> {
    if (this.gpuCache && Date.now() - this.gpuCache.sampledAt < 4_000) {
      return this.gpuCache.value
    }

    let value: GpuSnapshot = {
      available: false,
      percent: null,
      model: 'Graphics processor',
      coreCount: null
    }
    if (process.platform === 'darwin') {
      try {
        const result = await runCommand(
          '/usr/sbin/ioreg',
          ['-r', '-d', '1', '-w', '0', '-c', 'AGXAccelerator'],
          { timeout: 2_000 }
        )
        value = parseAppleGpuMetrics(result.stdout)
      } catch {
        // The dashboard remains useful when the operating system hides GPU counters.
      }
    }

    this.gpuCache = { sampledAt: Date.now(), value }
    return value
  }

  private async diskMetrics(): Promise<{
    diskAvailableBytes: number | null
    diskTotalBytes: number | null
  }> {
    try {
      const disk = await statfs(app.getPath('userData'))
      return {
        diskAvailableBytes: disk.bavail * disk.bsize,
        diskTotalBytes: disk.blocks * disk.bsize
      }
    } catch {
      return { diskAvailableBytes: null, diskTotalBytes: null }
    }
  }

  private async memoryMetrics(totalMemory: number): Promise<{
    memoryUsedBytes: number
    memoryPercent: number
  }> {
    if (process.platform === 'darwin') {
      try {
        const result = await runCommand('/usr/bin/memory_pressure', ['-Q'], { timeout: 2_000 })
        const memoryPercent = parseMacMemoryPressure(result.stdout)
        if (memoryPercent !== null) {
          return {
            memoryUsedBytes: totalMemory * (memoryPercent / 100),
            memoryPercent
          }
        }
      } catch {
        // Fall back to Node's cross-platform free-memory counter.
      }
    }

    const memoryUsedBytes = totalMemory - os.freemem()
    return {
      memoryUsedBytes,
      memoryPercent: clampPercent((memoryUsedBytes / totalMemory) * 100)
    }
  }

  private async temperatureMetric(): Promise<number | null> {
    if (process.platform !== 'darwin') return null
    try {
      const result = await runCommand(
        '/usr/sbin/ioreg',
        ['-r', '-c', 'AppleSmartBattery', '-w', '0'],
        { timeout: 2_000 }
      )
      return parseAppleBatteryTemperature(result.stdout)
    } catch {
      return null
    }
  }

  private async swapMetrics(): Promise<SwapMetrics> {
    const unavailable: SwapMetrics = {
      swapUsedBytes: null,
      swapTotalBytes: null,
      swapInBytesPerSecond: null,
      swapOutBytesPerSecond: null
    }
    if (process.platform !== 'darwin') return unavailable
    try {
      const [usageResult, statResult] = await Promise.all([
        runCommand('/usr/sbin/sysctl', ['vm.swapusage'], { timeout: 2_000 }),
        runCommand('/usr/bin/vm_stat', [], { timeout: 2_000 })
      ])
      const usage = parseMacSwapUsage(usageResult.stdout)
      const current = parseMacVmStat(statResult.stdout)
      let swapInBytesPerSecond: number | null = null
      let swapOutBytesPerSecond: number | null = null
      if (current && this.previousSwap) {
        const elapsedSeconds = (current.sampledAt - this.previousSwap.sampledAt) / 1000
        if (elapsedSeconds > 0) {
          swapInBytesPerSecond =
            (Math.max(0, current.swapIns - this.previousSwap.swapIns) * current.pageSize) /
            elapsedSeconds
          swapOutBytesPerSecond =
            (Math.max(0, current.swapOuts - this.previousSwap.swapOuts) * current.pageSize) /
            elapsedSeconds
        }
      }
      if (current) this.previousSwap = current
      return { ...usage, swapInBytesPerSecond, swapOutBytesPerSecond }
    } catch {
      return unavailable
    }
  }

  async metrics(): Promise<ResourceMetrics> {
    const totalMemory = os.totalmem()
    const appProcesses = app.getAppMetrics()
    const appMemory = appProcesses.reduce(
      (total, metric) => total + metric.memory.workingSetSize * 1024,
      0
    )
    const appCpu = appProcesses.reduce((total, metric) => total + metric.cpu.percentCPUUsage, 0)
    const gpuProcessMemory = appProcesses
      .filter((metric) => metric.type === 'GPU')
      .reduce((total, metric) => total + metric.memory.workingSetSize * 1024, 0)

    const [gpu, disk, memory, swap, temperatureC, runningModels, config] = await Promise.all([
      this.gpuMetrics(),
      this.diskMetrics(),
      this.memoryMetrics(totalMemory),
      this.swapMetrics(),
      this.temperatureMetric(),
      this.ollama.listRunningModels(),
      readConfig()
    ])
    const acceleratorBytes = runningModels.reduce(
      (total, model) => total + model.acceleratorBytes,
      0
    )

    return {
      sampledAt: new Date().toISOString(),
      system: {
        cpuPercent: this.systemCpuPercent(),
        memoryUsedBytes: memory.memoryUsedBytes,
        memoryTotalBytes: totalMemory,
        memoryPercent: memory.memoryPercent,
        ...swap,
        logicalCores: os.cpus().length,
        uptimeSeconds: os.uptime(),
        temperatureC,
        temperatureLabel: 'Battery',
        ...disk
      },
      app: {
        cpuPercent: clampPercent(appCpu),
        memoryBytes: appMemory,
        memoryPercent: clampPercent((appMemory / totalMemory) * 100),
        processCount: appProcesses.length,
        processes: appProcesses
          .map((metric) => ({
            type: metric.type,
            cpuPercent: clampPercent(metric.cpu.percentCPUUsage),
            memoryBytes: metric.memory.workingSetSize * 1024
          }))
          .sort((left, right) => right.cpuPercent - left.cpuPercent),
        uptimeSeconds: process.uptime(),
        gpuProcessMemoryBytes: gpuProcessMemory
      },
      gpu: {
        ...gpu,
        note: gpu.available
          ? 'RavnDock GPU percentage is not exposed by macOS. Model and graphics memory are shown separately.'
          : 'GPU utilization is not available from this Mac without privileged tools.'
      },
      localAi: {
        running: await this.ollama.isRunning(),
        totalModelBytes: runningModels.reduce((total, model) => total + model.sizeBytes, 0),
        acceleratorBytes,
        models: runningModels
      },
      modelPerformance: Object.values(config.modelPerformance).sort(
        (left, right) => (right.tokensPerSecondAverage ?? -1) - (left.tokensPerSecondAverage ?? -1)
      )
    }
  }
}
