import assert from 'node:assert/strict'
import test from 'node:test'
import {
  OllamaService,
  buildDeviceModelRecommendations,
  modelRecommendation,
  parameterCountFromModelName
} from '../src/main/services/ollama-service'
import { DEFAULT_INFERENCE_SETTINGS } from '../src/shared/contracts'

test('describes installed chat models by practical hardware tier', (): void => {
  assert.match(
    modelRecommendation({ id: 'qwen3.5:4b-q4_K_M', parameterSize: '4B' }),
    /Best balance/
  )
  assert.match(modelRecommendation({ id: 'small:latest', parameterSize: '2B' }), /fast summaries/)
  assert.match(
    modelRecommendation({ id: 'quality:latest', parameterSize: '9B' }),
    /deeper analysis/
  )
  assert.match(modelRecommendation({ id: 'large:latest', parameterSize: '20B' }), /more memory/)
})

test('reads model size from Ollama model names', (): void => {
  assert.equal(parameterCountFromModelName('qwen3.5:9b-q4_K_M'), 9)
  assert.equal(parameterCountFromModelName('llama3.2:70b'), 70)
  assert.equal(parameterCountFromModelName('custom:latest'), null)
})

test('adapts suggested model tiers to detected device memory', (): void => {
  const smallerMac = buildDeviceModelRecommendations(8 * 1024 ** 3, 8, 'arm64')
  const largerMac = buildDeviceModelRecommendations(32 * 1024 ** 3, 12, 'arm64')

  assert.equal(smallerMac.performance.length, 3)
  assert.equal(
    smallerMac.highQuality.some((item) => item.model === 'gemma3:12b'),
    false
  )
  assert.equal(
    largerMac.highQuality.some((item) => item.model === 'gemma3:12b'),
    true
  )
  assert.match(largerMac.deviceSummary, /32 GB memory, 12 processor cores, and Apple silicon/)
})

test('one-shot prompt improvement honors generation settings and can unload immediately', async () => {
  const originalFetch = globalThis.fetch
  let requestBody: Record<string, unknown> = {}
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({ message: { content: 'Improved prompt' } }), {
      status: 200
    })
  }) as typeof fetch

  try {
    const service = new OllamaService('http://127.0.0.1:11434')
    await service.complete(
      'qwen3.5:2b-q4_K_M',
      [{ role: 'user', content: 'Improve this' }],
      { ...DEFAULT_INFERENCE_SETTINGS, temperature: 0.1, topP: 0.8 },
      undefined,
      0
    )
    assert.equal(requestBody.keep_alive, 0)
    assert.deepEqual(requestBody.options, {
      num_ctx: 8192,
      temperature: 0.1,
      top_p: 0.8,
      num_predict: 512
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('activating a model unloads every other resident model first', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = []
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    calls.push({
      url,
      ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {})
    })
    if (url.endsWith('/api/version')) return new Response('{}', { status: 200 })
    if (url.endsWith('/api/ps')) {
      return new Response(
        JSON.stringify({
          models: [
            { name: 'qwen3.5:4b-q4_K_M' },
            { name: 'qwen3.5:2b-q4_K_M' },
            { name: 'qwen3-embedding:0.6b' }
          ]
        }),
        { status: 200 }
      )
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch

  try {
    const service = new OllamaService('http://127.0.0.1:11434')
    await service.activateModel('qwen3.5:4b-q4_K_M', 8192)
    const generateBodies = calls
      .filter((call) => call.url.endsWith('/api/generate'))
      .map((call) => call.body)
    assert.deepEqual(generateBodies, [
      { model: 'qwen3.5:2b-q4_K_M', keep_alive: 0 },
      { model: 'qwen3-embedding:0.6b', keep_alive: 0 },
      {
        model: 'qwen3.5:4b-q4_K_M',
        stream: false,
        keep_alive: '10m',
        options: { num_ctx: 8192 }
      }
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('streams visible Ollama content without hidden thinking', async (): Promise<void> => {
  const originalFetch = globalThis.fetch
  let requestBody: Record<string, unknown> = {}
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    const stream = [
      JSON.stringify({ message: { content: 'Hello' } }),
      JSON.stringify({ message: { content: '' }, eval_count: 2, eval_duration: 1_000_000_000 })
    ].join('\n')
    return new Response(`${stream}\n`, { status: 200 })
  }) as typeof fetch

  try {
    const tokens: string[] = []
    const service = new OllamaService('http://127.0.0.1:11434')
    const metrics = await service.streamChat(
      'qwen3.5:4b-q4_K_M',
      [{ role: 'user', content: 'Hello' }],
      DEFAULT_INFERENCE_SETTINGS,
      (token) => tokens.push(token),
      new AbortController().signal
    )

    assert.equal(requestBody.think, false)
    assert.deepEqual(tokens, ['Hello'])
    assert.equal(metrics.completionTokens, 2)
    assert.equal(metrics.tokensPerSecond, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('continues once when Ollama reaches the output limit', async (): Promise<void> => {
  const originalFetch = globalThis.fetch
  const requestBodies: Array<Record<string, unknown>> = []
  let call = 0
  globalThis.fetch = (async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    call += 1
    const stream =
      call === 1
        ? [
            JSON.stringify({ message: { content: 'First part.' } }),
            JSON.stringify({
              message: { content: '' },
              done_reason: 'length',
              eval_count: 2,
              eval_duration: 1_000_000_000
            })
          ].join('\n')
        : [
            JSON.stringify({ message: { content: '#### Second section' } }),
            JSON.stringify({
              message: { content: '' },
              done_reason: 'stop',
              eval_count: 2,
              eval_duration: 1_000_000_000
            })
          ].join('\n')
    return new Response(`${stream}\n`, { status: 200 })
  }) as typeof fetch

  try {
    const tokens: string[] = []
    const service = new OllamaService('http://127.0.0.1:11434')
    const metrics = await service.streamChat(
      'qwen3.5:4b-q4_K_M',
      [{ role: 'user', content: 'Compare the options' }],
      DEFAULT_INFERENCE_SETTINGS,
      (token) => tokens.push(token),
      new AbortController().signal
    )

    assert.deepEqual(tokens, ['First part.', '\n\n#### Second section'])
    assert.equal(requestBodies.length, 2)
    assert.equal(metrics.completionTokens, 4)
    assert.equal(metrics.tokensPerSecond, 2)
    const continuedMessages = requestBodies[1].messages as Array<{ role: string; content: string }>
    assert.match(continuedMessages.at(-1)?.content ?? '', /Continue exactly where/)
    assert.match(continuedMessages.at(-1)?.content ?? '', /Never write.*Continued/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
