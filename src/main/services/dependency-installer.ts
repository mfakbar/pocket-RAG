import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdir, open, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { runCommand } from '../lib/command'
import { errorMessage, PocketRagError } from '../lib/errors'

export interface DownloadProgress {
  downloadedBytes: number
  totalBytes?: number
  progress?: number
}

type ProgressListener = (progress: DownloadProgress) => void

const OLLAMA_TEAM_IDENTIFIER = '3MU9H2V9Y9'

export function codesignTeamIdentifier(output: string): string | null {
  return output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() ?? null
}

async function sha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export class DependencyInstaller {
  constructor(
    private readonly userDataPath: () => string,
    private readonly ollamaDownloadUrl: string,
    private readonly uvDownloadUrl: string,
    private readonly uvDownloadSha256: string,
    private readonly backendSource: () => string
  ) {}

  managedOllamaPath(): string {
    return path.join(
      this.userDataPath(),
      'runtime',
      'ollama',
      'Ollama.app',
      'Contents',
      'Resources',
      'ollama'
    )
  }

  private async download(
    url: string,
    destination: string,
    onProgress: ProgressListener,
    signal?: AbortSignal
  ): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30 * 60_000)
    const abort = (): void => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const existingBytes = await stat(destination)
      .then((info) => info.size)
      .catch(() => 0)
    let file: Awaited<ReturnType<typeof open>> | null = null

    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': 'RavnDock',
          ...(existingBytes > 0 ? { Range: `bytes=${existingBytes}-` } : {})
        }
      })
      if (response.status === 416 && existingBytes > 0) return
      if (!response.ok || !response.body) {
        throw new PocketRagError(
          `Download failed with status ${response.status}.`,
          'DEPENDENCY_DOWNLOAD_FAILED'
        )
      }

      const resumes = existingBytes > 0 && response.status === 206
      file = await open(destination, resumes ? 'a' : 'w', 0o600)
      const totalHeader = response.headers.get('content-length')
      const responseBytes = totalHeader ? Number(totalHeader) : undefined
      const totalBytes = responseBytes ? responseBytes + (resumes ? existingBytes : 0) : undefined
      const reader = response.body.getReader()
      let downloadedBytes = resumes ? existingBytes : 0
      if (downloadedBytes > 0) {
        onProgress({
          downloadedBytes,
          totalBytes,
          progress: totalBytes ? Math.round((downloadedBytes / totalBytes) * 100) : undefined
        })
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        let offset = 0
        while (offset < value.byteLength) {
          const { bytesWritten } = await file.write(value, offset, value.byteLength - offset, null)
          offset += bytesWritten
        }
        downloadedBytes += value.byteLength
        onProgress({
          downloadedBytes,
          totalBytes,
          progress: totalBytes ? Math.round((downloadedBytes / totalBytes) * 100) : undefined
        })
      }
    } catch (error) {
      if (controller.signal.aborted && signal?.aborted) {
        throw new PocketRagError(
          'Download paused. Your progress is saved and can continue later.',
          'DOWNLOAD_PAUSED',
          error
        )
      }
      throw new PocketRagError(
        `The download could not be completed: ${errorMessage(error)}`,
        'DEPENDENCY_DOWNLOAD_FAILED',
        error
      )
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      await file?.close()
    }
  }

  private assertSupportedMac(): void {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
      throw new PocketRagError(
        'Automatic setup currently supports Apple Silicon Macs.',
        'UNSUPPORTED_PLATFORM'
      )
    }
  }

  async installOllama(onProgress: ProgressListener, signal?: AbortSignal): Promise<string> {
    this.assertSupportedMac()
    const runtimeDirectory = path.join(this.userDataPath(), 'runtime', 'ollama')
    const downloadDirectory = path.join(this.userDataPath(), 'downloads')
    const archivePath = path.join(downloadDirectory, 'Ollama-darwin.zip')

    await mkdir(downloadDirectory, { recursive: true })
    try {
      await this.download(this.ollamaDownloadUrl, archivePath, onProgress, signal)
      if (signal?.aborted) throw new DOMException('Download paused.', 'AbortError')
      await rm(runtimeDirectory, { recursive: true, force: true })
      await mkdir(runtimeDirectory, { recursive: true })
      await runCommand('/usr/bin/ditto', ['-x', '-k', archivePath, runtimeDirectory], {
        timeout: 5 * 60_000
      })
      const appPath = path.join(runtimeDirectory, 'Ollama.app')
      await runCommand('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], {
        timeout: 60_000
      })
      const signature = await runCommand('/usr/bin/codesign', ['-dv', '--verbose=4', appPath], {
        timeout: 60_000
      })
      if (codesignTeamIdentifier(signature.stderr) !== OLLAMA_TEAM_IDENTIFIER) {
        throw new PocketRagError(
          'The Local AI download was not signed by the expected developer.',
          'OLLAMA_SIGNATURE_FAILED'
        )
      }
      const executable = this.managedOllamaPath()
      await runCommand(executable, ['--version'], { timeout: 10_000 })
      await rm(archivePath, { force: true })
      return executable
    } catch (error) {
      if (error instanceof PocketRagError && error.code === 'DOWNLOAD_PAUSED') throw error
      throw new PocketRagError(
        `Local AI could not be installed: ${errorMessage(error)}`,
        'OLLAMA_INSTALL_FAILED',
        error
      )
    }
  }

  private managedRagPythonPath(): string {
    return path.join(this.userDataPath(), 'runtime', 'rag-backend', '.venv', 'bin', 'python')
  }

  private developmentRagPythonPath(): string {
    return path.join(this.backendSource(), '.venv', 'bin', 'python')
  }

  private async isRagPython(executable: string): Promise<boolean> {
    try {
      await access(executable)
      await runCommand(executable, ['-c', 'import docling, lancedb, pyarrow, tiktoken'], {
        timeout: 30_000
      })
      return true
    } catch {
      return false
    }
  }

  async findRagPython(): Promise<string | null> {
    for (const executable of [this.developmentRagPythonPath(), this.managedRagPythonPath()]) {
      if (await this.isRagPython(executable)) return executable
    }
    return null
  }

  async installRagBackend(onProgress: ProgressListener, signal?: AbortSignal): Promise<string> {
    this.assertSupportedMac()
    const downloadDirectory = path.join(this.userDataPath(), 'downloads')
    const archivePath = path.join(downloadDirectory, 'uv-aarch64-apple-darwin.tar.gz')
    const runtimeDirectory = path.join(this.userDataPath(), 'runtime', 'rag-backend')
    const uvDirectory = path.join(runtimeDirectory, 'uv')
    await mkdir(downloadDirectory, { recursive: true })

    try {
      await this.download(this.uvDownloadUrl, archivePath, onProgress, signal)
      if (signal?.aborted) throw new DOMException('Download paused.', 'AbortError')
      const actualHash = await sha256(archivePath)
      if (actualHash !== this.uvDownloadSha256) {
        throw new PocketRagError(
          'The private document engine did not pass its security check.',
          'RAG_RUNTIME_CHECKSUM_FAILED'
        )
      }
      await rm(uvDirectory, { recursive: true, force: true })
      await mkdir(uvDirectory, { recursive: true })
      await runCommand(
        '/usr/bin/tar',
        ['-xzf', archivePath, '-C', uvDirectory, '--strip-components=1'],
        { timeout: 2 * 60_000 }
      )
      const uv = path.join(uvDirectory, 'uv')
      await runCommand(uv, ['--version'], { timeout: 10_000 })
      await runCommand(
        uv,
        ['sync', '--project', this.backendSource(), '--python', '3.14', '--locked', '--no-dev'],
        {
          timeout: 30 * 60_000,
          env: {
            ...process.env,
            UV_PROJECT_ENVIRONMENT: path.join(runtimeDirectory, '.venv'),
            UV_PYTHON_INSTALL_DIR: path.join(runtimeDirectory, 'python'),
            UV_CACHE_DIR: path.join(runtimeDirectory, 'cache'),
            UV_NO_PROGRESS: '1'
          }
        }
      )
      const executable = this.managedRagPythonPath()
      if (!(await this.isRagPython(executable))) {
        throw new Error('The private document engine did not finish installing.')
      }
      await rm(archivePath, { force: true })
      return executable
    } catch (error) {
      if (error instanceof PocketRagError && error.code === 'DOWNLOAD_PAUSED') throw error
      throw new PocketRagError(
        `The private document engine could not be installed: ${errorMessage(error)}`,
        'RAG_RUNTIME_INSTALL_FAILED',
        error
      )
    }
  }
}
