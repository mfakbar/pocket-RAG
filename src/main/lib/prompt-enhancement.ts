export interface PromptKnowledgeBase {
  name: string
}

const QUERY_OPENING =
  /^(?:please\s+)?(?:what|which|how|why|when|where|who|compare|analy[sz]e|identify|explain|evaluate|assess|review|find|outline|summari[sz]e|draft|prepare|create|using|based on)\b/i

const STOP_WORDS = new Set([
  'about',
  'also',
  'and',
  'are',
  'available',
  'based',
  'files',
  'for',
  'from',
  'into',
  'local',
  'most',
  'of',
  'on',
  'relevant',
  'selected',
  'that',
  'the',
  'these',
  'this',
  'using',
  'what',
  'which',
  'with'
])

const INTENTS: Array<[RegExp, RegExp]> = [
  [/\bcompar(?:e|ison|ing)\b/i, /\bcompar(?:e|ison|ing)\b/i],
  [/\bsummari[sz](?:e|ing|ation)\b/i, /\bsummari[sz](?:e|ing|ation)\b/i],
  [/\bexplain\b/i, /\bexplain\b/i],
  [/\bdraft\b/i, /\bdraft\b/i],
  [/\btimeline\b/i, /\b(?:timeline|chronological)\b/i],
  [/\brisks?\b/i, /\brisks?\b/i]
]

function terms(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9._/-]*/g)
      ?.filter((term) => term.length >= 3 && !STOP_WORDS.has(term)) ?? []
  )
}

function captures(value: string, pattern: RegExp): Set<string> {
  return new Set([...value.matchAll(pattern)].map((match) => match[1].toLowerCase()))
}

export function isPromptOnlyOutput(value: string): boolean {
  const prompt = value.trim()
  if (prompt.length < 8 || prompt.length > 700 || prompt.includes('\n')) return false
  if (/\||\*\*|`|\[\d+\]|<\/?[a-z][^>]*>/i.test(prompt)) return false
  if (/^(?:[-*]|\d+\.)\s/m.test(prompt)) return false
  return QUERY_OPENING.test(prompt)
}

export function isSemanticallySafeEnhancedPrompt(
  originalPrompt: string,
  enhancedPrompt: string,
  knowledgeBases: PromptKnowledgeBase[]
): boolean {
  if (!isPromptOnlyOutput(enhancedPrompt)) return false
  const original = originalPrompt.replace(/\s+/g, ' ').trim()
  const enhanced = enhancedPrompt.replace(/\s+/g, ' ').trim()
  const allowedContext = `${original} ${knowledgeBases.map((base) => base.name).join(' ')}`

  if (
    /\b(?:rewrite|your task|you are|respond with|return only|system prompt|original intent|insert original|guidelines|descriptions and instructions)\b/i.test(
      enhanced
    ) ||
    /\[(?:insert|original)[^\]]*\]/i.test(enhanced)
  ) {
    return false
  }
  if (/\b(?:the answer is|the documents (?:show|state|confirm)|in summary)\b/i.test(enhanced)) {
    return false
  }

  const allowedAcronyms = captures(allowedContext, /\b([A-Z][A-Z0-9-]{1,})\b/g)
  const enhancedAcronyms = captures(enhanced, /\b([A-Z][A-Z0-9-]{1,})\b/g)
  if ([...enhancedAcronyms].some((item) => !allowedAcronyms.has(item))) return false
  for (const acronym of captures(original, /\b([A-Z][A-Z0-9-]{1,})\b/g)) {
    if (new RegExp(`\\b${acronym}\\s*\\(`, 'i').test(enhanced)) return false
  }

  const allowedNumbers = captures(allowedContext, /\b(\d+(?:[.,]\d+)?)\b/g)
  const enhancedNumbers = captures(enhanced, /\b(\d+(?:[.,]\d+)?)\b/g)
  if ([...enhancedNumbers].some((item) => !allowedNumbers.has(item))) return false

  const allowedQuotes = captures(allowedContext, /["“]([^"”]{2,})["”]/g)
  const enhancedQuotes = captures(enhanced, /["“]([^"”]{2,})["”]/g)
  if ([...enhancedQuotes].some((item) => !allowedQuotes.has(item))) return false

  if (!/\b(?:owner|responsible|deadline|day|week|month|quarter|year)\b/i.test(original)) {
    if (
      /\b(?:owner|responsible|deadline|\d+\s+(?:day|week|month|quarter|year)s?)\b/i.test(enhanced)
    ) {
      return false
    }
  }

  for (const [originalIntent, requiredIntent] of INTENTS) {
    if (originalIntent.test(original) && !requiredIntent.test(enhanced)) return false
  }

  const originalTerms = terms(original)
  const enhancedTerms = terms(enhanced)
  if (originalTerms.size > 0) {
    const retained = [...originalTerms].filter((term) => enhancedTerms.has(term)).length
    if (retained / originalTerms.size < 0.6) return false
  }
  return true
}

export function fallbackEnhancedPrompt(
  originalPrompt: string,
  knowledgeBases: PromptKnowledgeBase[]
): string {
  const original = originalPrompt.replace(/\s+/g, ' ').trim()
  if (
    original.length >= 120 &&
    /\b(?:do not|only when|use only|otherwise|until i choose)\b/i.test(original)
  ) {
    return original
  }
  const names = knowledgeBases.map((base) => base.name).filter(Boolean)
  const alreadyScoped = names.some((name) => original.toLowerCase().includes(name.toLowerCase()))
  const context =
    names.length === 0
      ? 'Using the selected local documents'
      : `Using the ${names.join(', ')} knowledge base${names.length === 1 ? '' : 's'}`

  const prefix = alreadyScoped ? '' : `${context}, `
  return `${prefix}${original} Use only relevant file content, cite supporting passages, and state clearly when the files do not contain enough information.`
}
