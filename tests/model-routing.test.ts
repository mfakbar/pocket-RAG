import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isTwoBModel,
  modelRouteForQuestion,
  questionNeedsBalancedModel,
  routedModel,
  shouldWarnAboutTwoBModel
} from '../src/shared/model-routing'

test('recognizes a 2B model without matching larger model names', () => {
  assert.equal(isTwoBModel('qwen3.5:2b-q4_K_M'), true)
  assert.equal(isTwoBModel('qwen3.5:4b-q4_K_M'), false)
  assert.equal(isTwoBModel('custom:12b'), false)
})

test('automatically upgrades complex work only when the stronger model is installed', () => {
  const presets = {
    balanced: 'qwen3.5:4b-q4_K_M',
    'high-quality': 'qwen3.5:9b-q4_K_M'
  }
  assert.equal(
    modelRouteForQuestion('Compare all configurations, prices, and risks.'),
    'high-quality'
  )
  assert.equal(
    routedModel(
      'qwen3.5:2b-q4_K_M',
      presets,
      ['qwen3.5:2b-q4_K_M', 'qwen3.5:4b-q4_K_M', 'qwen3.5:9b-q4_K_M'],
      'Compare all configurations, prices, and risks.'
    ),
    'qwen3.5:9b-q4_K_M'
  )
  assert.equal(
    routedModel(
      'qwen3.5:2b-q4_K_M',
      presets,
      ['qwen3.5:2b-q4_K_M'],
      'Compare all configurations, prices, and risks.'
    ),
    'qwen3.5:2b-q4_K_M'
  )
})

test('routes document-wide inventories and top-N differentiators to the high-quality model', () => {
  assert.equal(
    modelRouteForQuestion(
      'What are the software stacks in Cisco Secure AI Factory validated design?'
    ),
    'high-quality'
  )
  assert.equal(
    modelRouteForQuestion('Top 10 unique competitive differentiators of Cisco ACI'),
    'high-quality'
  )
})

test('routes complex analysis to Balanced while keeping direct work on 2B', () => {
  assert.equal(questionNeedsBalancedModel('What is the listed price for the C880?'), false)
  assert.equal(questionNeedsBalancedModel('Summarize this document briefly.'), false)
  assert.equal(questionNeedsBalancedModel('List the three provisioning steps.'), false)
  assert.equal(questionNeedsBalancedModel('Compare all configurations, costs, and risks.'), true)
  assert.equal(questionNeedsBalancedModel('Analyze architecture, operations, and benefits.'), true)
})

test('warns only when a 2B model is selected for complex work', () => {
  assert.equal(
    shouldWarnAboutTwoBModel('qwen3.5:2b-q4_K_M', 'Compare the commercial options.'),
    true
  )
  assert.equal(
    shouldWarnAboutTwoBModel('qwen3.5:4b-q4_K_M', 'Compare the commercial options.'),
    false
  )
})
