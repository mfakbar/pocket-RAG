import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { SUPPORTED_DOCUMENT_EXTENSIONS } from '../../shared/contracts'
import { PocketRagError } from './errors'

export interface ScannedFile {
  absolutePath: string
  relativePath: string
  checksum: string
  size: number
  modifiedAt: number
}

export interface ScanResult {
  files: ScannedFile[]
  skipped: number
}

export interface ScannedFileMetadata {
  relativePath: string
  size: number
  modifiedAt: number
}

const supportedExtensions = new Set<string>(SUPPORTED_DOCUMENT_EXTENSIONS)

async function checksum(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export async function scanDocumentFolder(folderPath: string): Promise<ScanResult> {
  const root = await realpath(folderPath)
  const rootStats = await stat(root)
  if (!rootStats.isDirectory()) {
    throw new PocketRagError('The selected knowledge location is not a folder.', 'INVALID_FOLDER')
  }

  const files: ScannedFile[] = []
  let skipped = 0

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('~$')) {
        skipped += 1
        continue
      }

      const absolutePath = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        skipped += 1
        continue
      }
      if (entry.isDirectory()) {
        await walk(absolutePath)
        continue
      }
      if (!entry.isFile() || !supportedExtensions.has(path.extname(entry.name).toLowerCase())) {
        skipped += 1
        continue
      }

      const fileStats = await stat(absolutePath)
      files.push({
        absolutePath,
        relativePath: path.relative(root, absolutePath),
        checksum: await checksum(absolutePath),
        size: fileStats.size,
        modifiedAt: fileStats.mtimeMs
      })
    }
  }

  await walk(root)
  return { files, skipped }
}

export async function scanDocumentMetadata(folderPath: string): Promise<ScannedFileMetadata[]> {
  const root = await realpath(folderPath)
  const rootStats = await stat(root)
  if (!rootStats.isDirectory()) {
    throw new PocketRagError('The selected knowledge location is not a folder.', 'INVALID_FOLDER')
  }

  const files: ScannedFileMetadata[] = []
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('~$') || entry.isSymbolicLink()) {
        continue
      }
      const absolutePath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(absolutePath)
      } else if (
        entry.isFile() &&
        supportedExtensions.has(path.extname(entry.name).toLowerCase())
      ) {
        const fileStats = await stat(absolutePath)
        files.push({
          relativePath: path.relative(root, absolutePath),
          size: fileStats.size,
          modifiedAt: fileStats.mtimeMs
        })
      }
    }
  }
  await walk(root)
  return files
}
