import type { UserFacingFailure } from '../../shared/contracts'

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class PocketRagError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = 'PocketRagError'
  }
}

function safeTechnicalDetails(error: unknown): string | undefined {
  const message = errorMessage(error).trim()
  if (!message) return undefined
  return message
    .replace(/\/(?:Users|home)\/[^\s:]+/g, '[local path]')
    .replace(/(?:[A-Za-z]:\\Users\\)[^\\\s:]+/g, '[local path]')
    .slice(0, 800)
}

export function userFacingFailure(error: unknown): UserFacingFailure {
  const code = error instanceof PocketRagError ? error.code : 'UNEXPECTED_ERROR'
  const technicalDetails = safeTechnicalDetails(error)
  const byCode: Record<string, Omit<UserFacingFailure, 'code' | 'technicalDetails'>> = {
    OLLAMA_NOT_INSTALLED: {
      title: 'Local AI is not ready',
      message: 'Finish the local setup, then try your question again. Your chat is safe.',
      retryable: true,
      primaryAction: { id: 'open-settings', label: 'Open Settings' }
    },
    OLLAMA_START_FAILED: {
      title: 'Local AI paused unexpectedly',
      message: 'RavnDock can restart it without changing your chat or documents.',
      retryable: true,
      primaryAction: { id: 'restart-local-ai', label: 'Restart local AI' },
      secondaryAction: { id: 'open-settings', label: 'Open Settings' }
    },
    OLLAMA_START_TIMEOUT: {
      title: 'Local AI is taking longer than expected',
      message: 'Your chat is safe. Try restarting local AI once.',
      retryable: true,
      primaryAction: { id: 'restart-local-ai', label: 'Restart local AI' }
    },
    RAG_REQUESTED_FILE_NOT_FOUND: {
      title: 'That file is not in this knowledge base',
      message: 'Check the file name or sync the folder again.',
      retryable: true,
      primaryAction: { id: 'edit-question', label: 'Edit question' },
      secondaryAction: { id: 'sync-files', label: 'Review files' }
    },
    RAG_NO_RESULTS: {
      title: 'I could not find a matching section',
      message: 'Name a file, topic, or field to make the question more specific.',
      retryable: true,
      primaryAction: { id: 'edit-question', label: 'Edit question' },
      secondaryAction: { id: 'choose-files', label: 'Choose files' }
    },
    RAG_LOW_CONFIDENCE: {
      title: 'I need a little more detail',
      message: 'Name a file, topic, or field so I can use the right information.',
      retryable: true,
      primaryAction: { id: 'edit-question', label: 'Edit question' }
    },
    RAG_SOURCE_AMBIGUOUS: {
      title: 'Choose which file to use',
      message: 'I found more than one likely source. Add the file name to your question.',
      retryable: true,
      primaryAction: { id: 'edit-question', label: 'Edit question' },
      secondaryAction: { id: 'choose-files', label: 'Choose files' }
    },
    RAG_RUNTIME_MISSING: {
      title: 'Document tools are not ready',
      message: 'Finish the private document setup, then try again.',
      retryable: true,
      primaryAction: { id: 'open-settings', label: 'Open Settings' }
    }
  }
  const known = byCode[code]
  if (known) {
    return {
      ...known,
      message: code === 'RAG_SOURCE_AMBIGUOUS' ? errorMessage(error) : known.message,
      code,
      technicalDetails
    }
  }

  const message = errorMessage(error)
  if (/fetch failed|ECONNREFUSED|socket|connection reset|terminated/i.test(message)) {
    return {
      title: 'Local AI stopped responding',
      message: 'Your chat is safe. Restart local AI and try again.',
      code: 'LOCAL_AI_CONNECTION_LOST',
      retryable: true,
      primaryAction: { id: 'restart-local-ai', label: 'Restart local AI' },
      secondaryAction: { id: 'retry-chat', label: 'Review and retry' },
      technicalDetails
    }
  }
  return {
    title: 'Something interrupted this answer',
    message: 'Your chat and documents are safe. Try the question again.',
    code,
    retryable: true,
    primaryAction: { id: 'retry-chat', label: 'Review and retry' },
    secondaryAction: { id: 'open-settings', label: 'Open Settings' },
    technicalDetails
  }
}
