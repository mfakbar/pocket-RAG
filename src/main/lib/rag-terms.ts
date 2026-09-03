const QUERY_STOP_WORDS = new Set([
  'about',
  'and',
  'are',
  'document',
  'file',
  'for',
  'from',
  'have',
  'how',
  'in',
  'is',
  'of',
  'on',
  'the',
  'this',
  'to',
  'what',
  'which',
  'with',
  'your'
])

const TOPIC_STOP_WORDS = new Set([
  ...QUERY_STOP_WORDS,
  'aci',
  'best',
  'center',
  'cisco',
  'cover',
  'data',
  'design',
  'dc',
  'implementing',
  'implementation',
  'network',
  'practice',
  'practices',
  'question',
  'questions',
  'refer',
  'reference',
  'sdn',
  'service'
])

export function queryTerms(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9._/-]+/g, ' ')
      .split(/\s+/)
      .filter((term) => term.length >= 3 && !QUERY_STOP_WORDS.has(term))
  )
}

export function topicTerms(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((term) => term.length >= 3 && !TOPIC_STOP_WORDS.has(term))
}
