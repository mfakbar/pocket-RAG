import type { ChatRequest } from '../../shared/contracts'

const MAX_MESSAGES = 50
const MAX_MESSAGE_LENGTH = 100_000
const MAX_CONVERSATION_LENGTH = 500_000
const MAX_KNOWLEDGE_BASES = 20
const MAX_ATTACHMENTS = 10

export function validChatRequest(value: unknown): value is ChatRequest {
  if (typeof value !== 'object' || value === null || !('messages' in value)) return false
  const request = value as Record<string, unknown>
  const messages = request.messages
  const knowledgeBaseIds = request.knowledgeBaseIds
  const attachmentPaths = request.attachmentPaths

  if (
    request.sensitiveAccessConfirmed !== undefined &&
    typeof request.sensitiveAccessConfirmed !== 'boolean'
  ) {
    return false
  }

  if (typeof request.useKnowledgeBase !== 'boolean') return false
  if (
    !Array.isArray(knowledgeBaseIds) ||
    knowledgeBaseIds.length > MAX_KNOWLEDGE_BASES ||
    !knowledgeBaseIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 100)
  ) {
    return false
  }
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    return false
  }

  let conversationLength = 0
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) return false
    const candidate = message as Record<string, unknown>
    if (candidate.role !== 'user' && candidate.role !== 'assistant') return false
    if (typeof candidate.content !== 'string' || candidate.content.length > MAX_MESSAGE_LENGTH) {
      return false
    }
    conversationLength += candidate.content.length
    if (conversationLength > MAX_CONVERSATION_LENGTH) return false
  }

  return (
    attachmentPaths === undefined ||
    (Array.isArray(attachmentPaths) &&
      attachmentPaths.length <= MAX_ATTACHMENTS &&
      attachmentPaths.every(
        (filePath) => typeof filePath === 'string' && filePath.length > 0 && filePath.length <= 4096
      ))
  )
}

export function validModelName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 200 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._/:-]*$/.test(value)
  )
}
