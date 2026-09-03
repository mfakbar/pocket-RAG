import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_INFERENCE_SETTINGS,
  DEFAULT_RAG_SETTINGS,
  type ChatPerformanceMetrics
} from '../src/shared/contracts'
import { LocalRagService, UNTRUSTED_SOURCE_RULES } from '../src/main/services/local-rag-service'
import type { OllamaService } from '../src/main/services/ollama-service'
import type { StructuredRow } from '../src/main/lib/rag-pipeline'

const metrics: ChatPerformanceMetrics = {
  timeToFirstTokenMs: 12,
  totalDurationMs: 40,
  completionTokens: 8,
  tokensPerSecond: 50,
  interTokenLatencyMs: 20
}

type MockRetrieval = {
  chunks: Array<{
    text: string
    file: string
    path: string
    location: string
    heading: string
    score: number
    knowledgeBaseId: string
  }>
  structuredRows?: StructuredRow[]
  metrics: { retrievalMode: 'direct_lookup' | 'spreadsheet_comparison' }
}

function serviceWithAnswer(
  answer: string | string[],
  calls: unknown[][] = [],
  retrieval?: MockRetrieval
): LocalRagService {
  const answers = Array.isArray(answer) ? answer : [answer]
  let callIndex = 0
  const ollama = {
    activateModel: async () => undefined,
    streamChat: async (
      _model: string,
      messages: unknown[],
      _inference: unknown,
      onToken: (content: string) => void
    ) => {
      calls.push(messages)
      onToken(answers[Math.min(callIndex, answers.length - 1)] ?? '')
      callIndex += 1
      return metrics
    }
  } as unknown as OllamaService
  const service = new LocalRagService(
    () => '',
    () => '',
    '',
    '',
    '',
    ollama
  )
  const mutable = service as unknown as {
    retrieve: () => Promise<MockRetrieval>
  }
  mutable.retrieve = async () =>
    retrieval ?? {
      chunks: [
        {
          text: 'The C880 configuration has a 60 day lead time.',
          file: 'configurations.xlsx',
          path: 'configurations.xlsx',
          location: 'Sheet Options, A1:B2',
          heading: 'Options',
          score: 1,
          knowledgeBaseId: 'kb-1'
        }
      ],
      metrics: { retrievalMode: 'direct_lookup' }
    }
  return service
}

test('answers supported spreadsheet calculations without invoking the chat model', async () => {
  const calls: unknown[][] = []
  const rows: StructuredRow[] = [
    {
      knowledgeBaseId: 'kb-1',
      documentId: 'boq',
      path: 'boq.xlsx',
      file: 'boq.xlsx',
      sheet: 'BoQ',
      rowIndex: 9,
      score: 1,
      cells: [
        {
          columnIndex: 1,
          column: 'Product',
          address: 'A9',
          value: 'PART-123',
          rawValue: 'PART-123',
          valueType: 's',
          numericValue: null,
          unit: '',
          formula: ''
        },
        {
          columnIndex: 2,
          column: 'Qty',
          address: 'B9',
          value: '4',
          rawValue: '4',
          valueType: 'n',
          numericValue: 4,
          unit: '',
          formula: ''
        }
      ]
    },
    {
      knowledgeBaseId: 'kb-1',
      documentId: 'boq',
      path: 'boq.xlsx',
      file: 'boq.xlsx',
      sheet: 'BoQ',
      rowIndex: 17,
      score: 1,
      cells: [
        {
          columnIndex: 1,
          column: 'Product',
          address: 'A17',
          value: 'PART-123',
          rawValue: 'PART-123',
          valueType: 's',
          numericValue: null,
          unit: '',
          formula: ''
        },
        {
          columnIndex: 2,
          column: 'Qty',
          address: 'B17',
          value: '18',
          rawValue: '18',
          valueType: 'n',
          numericValue: 18,
          unit: '',
          formula: ''
        }
      ]
    }
  ]
  const service = serviceWithAnswer('This model answer must not be used.', calls, {
    chunks: [
      {
        text: 'Product=PART-123; Qty=4\nProduct=PART-123; Qty=18',
        file: 'boq.xlsx',
        path: 'boq.xlsx',
        location: 'Sheet BoQ, A1:B20',
        heading: 'BoQ',
        score: 1,
        knowledgeBaseId: 'kb-1'
      }
    ],
    structuredRows: rows,
    metrics: { retrievalMode: 'spreadsheet_comparison' }
  })
  const events: Array<{ type: string; content?: string; message?: string }> = []

  await service.streamChat(
    'qwen3.5:4b-q4_K_M',
    [{ role: 'user', content: 'In boq.xlsx, what is the combined Qty for PART-123?' }],
    DEFAULT_RAG_SETTINGS,
    DEFAULT_INFERENCE_SETTINGS,
    [{ id: 'kb-1', name: 'BoQ', description: '', customInstructions: '' }],
    [],
    false,
    (event) => events.push(event),
    new AbortController().signal
  )

  assert.equal(calls.length, 0)
  assert.match(events.find((event) => event.type === 'token')?.content ?? '', /quantity: 22/i)
  assert.match(events.find((event) => event.type === 'notice')?.message ?? '', /verified directly/i)
})

test('forwards RAG tokens immediately instead of replaying a completed answer', async () => {
  const events: Array<{ type: string; content?: string }> = []
  await serviceWithAnswer('The C880 configuration has a 60 day lead time [1].').streamChat(
    'qwen3.5:2b-q4_K_M',
    [{ role: 'user', content: 'What is the lead time?' }],
    DEFAULT_RAG_SETTINGS,
    DEFAULT_INFERENCE_SETTINGS,
    [{ id: 'kb-1', name: 'BoQ', description: 'Bill of materials', customInstructions: '' }],
    [],
    false,
    (event) => events.push(event),
    new AbortController().signal
  )

  assert.deepEqual(
    events.map((event) => event.type),
    ['citations', 'notice', 'token', 'status']
  )
})

test('preserves a valid Markdown table after local validation', async () => {
  const events: Array<{ type: string; content?: string }> = []
  const draft = '| Configuration | Lead time |\n| --- | --- |\n| C880 | 60 days [1] |'
  await serviceWithAnswer(draft).streamChat(
    'qwen3.5:2b-q4_K_M',
    [{ role: 'user', content: 'What is the lead time?' }],
    DEFAULT_RAG_SETTINGS,
    DEFAULT_INFERENCE_SETTINGS,
    [{ id: 'kb-1', name: 'BoQ', description: 'Bill of materials', customInstructions: '' }],
    [],
    false,
    (event) => events.push(event),
    new AbortController().signal
  )

  assert.equal(events.find((event) => event.type === 'token')?.content, draft)
  assert.equal(
    events.find((event) => event.type === 'replace'),
    undefined
  )
})

test('removes unsupported content without asking the model to rewrite it', async () => {
  const calls: unknown[][] = []
  const events: Array<{ type: string; content?: string }> = []
  const service = serviceWithAnswer(
    [
      'The C880 configuration is listed in the workbook [1].\n\nThe price is $999 USD [1].',
      'The lead time is 60 days [1].'
    ],
    calls
  )
  await service.streamChat(
    'qwen3.5:4b-q4_K_M',
    [{ role: 'user', content: 'Give the configuration and lead time.' }],
    DEFAULT_RAG_SETTINGS,
    DEFAULT_INFERENCE_SETTINGS,
    [{ id: 'kb-1', name: 'BoQ', description: 'Bill of materials', customInstructions: '' }],
    [],
    false,
    (event) => events.push(event),
    new AbortController().signal
  )

  assert.equal(calls.length, 1)
  const replacement = events.find((event) => event.type === 'replace')?.content ?? ''
  assert.match(replacement, /Initial response \(not source-verified\)/)
  assert.match(replacement, /configuration is listed/)
  assert.match(replacement, /Verified summary/)
  assert.match(replacement, /60 day lead time/)
  assert.match(replacement.split('## Verified summary')[0] ?? '', /\$999/)
  assert.doesNotMatch(replacement.split('## Verified summary')[1] ?? '', /\$999/)
})

test('keeps verified claims when the repair still contains unsupported content', async () => {
  const events: Array<{ type: string; content?: string }> = []
  const service = serviceWithAnswer([
    'The C880 configuration has a 60 day lead time [1].\n\nThe price is $999 USD [1].',
    'The unsupported price is still $999 USD [1].'
  ])

  await service.streamChat(
    'qwen3.5:2b-q4_K_M',
    [{ role: 'user', content: 'Give the lead time and price.' }],
    DEFAULT_RAG_SETTINGS,
    DEFAULT_INFERENCE_SETTINGS,
    [{ id: 'kb-1', name: 'BoQ', description: 'Bill of materials', customInstructions: '' }],
    [],
    false,
    (event) => events.push(event),
    new AbortController().signal
  )

  const replacement = [...events].reverse().find((event) => event.type === 'replace')?.content ?? ''
  assert.match(replacement, /Initial response \(not source-verified\)/)
  assert.match(replacement, /60 day lead time/)
  assert.match(replacement, /Verified summary/)
  assert.match(replacement.split('## Verified summary')[0] ?? '', /\$999/)
  assert.doesNotMatch(replacement.split('## Verified summary')[1] ?? '', /\$999/)
})

test('preserves a grounded table above the verified summary after source checking', async () => {
  const events: Array<{ type: string; content?: string }> = []
  const draft =
    '## Configuration comparison\n\n' +
    '| Configuration | Lead time |\n' +
    '| --- | --- |\n' +
    '| C880 | 60 days [1] |\n\n' +
    'The unsupported price is $999 USD [1].'

  await serviceWithAnswer(draft).streamChat(
    'qwen3.5:4b-q4_K_M',
    [{ role: 'user', content: 'Compare the configuration and lead time.' }],
    DEFAULT_RAG_SETTINGS,
    DEFAULT_INFERENCE_SETTINGS,
    [{ id: 'kb-1', name: 'BoQ', description: 'Bill of materials', customInstructions: '' }],
    [],
    false,
    (event) => events.push(event),
    new AbortController().signal
  )

  const replacement = events.find((event) => event.type === 'replace')?.content ?? ''
  assert.match(replacement, /^## Initial response \(not source-verified\)/m)
  assert.match(replacement, /\| C880 \| 60 days \[1\] \|/)
  assert.match(replacement, /^## Verified summary/m)
  assert.match(replacement.split('## Verified summary')[0] ?? '', /\$999/)
  assert.doesNotMatch(replacement.split('## Verified summary')[1] ?? '', /\$999/)
})

test('preserves the initial response even when none of its claims pass source checking', async () => {
  const events: Array<{ type: string; content?: string }> = []
  const draft = 'Rafay provides centralized operations, zero-touch automation, and lower costs [1].'

  await serviceWithAnswer(draft).streamChat(
    'qwen3.5:4b-q4_K_M',
    [{ role: 'user', content: 'What is the C880 lead time?' }],
    DEFAULT_RAG_SETTINGS,
    DEFAULT_INFERENCE_SETTINGS,
    [{ id: 'kb-1', name: 'BoQ', description: 'Bill of materials', customInstructions: '' }],
    [],
    false,
    (event) => events.push(event),
    new AbortController().signal
  )

  const replacement = events.find((event) => event.type === 'replace')?.content ?? ''
  assert.match(replacement, /^## Initial response \(not source-verified\)/m)
  assert.match(replacement, /Rafay provides centralized operations/)
  assert.match(replacement, /^## Verified summary/m)
  assert.match(replacement, /60 day lead time/)
})

test('marks retrieved documents as untrusted data in generation prompts', async () => {
  const calls: unknown[][] = []
  const service = serviceWithAnswer(
    [
      'The support guide lists the local support team [1]. Unsupported addition.',
      'The local support team is listed [1].'
    ],
    calls
  )

  await service.streamChat(
    'qwen3.5:4b-q4_K_M',
    [{ role: 'user', content: 'What support contact is listed?' }],
    DEFAULT_RAG_SETTINGS,
    DEFAULT_INFERENCE_SETTINGS,
    [{ id: 'kb-1', name: 'Support', description: '', customInstructions: '' }],
    [],
    false,
    () => undefined,
    new AbortController().signal
  )

  assert.ok(calls.length >= 1)
  for (const call of calls) {
    assert.match(JSON.stringify(call), new RegExp(UNTRUSTED_SOURCE_RULES.split('\n')[0]))
  }
})

test('hides sensitive values until a one-time reveal is confirmed', async () => {
  const service = serviceWithAnswer('This model answer must not be used.')
  const mutable = service as unknown as {
    retrieve: () => Promise<{
      chunks: Array<Record<string, unknown>>
      metrics: { retrievalMode: 'direct_lookup' }
    }>
  }
  mutable.retrieve = async () => ({
    chunks: [
      {
        text: 'DNS: 10.0.0.1\nAPIC 1: 10.0.0.11 (admin:Cisco.123)\nAPIC 2: 10.0.0.12 (admin:Cisco.123)',
        file: 'lab access.txt',
        path: 'lab access.txt',
        location: 'Lines 49-51',
        heading: '',
        score: 1,
        knowledgeBaseId: 'kb-1'
      }
    ],
    metrics: { retrievalMode: 'direct_lookup' }
  })
  const hidden: Array<Record<string, unknown>> = []
  await service.streamChat(
    'qwen3.5:4b-q4_K_M',
    [{ role: 'user', content: 'What are my APIC credentials and password?' }],
    DEFAULT_RAG_SETTINGS,
    DEFAULT_INFERENCE_SETTINGS,
    [{ id: 'kb-1', name: 'Lab', description: '', customInstructions: '' }],
    [],
    false,
    (event) => hidden.push(event),
    new AbortController().signal
  )
  assert.equal(
    hidden.some((event) => event.type === 'sensitive-action'),
    true
  )
  assert.doesNotMatch(JSON.stringify(hidden), /Cisco\.123/)

  const revealed: Array<Record<string, unknown>> = []
  await service.streamChat(
    'qwen3.5:4b-q4_K_M',
    [{ role: 'user', content: 'What are my APIC credentials and password?' }],
    DEFAULT_RAG_SETTINGS,
    DEFAULT_INFERENCE_SETTINGS,
    [{ id: 'kb-1', name: 'Lab', description: '', customInstructions: '' }],
    [],
    true,
    (event) => revealed.push(event),
    new AbortController().signal
  )
  assert.match(JSON.stringify(revealed), /Cisco\.123/)
  const citation = revealed.find((event) => event.type === 'citations')
  assert.doesNotMatch(JSON.stringify(citation), /Cisco\.123/)
})
