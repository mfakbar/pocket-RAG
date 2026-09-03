import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GENERATION_INPUTS,
  getRagExplainerStage,
  RAG_EXPLAINER_STAGES,
  RAG_JOURNEY_RELATIONS,
  ragStageJourneyLabel,
  relatedStageIds,
  relationsForStage,
  stagesForPhase,
  type RagStageId
} from '../src/renderer/src/lib/rag-explainer-content'

test('covers the end-to-end ingestion and question journeys in order', () => {
  const prepare = stagesForPhase('prepare')
  const answer = stagesForPhase('answer')

  assert.deepEqual(
    prepare.map((stage) => stage.number),
    [1, 2, 3, 4, 5]
  )
  assert.deepEqual(
    answer.map((stage) => stage.number),
    [1, 2, 3, 4, 5, 6, 7]
  )
  assert.deepEqual(
    prepare.map((stage) => stage.id),
    ['local-folder', 'extract', 'chunk', 'document-embedding', 'vector-database']
  )
  assert.deepEqual(
    answer.map((stage) => stage.id),
    [
      'user-prompt',
      'query-embedding',
      'hybrid-search',
      'reranker',
      'grounded-context',
      'output-tokens',
      'verify-citations'
    ]
  )
})

test('gives every explorable stage an input, output and teaching takeaway', () => {
  assert.equal(new Set(RAG_EXPLAINER_STAGES.map((stage) => stage.id)).size, 12)

  for (const stage of RAG_EXPLAINER_STAGES) {
    assert.ok(stage.title.length > 0, `${stage.id} should have a title`)
    assert.ok(stage.detail.length > 0, `${stage.id} should explain what happens`)
    assert.ok(stage.inputLabel.length > 0, `${stage.id} should explain its input`)
    assert.ok(stage.outputLabel.length > 0, `${stage.id} should explain its output`)
    assert.ok(stage.keyIdea.length > 0, `${stage.id} should have a key idea`)
  }
})

test('labels every selected process with its journey, step number and name', () => {
  assert.equal(
    ragStageJourneyLabel(getRagExplainerStage('extract')),
    'Journey 1 · Step 2 · Read files'
  )
  assert.equal(
    ragStageJourneyLabel(getRagExplainerStage('output-tokens')),
    'Journey 2 · Step 6 · Generate'
  )
})

test('marks reranking as optional and keeps key customer-demo concepts discoverable', () => {
  assert.equal(getRagExplainerStage('reranker').optional, true)

  const requiredStages: RagStageId[] = [
    'chunk',
    'document-embedding',
    'vector-database',
    'user-prompt',
    'hybrid-search',
    'reranker',
    'grounded-context',
    'output-tokens',
    'verify-citations'
  ]
  for (const id of requiredStages) {
    assert.equal(getRagExplainerStage(id).id, id)
  }
})

test('distinguishes prepared evidence from app-created answer rules', () => {
  const prepareEvidence = getRagExplainerStage('grounded-context')
  const generate = getRagExplainerStage('output-tokens')
  const inputSources = Object.fromEntries(
    GENERATION_INPUTS.map((input) => [input.id, input.source])
  )

  assert.equal(prepareEvidence.shortTitle, 'Prepare evidence')
  assert.match(prepareEvidence.outputLabel, /^Grounded evidence:/)
  assert.match(prepareEvidence.keyIdea, /separately provides rules/i)
  assert.equal(generate.inputLabel, 'Answer rules, user context and grounded evidence')
  assert.deepEqual(inputSources, {
    'answer-rules': 'Created by RavnDock',
    'user-context': 'Output of Question',
    'grounded-evidence': 'Output of Prepare evidence'
  })
})

test('maps the true dependencies between the preparation and question journeys', () => {
  assert.deepEqual(
    RAG_JOURNEY_RELATIONS.map((relation) => ({
      id: relation.id,
      from: relation.fromStageIds,
      to: relation.toStageIds
    })),
    [
      {
        id: 'embedding-space',
        from: ['document-embedding'],
        to: ['query-embedding']
      },
      {
        id: 'search-index',
        from: ['vector-database'],
        to: ['hybrid-search']
      },
      {
        id: 'source-provenance',
        from: ['extract', 'chunk'],
        to: ['grounded-context', 'verify-citations']
      }
    ]
  )

  assert.deepEqual(relatedStageIds('vector-database'), ['hybrid-search'])
  assert.deepEqual(relatedStageIds('document-embedding'), ['query-embedding'])
  assert.deepEqual(relatedStageIds('grounded-context'), ['extract', 'chunk', 'verify-citations'])
  assert.deepEqual(
    relationsForStage('verify-citations').map((relation) => relation.id),
    ['source-provenance']
  )
  assert.deepEqual(relationsForStage('reranker'), [])
})
