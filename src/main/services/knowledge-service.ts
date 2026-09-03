import { createHash } from 'node:crypto'
import type {
  KnowledgeStaleness,
  SyncError,
  SyncProgress,
  SyncResult,
  SyncStats
} from '../../shared/contracts'
import { scanDocumentFolder, scanDocumentMetadata, type ScanResult } from '../lib/document-scanner'
import { errorMessage, PocketRagError } from '../lib/errors'
import {
  readConfig,
  updateConfig,
  type ManifestEntry,
  type StoredConfig,
  type StoredKnowledgeBase
} from '../settings'
import { LocalRagService } from './local-rag-service'

export const RAG_BACKEND_VERSION = 8
const LARGE_FILE_BYTES = 100 * 1024 * 1024

function preparationMessage(file: { relativePath: string; size: number }): string {
  return file.size >= LARGE_FILE_BYTES
    ? `Preparing large file ${file.relativePath}. This may take longer, but you can keep using RavnDock.`
    : `Preparing ${file.relativePath}`
}

function documentId(knowledgeBaseId: string, relativePath: string): string {
  return createHash('sha256').update(`${knowledgeBaseId}:${relativePath}`).digest('hex')
}

function manifestEntry(
  knowledgeBaseId: string,
  file: { relativePath: string; checksum: string; size: number; modifiedAt: number }
): ManifestEntry {
  return {
    checksum: file.checksum,
    fileId: documentId(knowledgeBaseId, file.relativePath),
    size: file.size,
    modifiedAt: file.modifiedAt,
    syncedAt: new Date().toISOString()
  }
}

function friendlySyncError(error: unknown): string {
  const message = errorMessage(error)
  if (
    /modelscope|rapido?cr|pp-ocr|failed to download|image text recognition is not installed/i.test(
      message
    )
  ) {
    return 'This visual file needs local text recognition, which is not downloaded yet. Connect to the internet once, then sync again.'
  }
  if (
    /CERTIFICATE_VERIFY_FAILED|unable to get local issuer certificate|snapshot folder/i.test(
      message
    )
  ) {
    return 'RavnDock could not prepare this file because its optional local reader is not available. Check your internet connection, then try again.'
  }
  if (/no readable text|contains no readable text/i.test(message)) {
    return 'RavnDock could not find readable text in this file. If it is a scanned PDF, turn on PDF text recognition in Advanced Settings and sync again.'
  }
  if (/timed out/i.test(message)) {
    return 'This file took too long to prepare. Make sure it is available on this Mac, then try again.'
  }
  return 'RavnDock could not read this file. Try opening it on this Mac, then sync again.'
}

function syncError(path: string, error: unknown): SyncError {
  const technicalDetails = errorMessage(error)
    .replace(/\/(?:Users|home)\/[^\s:]+/g, '[local path]')
    .slice(0, 800)
  return { path, message: friendlySyncError(error), technicalDetails }
}

function result(stats: SyncStats, errors: SyncError[]): SyncResult {
  return {
    ok: errors.length === 0,
    ...stats,
    message:
      errors.length === 0
        ? `${stats.indexed} document${stats.indexed === 1 ? '' : 's'} ready.`
        : `${errors.length} document${errors.length === 1 ? '' : 's'} could not be synced.`,
    errors
  }
}

function selectedBase(config: StoredConfig, id?: string): StoredKnowledgeBase {
  const base = config.knowledgeBases.find(
    (item) => item.id === (id || config.activeKnowledgeBaseId)
  )
  if (!base) throw new PocketRagError('Choose a knowledge base first.', 'KNOWLEDGE_BASE_REQUIRED')
  return base
}

function updateBase(
  config: StoredConfig,
  id: string,
  patch: Partial<
    Pick<StoredKnowledgeBase, 'manifest' | 'syncStats' | 'syncErrors' | 'ragBackendVersion'>
  >
): StoredConfig {
  const knowledgeBases = config.knowledgeBases.map((item) =>
    item.id === id ? { ...item, ...patch } : item
  )
  if (config.activeKnowledgeBaseId !== id) return { ...config, knowledgeBases }
  return {
    ...config,
    knowledgeBases,
    manifest: patch.manifest ?? config.manifest,
    syncStats: patch.syncStats ?? config.syncStats,
    ragBackendVersion: patch.ragBackendVersion ?? config.ragBackendVersion
  }
}

export class KnowledgeService {
  constructor(private readonly rag: LocalRagService) {}

  async staleness(knowledgeBaseId?: string): Promise<KnowledgeStaleness> {
    const config = await readConfig()
    const base = selectedBase(config, knowledgeBaseId)
    const files = await scanDocumentMetadata(base.folder)
    const current = new Map(files.map((file) => [file.relativePath, file]))
    let changedFiles = 0
    for (const [relativePath, entry] of Object.entries(base.manifest)) {
      const file = current.get(relativePath)
      if (!file || file.size !== entry.size || Math.abs(file.modifiedAt - entry.modifiedAt) > 1) {
        changedFiles += 1
      }
      current.delete(relativePath)
    }
    changedFiles += current.size
    return { stale: changedFiles > 0, changedFiles, checkedAt: new Date().toISOString() }
  }

  private async scan(
    base: StoredKnowledgeBase,
    onProgress: (progress: SyncProgress) => void
  ): Promise<ScanResult> {
    onProgress({
      phase: 'scanning',
      current: 0,
      total: 0,
      message: `Checking ${base.name} for documents...`
    })
    return scanDocumentFolder(base.folder)
  }

  private async generationSync(
    base: StoredKnowledgeBase,
    config: StoredConfig,
    onProgress: (progress: SyncProgress) => void,
    forceRebuild: boolean
  ): Promise<SyncResult> {
    const scan = await this.scan(base, onProgress)
    const errors: SyncError[] = []
    const nextManifest: Record<string, ManifestEntry> = {}

    if (scan.files.length === 0) {
      const { generation } = await this.rag.beginRebuild(base.id)
      await this.rag.commitRebuild(base.id, generation)
      const stats: SyncStats = {
        indexed: 0,
        added: 0,
        updated: 0,
        removed: Object.keys(base.manifest).length,
        unchanged: 0,
        skipped: scan.skipped,
        failed: 0,
        lastSyncedAt: new Date().toISOString()
      }
      await updateConfig((current) =>
        updateBase(current, base.id, {
          ragBackendVersion: RAG_BACKEND_VERSION,
          manifest: {},
          syncStats: stats,
          syncErrors: []
        })
      )
      return result(stats, errors)
    }

    const currentPaths = new Set(scan.files.map((file) => file.relativePath))
    const moveCandidates = new Map<string, Array<[string, ManifestEntry]>>()
    for (const [relativePath, entry] of Object.entries(base.manifest)) {
      if (currentPaths.has(relativePath)) continue
      moveCandidates.set(entry.checksum, [
        ...(moveCandidates.get(entry.checksum) ?? []),
        [relativePath, entry]
      ])
    }

    const { generation } = await this.rag.beginRebuild(base.id)
    let unchanged = 0
    let failedProtectedDocument = false
    try {
      for (const [index, file] of scan.files.entries()) {
        onProgress({
          phase: 'uploading',
          current: index + 1,
          total: scan.files.length,
          path: file.relativePath,
          message: preparationMessage(file)
        })
        try {
          const entry = manifestEntry(base.id, file)
          const existing = base.manifest[file.relativePath]
          const needsRetry = base.syncErrors.some((item) => item.path === file.relativePath)
          if (!forceRebuild && existing?.checksum === file.checksum && !needsRetry) {
            const cloned = await this.rag.cloneDocument(
              base.id,
              generation,
              existing.fileId,
              existing.fileId,
              existing.checksum,
              file.relativePath
            )
            if (!cloned.cloned) {
              await this.rag.indexDocument(
                base.id,
                file.absolutePath,
                file.relativePath,
                entry.fileId,
                file.checksum,
                config.rag,
                generation
              )
            }
            nextManifest[file.relativePath] = existing
            unchanged += 1
            continue
          }

          const moves = moveCandidates.get(file.checksum) ?? []
          if (!forceRebuild && !existing && moves.length === 1) {
            const [, movedEntry] = moves[0]
            const cloned = await this.rag.cloneDocument(
              base.id,
              generation,
              movedEntry.fileId,
              entry.fileId,
              entry.checksum,
              file.relativePath
            )
            if (cloned.cloned) {
              nextManifest[file.relativePath] = entry
              continue
            }
          }

          await this.rag.indexDocument(
            base.id,
            file.absolutePath,
            file.relativePath,
            entry.fileId,
            file.checksum,
            config.rag,
            generation
          )
          nextManifest[file.relativePath] = entry
        } catch (error) {
          errors.push(syncError(file.relativePath, error))
          failedProtectedDocument =
            failedProtectedDocument ||
            Boolean(base.manifest[file.relativePath]) ||
            (moveCandidates.get(file.checksum)?.length ?? 0) === 1
        }
      }
      if (failedProtectedDocument) {
        await this.rag.abortRebuild(base.id, generation)
        const stats: SyncStats = {
          ...base.syncStats,
          indexed: Object.keys(base.manifest).length,
          added: 0,
          updated: 0,
          removed: 0,
          unchanged: 0,
          skipped: scan.skipped,
          failed: errors.length
        }
        await updateConfig((current) =>
          updateBase(current, base.id, { syncStats: stats, syncErrors: errors })
        )
        return result(stats, errors)
      }

      if (errors.length > 0 && Object.keys(nextManifest).length === 0) {
        await this.rag.abortRebuild(base.id, generation)
        const stats: SyncStats = {
          ...base.syncStats,
          indexed: Object.keys(base.manifest).length,
          added: 0,
          updated: 0,
          removed: 0,
          unchanged: 0,
          skipped: scan.skipped,
          failed: errors.length
        }
        await updateConfig((current) =>
          updateBase(current, base.id, { syncStats: stats, syncErrors: errors })
        )
        return result(stats, errors)
      }

      await this.rag.pruneGeneration(
        base.id,
        generation,
        Object.values(nextManifest).map((entry) => entry.fileId)
      )
      await this.rag.commitRebuild(base.id, generation)
      const previousPaths = new Set(Object.keys(base.manifest))
      const nextPaths = new Set(Object.keys(nextManifest))
      const stats: SyncStats = {
        indexed: nextPaths.size,
        added: [...nextPaths].filter((item) => !previousPaths.has(item)).length,
        updated: [...nextPaths].filter(
          (item) =>
            previousPaths.has(item) &&
            base.manifest[item]?.checksum !== nextManifest[item]?.checksum
        ).length,
        removed: [...previousPaths].filter((item) => !nextPaths.has(item)).length,
        unchanged,
        skipped: scan.skipped,
        failed: errors.length,
        lastSyncedAt: new Date().toISOString()
      }
      await updateConfig((current) =>
        updateBase(current, base.id, {
          ragBackendVersion: RAG_BACKEND_VERSION,
          manifest: nextManifest,
          syncStats: stats,
          syncErrors: errors
        })
      )
      return result(stats, errors)
    } catch (error) {
      await this.rag.abortRebuild(base.id, generation).catch(() => undefined)
      throw error
    }
  }

  async sync(
    knowledgeBaseId?: string,
    onProgress: (progress: SyncProgress) => void = () => undefined
  ): Promise<SyncResult> {
    const config = await readConfig()
    const base = selectedBase(config, knowledgeBaseId)
    return this.generationSync(
      base,
      config,
      onProgress,
      base.ragBackendVersion !== RAG_BACKEND_VERSION
    )
  }

  async rebuild(
    knowledgeBaseId?: string,
    onProgress: (progress: SyncProgress) => void = () => undefined
  ): Promise<SyncResult> {
    const config = await readConfig()
    return this.generationSync(selectedBase(config, knowledgeBaseId), config, onProgress, true)
  }
}
