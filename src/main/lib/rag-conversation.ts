import type { ChatMessage } from '../../shared/contracts'

export interface ConversationResolution {
  question: string
  clarification: string | null
  usedPriorContext: boolean
}

function previousAnswerOutline(answer: string): string[] {
  const lines = answer
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const structured = lines
    .filter((line) => /^(?:#{1,4}\s+|[-*+]\s+|\d+[.)]\s+)/.test(line))
    .map((line) => line.replace(/^#{1,4}\s+/, '').slice(0, 240))
    .slice(0, 24)
  if (structured.length > 0) return structured
  return answer
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((sentence) => sentence.slice(0, 240))
}

function ordinalIndex(question: string): number | null {
  const match = question.match(/\b(first|second|third|fourth|fifth|sixth|\d+(?:st|nd|rd|th)?)\b/i)
  if (!match) return null
  const names: Record<string, number> = {
    first: 0,
    second: 1,
    third: 2,
    fourth: 3,
    fifth: 4,
    sixth: 5
  }
  const normalized = match[1].toLowerCase()
  return names[normalized] ?? Math.max(0, Number.parseInt(normalized, 10) - 1)
}

export function resolveConversationQuestion(messages: ChatMessage[]): ConversationResolution {
  let latestIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      latestIndex = index
      break
    }
  }
  const latest = latestIndex >= 0 ? messages[latestIndex].content.trim() : ''
  if (!latest) return { question: '', clarification: null, usedPriorContext: false }
  if (/\.(?:pdf|docx|pptx|xlsx|xls|csv|txt|md|markdown)\b/i.test(latest)) {
    return { question: latest, clarification: null, usedPriorContext: false }
  }
  const previousUser = [...messages.slice(0, latestIndex)]
    .reverse()
    .find((message) => message.role === 'user')
    ?.content.trim()
  if (!previousUser) return { question: latest, clarification: null, usedPriorContext: false }

  const looksLikeFollowUp =
    /^(?:(?:and|also|but|how|what)\s+(?:about|else)|tell me more|continue|go on|why\??|how so|can you elaborate|please explain|expand on that)\b|\b(?:(?:first|second|third|fourth|fifth|sixth|\d+(?:st|nd|rd|th)?)\s+(?:point|bullet|item|option)|it|its|that|those|them|they|this (?:point|option|file|document|section|item)|these|same|former|latter|above|previous|last answer|bullet point)\b/i.test(
      latest
    )
  if (!looksLikeFollowUp) {
    return { question: latest, clarification: null, usedPriorContext: false }
  }

  const previousAssistant = [...messages.slice(0, latestIndex)]
    .reverse()
    .find((message) => message.role === 'assistant')
    ?.content.trim()
  if (!previousAssistant) {
    return {
      question: latest,
      clarification:
        'What does this refer to? Name the topic or point you want me to continue from.',
      usedPriorContext: false
    }
  }
  const outline = previousAnswerOutline(previousAssistant)
  const requestedOrdinal = ordinalIndex(latest)
  if (requestedOrdinal !== null && !outline[requestedOrdinal]) {
    return {
      question: latest,
      clarification:
        'Which point do you mean? Name the point or paste a few words from the previous answer.',
      usedPriorContext: false
    }
  }
  const referencedItem = requestedOrdinal === null ? null : outline[requestedOrdinal]
  return {
    question: [
      `Previous question: ${previousUser}`,
      ...(referencedItem ? [`Referenced item: ${referencedItem}`] : []),
      `Previous answer outline:\n${outline.map((item, index) => `${index + 1}. ${item}`).join('\n')}`,
      `Follow-up question: ${latest}`
    ].join('\n'),
    clarification: null,
    usedPriorContext: true
  }
}

export function conversationAwareQuestion(messages: ChatMessage[]): string {
  return resolveConversationQuestion(messages).question
}
