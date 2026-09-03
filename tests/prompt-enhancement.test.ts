import assert from 'node:assert/strict'
import test from 'node:test'
import {
  fallbackEnhancedPrompt,
  isPromptOnlyOutput,
  isSemanticallySafeEnhancedPrompt
} from '../src/main/lib/prompt-enhancement'

test('accepts a single query-shaped enhanced prompt', () => {
  assert.equal(
    isPromptOnlyOutput(
      'Compare the relevant options in a table, including benefits, drawbacks, costs, and key differences.'
    ),
    true
  )
})

test('rejects answer-like tables and Markdown from the prompt improver', () => {
  assert.equal(isPromptOnlyOutput('| Option | Cost |\n| --- | --- |\n| A | Lower |'), false)
  assert.equal(isPromptOnlyOutput('**Summary:** Option A has lower upfront costs.'), false)
})

test('builds a knowledge-base-grounded fallback prompt', () => {
  assert.equal(
    fallbackEnhancedPrompt('Compare the options.', [{ name: 'BoQ' }]),
    'Using the BoQ knowledge base, Compare the options. Use only relevant file content, cite supporting passages, and state clearly when the files do not contain enough information.'
  )
})

test('rejects acronym expansion and invented constraints', () => {
  assert.equal(
    isSemanticallySafeEnhancedPrompt(
      'What does the BDM say about Rafay?',
      'What does Business Development Management (BDM) say about Rafay over the next 30 days?',
      [{ name: 'TDM-BDM' }]
    ),
    false
  )
})

test('accepts a focused prompt that preserves intent and terms', () => {
  assert.equal(
    isSemanticallySafeEnhancedPrompt(
      'Compare the Rafay options and costs.',
      'Compare the Rafay options and costs using the selected files, citing each supported difference.',
      [{ name: 'BoQ' }]
    ),
    true
  )
})

test('does not repeat a knowledge-base name already present in the prompt', () => {
  assert.equal(
    fallbackEnhancedPrompt('What does TDM-BDM say about Rafay?', [{ name: 'TDM-BDM' }]),
    'What does TDM-BDM say about Rafay? Use only relevant file content, cite supporting passages, and state clearly when the files do not contain enough information.'
  )
})

test('preserves a complete constrained prompt when enhancement validation fails', () => {
  const prompt =
    'Create a practical action plan only when the selected files support one clear project or objective. Do not combine unrelated projects; otherwise ask me to choose one.'

  assert.equal(fallbackEnhancedPrompt(prompt, [{ name: 'BoQ' }]), prompt)
})

test('rejects meta prompts and unresolved placeholders', () => {
  assert.equal(
    isSemanticallySafeEnhancedPrompt(
      'Explain the relevant information simply.',
      'Analyze the knowledge base descriptions and instructions, then explain [insert original intent/topic].',
      [{ name: 'TDM-BDM' }]
    ),
    false
  )
})
