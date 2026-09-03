import { execFile, spawn, type ExecFileOptions } from 'node:child_process'

export interface CommandResult {
  stdout: string
  stderr: string
}

export interface StreamingCommandOptions {
  timeout?: number
  onOutput?: (output: string) => void
}

export function runCommand(
  command: string,
  args: string[],
  options: ExecFileOptions = {}
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: 30_000, maxBuffer: 10 * 1024 * 1024, ...options },
      (error, stdout, stderr) => {
        if (error) {
          reject(error)
          return
        }

        resolve({ stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })
}

export function runStreamingCommand(
  command: string,
  args: string[],
  options: StreamingCommandOptions = {}
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, options.timeout ?? 30_000)

    child.stdout.on('data', (chunk: Buffer) => {
      const output = chunk.toString()
      stdout += output
      options.onOutput?.(output)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const output = chunk.toString()
      stderr += output
      options.onOutput?.(output)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 && !timedOut) {
        resolve({ stdout, stderr })
        return
      }
      reject(
        new Error(
          timedOut
            ? `Command timed out: ${command}`
            : stderr.trim() || `Command failed with exit code ${code ?? 'unknown'}: ${command}`
        )
      )
    })
  })
}

export async function findExecutable(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await runCommand(candidate, ['--version'], { timeout: 5_000 })
      return candidate
    } catch {
      // Try the next standard install location.
    }
  }

  return null
}
