import assert from 'node:assert/strict'
import test from 'node:test'
import { groupSources } from '../src/renderer/src/lib/group-sources'

test('groups citation locations under one row per source file', (): void => {
  const groups = groupSources([
    { file: 'pricing.pdf', location: 'page 3' },
    { file: 'pricing.pdf', location: 'page 8' },
    { file: 'forecast.xlsx', location: 'Costs!B4:D8' },
    { file: 'pricing.pdf', location: 'page 3' }
  ])

  assert.deepEqual(groups, [
    {
      file: 'pricing.pdf',
      locations: [
        { location: 'page 3', indexes: [1, 4] },
        { location: 'page 8', indexes: [2] }
      ]
    },
    {
      file: 'forecast.xlsx',
      locations: [{ location: 'Costs!B4:D8', indexes: [3] }]
    }
  ])
})
