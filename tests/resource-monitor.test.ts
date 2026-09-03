import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseAppleBatteryTemperature,
  parseAppleGpuMetrics,
  parseMacMemoryPressure,
  parseMacSwapUsage,
  parseMacVmStat
} from '../src/main/services/resource-monitor-service'

test('parses Apple GPU utilization and hardware details from ioreg', (): void => {
  const metrics = parseAppleGpuMetrics(`
    "PerformanceStatistics" = {"Device Utilization %"=23,"In use system memory"=380944384}
    "model" = "Apple M1 Pro"
    "gpu-core-count" = 16
  `)

  assert.deepEqual(metrics, {
    available: true,
    percent: 23,
    model: 'Apple M1 Pro',
    coreCount: 16
  })
})

test('returns an unavailable GPU state when ioreg has no accelerator data', (): void => {
  assert.deepEqual(parseAppleGpuMetrics(''), {
    available: false,
    percent: null,
    model: 'Graphics processor',
    coreCount: null
  })
})

test('uses macOS memory pressure instead of counting reclaimable cache as used', (): void => {
  assert.equal(parseMacMemoryPressure('System-wide memory free percentage: 38%'), 62)
  assert.equal(parseMacMemoryPressure('No memory data'), null)
})

test('reads the Mac battery temperature sensor', (): void => {
  assert.equal(parseAppleBatteryTemperature('"Temperature" = 2983'), 29.8)
  assert.equal(parseAppleBatteryTemperature('no sensor'), null)
})

test('parses macOS swap totals and VM counters', (): void => {
  assert.deepEqual(
    parseMacSwapUsage('vm.swapusage: total = 4096.00M  used = 512.50M  free = 3583.50M'),
    {
      swapUsedBytes: 512.5 * 1024 ** 2,
      swapTotalBytes: 4096 * 1024 ** 2
    }
  )
  assert.deepEqual(
    parseMacVmStat(
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nSwapins: 12.\nSwapouts: 3.',
      1000
    ),
    { sampledAt: 1000, pageSize: 16384, swapIns: 12, swapOuts: 3 }
  )
})
