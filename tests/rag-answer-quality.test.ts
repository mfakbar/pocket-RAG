import assert from 'node:assert/strict'
import test from 'node:test'
import {
  attachSupportedCitations,
  buildGroundedFallback,
  collapseConsecutiveCitations,
  composeCheckedAnswer,
  groundedAnswerIssues,
  redactSensitiveFields,
  removeInvalidCitationMarkers,
  sanitizeGroundedAnswer,
  verifiedGroundedDraft
} from '../src/main/lib/rag-answer-quality'

test('keeps the complete initial answer before a concise verified summary', () => {
  const initial =
    '## Deployment comparison\n\n| Configuration | Lead time |\n| --- | --- |\n| C880 | 60 days [1] |'
  const summary = 'The C880 configuration has a 60 day lead time [1].'
  const answer = composeCheckedAnswer(initial, summary)

  assert.match(answer, /^## Initial response \(not source-verified\)/m)
  assert.match(answer, /original generated response/)
  assert.match(answer, /^## Deployment comparison/m)
  assert.match(answer, /\| C880 \| 60 days \[1\] \|/)
  assert.match(answer, /^## Verified summary/m)
  assert.ok(
    answer.indexOf('## Initial response (not source-verified)') <
      answer.indexOf('## Verified summary')
  )
})

test('does not duplicate an unchanged checked answer', () => {
  const answer = 'The C880 configuration has a 60 day lead time [1].'
  assert.equal(composeCheckedAnswer(answer, answer), answer)
})

test('keeps one citation at the end of consecutive statements from the same source', () => {
  const answer =
    'The platform supports content generation [2]. It also supports virtual agents [2]. Detection features include forecasts [2].'
  assert.equal(
    collapseConsecutiveCitations(answer),
    'The platform supports content generation. It also supports virtual agents. Detection features include forecasts [2].'
  )
})

test('retains citations when the supporting source changes', () => {
  const answer =
    'The platform supports content generation [1]. It also supports virtual agents [2].'
  assert.equal(collapseConsecutiveCitations(answer), answer)
})

test('accepts complete grounded paragraphs with valid citations', () => {
  assert.deepEqual(
    groundedAnswerIssues('The control plane uses three nodes for high availability [1].', [
      'The design includes three control plane nodes to provide high availability.'
    ]),
    []
  )
})

test('allows a clearly labelled interpretation only when the user explicitly requested it', () => {
  const answer =
    '## From your files\n\nThe poem describes an empty room at night [1].\n\n' +
    '## Model interpretation (not from your files)\n\nI read the empty room as a metaphor for isolation.'
  const sources = ['The poem describes an empty room at night.']
  assert.deepEqual(
    groundedAnswerIssues(answer, sources, 'What do you think?', {
      allowInterpretation: true
    }),
    []
  )
  assert.ok(
    groundedAnswerIssues(answer, sources, 'What does it state?').includes(
      'uncited factual paragraph'
    )
  )
})

test('accepts a derived spreadsheet value when exact operands and method are verified', () => {
  assert.deepEqual(
    groundedAnswerIssues(
      'The calculated total is $23,496 using quantity multiplied by unit price [1].',
      ['The row lists quantity 3 and unit price $7,832.'],
      'What is the total?',
      {
        derivedEvidence:
          'Method: quantity multiplied by unit price. quantity=3; unit price=$7,832; Derived total: $23,496'
      }
    ),
    []
  )
})

test('flags invalid citations, malformed tables, and incomplete endings', () => {
  const issues = groundedAnswerIssues(
    '| Option | Cost |\n| --- | --- |\n| A | Lower | Extra |\n\nThe selected option has a lower cost [2]:',
    ['Option A has a lower cost.']
  )
  assert.ok(issues.includes('malformed Markdown table'))
  assert.ok(issues.includes('invalid citation number'))
  assert.ok(issues.includes('incomplete ending'))
})

test('flags factual paragraphs without citations', () => {
  assert.ok(
    groundedAnswerIssues(
      'The platform includes redundant controllers and supports automated failover for production workloads.',
      ['The platform includes redundant controllers.']
    ).includes('missing citations')
  )
})

test('flags acronym expansions that do not appear in sources', () => {
  assert.ok(
    groundedAnswerIssues('The Business Development Model (BDM) defines the service strategy [1].', [
      'The Cisco-Rafay BDM presentation defines the service strategy.'
    ]).includes('unsupported acronym expansion')
  )
})

test('accepts source-defined acronyms and uncited lead-in labels', () => {
  assert.deepEqual(
    groundedAnswerIssues(
      'Based on the provided local sources, here is the answer:\n\nNutanix Unified Storage (NUS) provides file services [1].',
      ['Nutanix Unified Storage (NUS) provides file services.']
    ),
    []
  )
})

test('accepts a cited statement that requested details are absent', () => {
  assert.deepEqual(
    groundedAnswerIssues(
      'The retrieved passages do not specify implementation deadlines or named owners [1].',
      ['The source lists architecture components and general capabilities.']
    ),
    []
  )
})

test('flags repeated passages and headings without rejecting reusable field labels', () => {
  const repeated =
    'The platform provides lifecycle management for local infrastructure and connected support across multiple deployment environments [1]. '
  assert.ok(groundedAnswerIssues(`${repeated}${repeated}`, [repeated]).includes('repeated content'))
  assert.ok(
    groundedAnswerIssues(
      '## Configuration\n\nFirst option details [1].\n\n## Configuration\n\nSecond option details [1].',
      ['First and second option configuration details.']
    ).includes('repeated content')
  )
  assert.ok(
    !groundedAnswerIssues(
      '* **Configuration**: First option details [1].\n\n* **Configuration**: Second option details [1].',
      ['First and second option configuration details.']
    ).includes('repeated content')
  )
})

test('flags an answer that ends on a connector', () => {
  assert.ok(
    groundedAnswerIssues(
      'The modular design supports future expansion by allowing the customer to',
      ['The modular design supports future expansion.']
    ).includes('incomplete ending')
  )
})

test('requires citations on separate factual bullets', () => {
  assert.ok(
    groundedAnswerIssues(
      '* The first configuration includes redundant controllers for availability [1].\n' +
        '* The second configuration includes additional storage for production workloads.',
      ['The first configuration includes redundant controllers for availability.']
    ).includes('uncited factual paragraph')
  )
})

test('removes unsupported acronym expansions without changing source-defined ones', () => {
  assert.equal(
    sanitizeGroundedAnswer(
      'The Business Development Model (BDM) uses Nutanix Unified Storage (NUS) [1].',
      ['Nutanix Unified Storage (NUS) is included in the BDM solution.']
    ),
    'The BDM uses Nutanix Unified Storage (NUS) [1].'
  )
})

test('removes unsupported explanations placed after an acronym', () => {
  assert.equal(
    sanitizeGroundedAnswer('The stack includes NIM (Inference Microservices) [1].', [
      'The AI software includes NeMo, NIM, and Blueprints.'
    ]),
    'The stack includes NIM [1].'
  )
  assert.ok(
    groundedAnswerIssues('The stack includes NIM (Inference Microservices) [1].', [
      'The AI software includes NeMo, NIM, and Blueprints.'
    ]).includes('unsupported acronym expansion')
  )
})

test('removes repeated generated sentences before quality validation', () => {
  const sentence =
    'The platform provides lifecycle management for local infrastructure and connected support across multiple deployment environments [1].'
  const sanitized = sanitizeGroundedAnswer(
    `${sentence}\n\n${sentence}\n\nA separate supported conclusion remains [1].`,
    [sentence]
  )
  assert.equal(sanitized, `${sentence}\n\nA separate supported conclusion remains [1].`)
  assert.ok(!groundedAnswerIssues(sanitized, [sentence]).includes('repeated content'))
})

test('preserves a valid, cited Markdown table', () => {
  const table = '| Configuration | Lead time |\n| --- | --- |\n| C880 | 60 days [1] |'
  const sanitized = sanitizeGroundedAnswer(table, [
    'The C880 configuration has a 60 day lead time.'
  ])
  assert.equal(sanitized, table)
  assert.deepEqual(
    groundedAnswerIssues(sanitized, ['The C880 configuration has a 60 day lead time.']),
    []
  )
})

test('adds a missing table-row citation inside the final cell', () => {
  assert.equal(
    attachSupportedCitations(
      '| Configuration | Lead time |\n| --- | --- |\n| C880 | 60 day lead time |',
      ['The C880 configuration has a 60 day lead time.']
    ),
    '| Configuration | Lead time |\n| --- | --- |\n| C880 | 60 day lead time [1] |'
  )
})

test('retains a verified table when another paragraph is unsupported', () => {
  const table = '| Configuration | Lead time |\n| --- | --- |\n| C880 | 60 days [1] |'
  const draft = verifiedGroundedDraft(`${table}\n\nThe unsupported price is $999 USD [1].`, [
    'The C880 configuration has a 60 day lead time.'
  ])
  assert.equal(draft, table)
})

test('retains supported table rows when another row is unsupported', () => {
  const table =
    '| Configuration | Lead time |\n| --- | --- |\n| C880 | 60 days [1] |\n| C845 | 999 days [1] |'
  const draft = verifiedGroundedDraft(table, ['The C880 configuration has a 60 day lead time.'])
  assert.match(draft, /C880.*60 days/)
  assert.doesNotMatch(draft, /C845|999/)
})

test('removes out-of-range citations and preserves valid comma-separated references', () => {
  assert.equal(
    removeInvalidCitationMarkers('Supported [1, 4]. Invalid [9].', 4),
    'Supported [1, 4]. Invalid .'
  )
  assert.deepEqual(groundedAnswerIssues('Combined fact [1, 2].', ['Combined', 'fact']), [])
})

test('accepts questions and bullets covered by a cited list introduction', () => {
  assert.deepEqual(
    groundedAnswerIssues(
      'The source lists three capabilities [1]:\n' +
        '* Automated configuration for local infrastructure.\n' +
        '* Connected support across deployment environments.\n\n' +
        '* What should the team review before deployment?',
      ['The capabilities include automated configuration and connected support.']
    ),
    []
  )
})

test('adds a citation only when an uncited line strongly matches a source passage', () => {
  assert.equal(
    attachSupportedCitations(
      '* Automated configuration provides lifecycle management and connected support for local infrastructure.',
      ['Automated configuration provides full-stack lifecycle management and connected support.']
    ),
    '* Automated configuration provides lifecycle management and connected support for local infrastructure. [1]'
  )
  assert.equal(
    attachSupportedCitations('* The customer should replace every server before deployment.', [
      'Automated configuration provides full-stack lifecycle management and connected support.'
    ]),
    '* The customer should replace every server before deployment.'
  )
})

test('adds citations at the same support threshold used by validation', () => {
  assert.equal(
    attachSupportedCitations(
      'The local platform includes lifecycle controls and a documented deployment process.',
      ['The platform includes lifecycle controls for infrastructure deployment.']
    ),
    'The local platform includes lifecycle controls and a documented deployment process. [1]'
  )
})

test('builds a citation-safe fallback when generated synthesis cannot be verified', () => {
  const sources = [
    {
      file: 'architecture.pptx',
      location: 'Slide 4',
      text: 'The platform includes lifecycle controls for infrastructure deployment.'
    },
    {
      file: 'architecture.pptx',
      location: 'Slide 7',
      text: 'The source identifies deployment complexity as an implementation risk.'
    }
  ]
  const fallback = buildGroundedFallback(sources)
  assert.match(fallback, /I could not verify a complete answer/)
  assert.match(fallback, /architecture\.pptx.*Slide 4 \[1\]/)
  assert.doesNotMatch(fallback, /lifecycle controls|deployment complexity/)
})

test('never exposes source contents in the fallback', () => {
  const fallback = buildGroundedFallback([
    {
      file: 'switch-notes.txt',
      location: 'Lines 1-3',
      text: 'login: example-user\npassword: example-sensitive-value\napi_key = example-api-value'
    }
  ])

  assert.match(fallback, /switch-notes\.txt.*Lines 1-3 \[1\]/)
  assert.doesNotMatch(fallback, /login|password|api.key|example-sensitive-value|example-api-value/i)
})

test('flags numeric values that do not exactly match their cited source', () => {
  const issues = groundedAnswerIssues(
    'The design uses a 20 Gbps port channel for connectivity [1].',
    ['The design uses a 2016-Gbps port channel for connectivity.']
  )
  assert.ok(issues.includes('unsupported numeric claim: 20 Gbps'))
})

test('accepts exact ranges, units, and formatted currency from cited sources', () => {
  assert.deepEqual(
    groundedAnswerIssues(
      'The rack target is 20 kW, with an estimated price of $188,360.16 USD [1].',
      ['The rack target is 20 kW and the estimated price is $188360.16.']
    ),
    []
  )
})

test('ignores citation numbers and numbered-list markers during numeric validation', () => {
  assert.deepEqual(
    groundedAnswerIssues(
      '1. The platform provides connected support across deployment environments [1].',
      ['The platform provides connected support across deployment environments.']
    ),
    []
  )
})

test('validates an IP address as one exact value and does not read following words as units', () => {
  assert.deepEqual(
    groundedAnswerIssues('Use 10.3.11.1/24 with the documented tenant workflow [1].', [
      'Use 10.3.11.1/24 with the documented tenant workflow.'
    ]),
    []
  )
  assert.deepEqual(
    groundedAnswerIssues('The source lists 25 access policies for the tenant workflow [1].', [
      'The source lists 25 access policies for the tenant workflow.'
    ]),
    []
  )
})

test('accepts harmless spreadsheet number formatting and ignores numbers inside product names', () => {
  assert.deepEqual(
    groundedAnswerIssues('The listed price is $0.00 USD for App2a on the C9300 platform [1].', [
      'The Price Estimate row lists 0.0 for App2a on the C9300 platform.'
    ]),
    []
  )
  assert.deepEqual(
    groundedAnswerIssues('The rack supports 100kW [1].', ['Rack capacities up to 100kW.']),
    []
  )
})

test('checks numeric claims against the cited passage rather than any retrieved passage', () => {
  const issues = groundedAnswerIssues('The configuration costs $200 USD [1].', [
    'The first configuration costs $100 USD.',
    'The second configuration costs $200 USD.'
  ])
  assert.ok(issues.includes('unsupported numeric claim: $200 USD'))
})

test('keeps a numeric value attached to the correct entity on the same source row', () => {
  const sources = ['| Model | Lead Time |\n| --- | --- |\n| C880 | 60 days |\n| B300 | 14 days |']
  assert.deepEqual(groundedAnswerIssues('C880 has a 60 day lead time [1].', sources), [])
  assert.ok(
    groundedAnswerIssues('B300 has a 60 day lead time [1].', sources).includes(
      'unsupported numeric claim: 60 day'
    )
  )
})

test('requires every explicitly requested answer category', () => {
  const issues = groundedAnswerIssues(
    'The configuration quantity is 2 units [1].',
    ['The configuration quantity is 2 units and the lead time is 30 days.'],
    'List the configuration, quantity, and lead time.'
  )
  assert.ok(issues.includes('missing requested category: lead time'))
})

test('redacts credential-like fields before display', () => {
  const redacted = redactSensitiveFields(
    'Username: admin\nPassword: local-secret\nAPI key = abc123\nAPIC (admin:Cisco.123)'
  )
  assert.match(redacted, /Password: \[REDACTED\]/)
  assert.match(redacted, /API key = \[REDACTED\]/i)
  assert.doesNotMatch(redacted, /local-secret|abc123/)
  assert.match(redacted, /admin:\[REDACTED\]/)
  assert.doesNotMatch(redacted, /Cisco\.123/)
})

test('keeps supported blocks for targeted repair and removes unsupported blocks', () => {
  const draft = verifiedGroundedDraft(
    'The platform includes connected support for local infrastructure [1].\n\n' +
      'The customer will save $500,000 immediately [1].',
    ['The platform includes connected support for local infrastructure.']
  )
  assert.match(draft, /connected support/)
  assert.doesNotMatch(draft, /500,000/)
})
