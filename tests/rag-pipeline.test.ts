import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChatMessage, InferenceSettings } from '../src/shared/contracts'
import {
  adaptiveInference,
  anticipatedRetrievalMode,
  buildBenefitOutcomeAnswer,
  buildDiagramFlowAnswer,
  buildEvidenceListAnswer,
  buildExtractiveAnswer,
  buildSoftwareStackAnswer,
  buildSpreadsheetLabeledFacts,
  buildSpreadsheetSizingAnswer,
  conversationAwareQuestion,
  decomposeQuestion,
  evidenceCoverage,
  explicitlyRequestsInterpretation,
  focusEvidenceByHeading,
  isFileInventoryQuestion,
  narrowDirectLookupEvidence,
  packEvidence,
  placeStrongEvidenceAtEdges,
  retrievalConfidence,
  requestsSensitiveValue,
  resolveConversationQuestion,
  structuredSpreadsheetEvidence,
  structuredSpreadsheetAnswer,
  type EvidenceChunk,
  type StructuredRow
} from '../src/main/lib/rag-pipeline'

const inference: InferenceSettings = {
  contextLength: 8192,
  temperature: 0.2,
  topP: 0.9,
  maxOutputTokens: 1024
}

function chunk(overrides: Partial<EvidenceChunk> = {}): EvidenceChunk {
  return {
    text: 'The H200 GPU has a Unit Price of $7,832.',
    file: 'pricing.xlsx',
    path: 'pricing.xlsx',
    location: 'Sheet Price Estimate, A1:C3',
    heading: '',
    score: 0.5,
    ...overrides
  }
}

function typedRow(
  sheet: string,
  rowIndex: number,
  values: Array<[column: string, value: string, numericValue?: number | null]>,
  file = 'pricing.xlsx'
): StructuredRow {
  return {
    knowledgeBaseId: 'kb',
    documentId: 'doc',
    path: file,
    file,
    sheet,
    rowIndex,
    score: 1,
    cells: values.map(([column, value, numeric = null], index) => ({
      columnIndex: index + 1,
      column,
      address: `${String.fromCharCode(65 + index)}${rowIndex}`,
      value,
      rawValue: value,
      valueType: numeric == null ? 's' : 'n',
      numericValue: numeric,
      unit: '',
      formula: ''
    }))
  }
}

test('rewrites short follow-up questions with recent conversation context', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'What is the H200 configuration?' },
    { role: 'assistant', content: 'The selected configuration uses H200 GPUs.' },
    { role: 'user', content: 'How about its price?' }
  ]
  const query = conversationAwareQuestion(messages)
  assert.match(query, /Previous question: What is the H200 configuration/)
  assert.match(query, /Follow-up question: How about its price/)
})

test('an explicit filename overrides earlier conversation source context', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'Compare the available spreadsheets.' },
    { role: 'assistant', content: 'I found values in old.xlsx and unrelated.xlsx.' },
    { role: 'user', content: 'What is the unit price in "target.xlsx"?' }
  ]
  assert.equal(conversationAwareQuestion(messages), 'What is the unit price in "target.xlsx"?')
})

test('does not treat a short new topic as a follow-up', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'Summarize the deployment risks.' },
    { role: 'assistant', content: '- Network risk\n- Storage risk' },
    { role: 'user', content: 'How do I cook pasta?' }
  ]
  assert.equal(conversationAwareQuestion(messages), 'How do I cook pasta?')
})

test('resolves ordinal follow-ups from the previous answer outline', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'Summarize the main risks.' },
    {
      role: 'assistant',
      content: `${'Introductory context. '.repeat(40)}\n- Network availability\n- Storage capacity\n- Support coverage`
    },
    { role: 'user', content: 'What about the second bullet point?' }
  ]
  const resolution = resolveConversationQuestion(messages)
  assert.equal(resolution.clarification, null)
  assert.match(resolution.question, /Referenced item: - Storage capacity/)
})

test('asks for clarification when an ordinal reference is unavailable', () => {
  const resolution = resolveConversationQuestion([
    { role: 'user', content: 'What is the lead time?' },
    { role: 'assistant', content: 'The source gives one lead time.' },
    { role: 'user', content: 'Explain the fourth point.' }
  ])
  assert.match(resolution.clarification ?? '', /Which point do you mean/)
})

test('uses 16K only for broad synthesis and aggregate spreadsheet work', () => {
  assert.equal(
    adaptiveInference(inference, 'direct_lookup', 'What is the unit price?').contextLength,
    8192
  )
  assert.equal(
    adaptiveInference(inference, 'spreadsheet_comparison', 'Compare every configuration.')
      .contextLength,
    16384
  )
  assert.equal(
    adaptiveInference(inference, 'document_summary', 'Summarize the document.').contextLength,
    16384
  )
})

test('confidence accepts exact files and rejects unrelated low-score passages', () => {
  assert.equal(retrievalConfidence('What is in pricing.xlsx?', [chunk()]).level, 'high')
  assert.equal(retrievalConfidence('Explain lunar geology.', [chunk({ score: 0.01 })]).level, 'low')
})

test('computes a verified maximum from exact spreadsheet values', () => {
  const table = [
    '| Item | Lead Time |',
    '| --- | --- |',
    '| H200 | 14 days |',
    '| B300 | 60 days |'
  ].join('\n')
  const result = structuredSpreadsheetEvidence('Which item has the longest lead time?', [
    chunk({ text: table })
  ])
  assert.match(result, /Maximum selected/)
  assert.match(result, /Item=B300; Lead Time=60 days/)
  assert.doesNotMatch(result, /Item=H200/)
})

test('uses typed spreadsheet rows before rendered Markdown', () => {
  const rows: StructuredRow[] = [
    {
      knowledgeBaseId: 'kb',
      documentId: 'doc',
      path: 'pricing.xlsx',
      file: 'pricing.xlsx',
      sheet: 'Options',
      rowIndex: 2,
      score: 2,
      cells: [
        {
          columnIndex: 1,
          column: 'Item',
          address: 'A2',
          value: 'H200',
          rawValue: 'H200',
          valueType: 's',
          numericValue: null,
          unit: '',
          formula: ''
        },
        {
          columnIndex: 2,
          column: 'Lead Time',
          address: 'B2',
          value: '60 days',
          rawValue: '60 days',
          valueType: 's',
          numericValue: 60,
          unit: 'days',
          formula: ''
        }
      ]
    }
  ]
  const result = structuredSpreadsheetEvidence('Which item has the longest lead time?', [], rows)
  assert.match(result, /VERIFIED TYPED SPREADSHEET RESULT/)
  assert.match(result, /Item=H200/)
  assert.match(result, /Lead Time=60 days/)
})

test('adds quantities across every row for an exact repeated part number', () => {
  const rows = [
    typedRow('BoQ', 9, [
      ['Product', 'C-NVM-7. 68TB-AB1A-CM'],
      ['Qty', '4', 4]
    ]),
    typedRow('BoQ', 17, [
      ['Product', 'C-NVM-7. 68TB-AB1A-CM'],
      ['Qty', '18', 18]
    ])
  ]
  const result = structuredSpreadsheetEvidence(
    'What is the combined Qty for C-NVM-7. 68TB-AB1A-CM?',
    [],
    rows
  )
  assert.match(result, /Derived combined quantity: 22/)
  assert.match(result, /row 9/)
  assert.match(result, /row 17/)
})

test('keeps every tied maximum row instead of returning only the first', () => {
  const rows = [
    typedRow('Price Estimate', 49, [
      ['Line Number', '1.1.26'],
      ['Part Number', 'UCSC-GPU-H200-NVL'],
      ['Unit List Price', '139166.06', 139166.06]
    ]),
    typedRow('Price Estimate', 50, [
      ['Line Number', '1.1.27'],
      ['Part Number', 'UCSC-GPU-H200-NVL'],
      ['Unit List Price', '139166.06', 139166.06]
    ]),
    typedRow('Price Estimate', 44, [
      ['Line Number', '1.1.21'],
      ['Part Number', 'MEMORY'],
      ['Unit List Price', '43162.03', 43162.03],
      ['Extended Net Price', '690592.48', 690592.48]
    ]),
    typedRow('Price Estimate', 48, [
      ['Line Number', '1.1.25'],
      ['Part Number', 'NIC'],
      ['Unit List Price', '4750', 4750]
    ])
  ]
  const result = structuredSpreadsheetEvidence(
    'Identify every line item tied for the highest Unit List Price.',
    [],
    rows
  )
  assert.match(result, /1\.1\.26/)
  assert.match(result, /1\.1\.27/)
  assert.doesNotMatch(result, /1\.1\.25/)
  assert.doesNotMatch(result, /1\.1\.21/)
})

test('applies multiple typed numeric filters and excludes nonnumeric lead times', () => {
  const rows = [
    typedRow('Leaf', 11, [
      ['Part Number', 'N9K-C93600CD-GX'],
      ['Estimated Lead Time (Days)', '49', 49],
      ['Qty', '2', 2],
      ['Unit Net Price', '57725.72', 57725.72]
    ]),
    typedRow('Leaf', 12, [
      ['Part Number', 'SUPPORT'],
      ['Estimated Lead Time (Days)', 'N/A'],
      ['Qty', '2', 2],
      ['Unit Net Price', '23840', 23840]
    ]),
    typedRow('Leaf', 28, [
      ['Part Number', 'QSFP-100G-SR1.2='],
      ['Estimated Lead Time (Days)', '182', 182],
      ['Qty', '8', 8],
      ['Unit Net Price', '2062.83', 2062.83]
    ])
  ]
  const result = structuredSpreadsheetEvidence(
    'List items with Estimated Lead Time of at least 40 days, Qty of at least 2, and Unit Net Price above USD 2,000. Exclude N/A and sort longest first.',
    [],
    rows
  )
  assert.ok(result.indexOf('QSFP-100G-SR1.2=') < result.indexOf('N9K-C93600CD-GX'))
  assert.doesNotMatch(result, /SUPPORT/)

  const answer = structuredSpreadsheetAnswer(
    'List items with Estimated Lead Time of at least 40 days, Qty of at least 2, and Unit Net Price above USD 2,000. Exclude N/A and sort longest first.',
    [
      chunk({
        file: 'pricing.xlsx',
        location: 'Sheet Leaf, A10:D30',
        text: 'typed rows'
      })
    ],
    rows
  )
  assert.match(answer, /QSFP-100G-SR1\.2=.*\[1\]/)
  assert.doesNotMatch(answer, /SUPPORT/)
  assert.doesNotMatch(answer, /Use only the rows above/)
})

test('aggregates one label-value total per sheet and selects the highest scenario', () => {
  const rows = [
    typedRow('S16', 25, [
      ['Metric', 'Total GPUs'],
      ['Value', '14', 14]
    ]),
    typedRow('S17', 23, [
      ['Parameter', 'Total GPUs'],
      ['Low', '5', 5],
      ['High', '5', 5]
    ]),
    typedRow('S18', 23, [
      ['Parameter', 'Total GPUs'],
      ['Low', '2', 2],
      ['High', '2', 2]
    ]),
    typedRow('S19', 20, [
      ['Parameter', 'Total GPUs'],
      ['Low', '5', 5],
      ['High', '5', 5]
    ]),
    typedRow('S18', 21, [
      ['Parameter', 'HBM occupancy'],
      ['Low', '0.6545885721067812', 0.6545885721067812],
      ['High', '0.7620391706268562', 0.7620391706268562]
    ])
  ]
  const result = structuredSpreadsheetEvidence(
    'Sum Total GPUs across sheets, counting one per sheet, then identify the highest HBM occupancy.',
    [],
    rows
  )
  assert.match(result, /Derived Total GPUs across sheets: 26/)
  assert.match(result, /Sheet S18.*scenario High=0\.7620391706268562/)
})

test('joins BOQ quantities to explicit per-server memory totals', () => {
  const rows = [
    typedRow('BOQ', 4, [
      ['Komponen', 'Server App 1a'],
      ['Quantity', '8', 8]
    ]),
    typedRow('BOQ', 5, [
      ['Komponen', 'Server App2a'],
      ['Quantity', '8', 8]
    ]),
    typedRow('App1a Server Requirement', 8, [
      ['Komponen', 'Memory'],
      ['Spesifikasi', '4 × 16 GB DDR5 = 64 GB total']
    ]),
    typedRow('App2a Server Requirement', 8, [
      ['Komponen', 'Memory'],
      ['Spesifikasi', '8 × 32 GB DDR5 = 256 GB total']
    ])
  ]
  const result = structuredSpreadsheetEvidence(
    'Combine the BOQ quantities with the Memory rows. What is the total installed memory?',
    [],
    rows
  )
  assert.match(result, /8.*64 GB.*512 GB/)
  assert.match(result, /8.*256 GB.*2048 GB/)
  assert.match(result, /Derived total installed memory: 2,560 GB/)

  const answer = structuredSpreadsheetAnswer(
    'Combine the BOQ quantities with the Memory rows. What is the total installed memory?',
    [
      chunk({ location: 'Sheet BOQ, A1:B10', text: 'BOQ quantities' }),
      chunk({ location: 'Sheet App1a Server Requirement, A1:B10', text: 'Memory requirements' }),
      chunk({ location: 'Sheet App2a Server Requirement, A1:B10', text: 'Memory requirements' })
    ],
    rows
  )
  assert.match(answer, /App1a Server Requirement.*\[2\] \[1\]/)
  assert.match(answer, /App2a Server Requirement.*\[3\] \[1\]/)
})

test('maps Product Total labels to adjacent values and derives the spread', () => {
  const rows = [
    typedRow('A', 77, [
      ['Extended Net Price', 'Product Total'],
      ['Bundle Discount', '3351191.93', 3351191.93]
    ]),
    typedRow('B', 57, [
      ['Extended Net Price', 'Product Total'],
      ['Bundle Discount', '3074946.94', 3074946.94]
    ]),
    typedRow('C', 47, [
      ['Extended Net Price', 'Product Total'],
      ['Bundle Discount', '4422457.37', 4422457.37]
    ])
  ]
  const result = structuredSpreadsheetEvidence(
    'Compare the Product Total, order lowest to highest, and calculate the difference.',
    [],
    rows
  )
  assert.ok(result.indexOf('Sheet B') < result.indexOf('Sheet A'))
  assert.ok(result.indexOf('Sheet A') < result.indexOf('Sheet C'))
  assert.match(result, /Derived highest-minus-lowest difference: 1,347,510\.43/)
})

test('preserves a complete labelled comparison row with composite subheaders', () => {
  const rows = [
    typedRow('Rackmount 64core 512GB', 7, [
      ['Kategory', 'Internal Hardisk'],
      ['Minimum Requirement', 'SSD Drive with 500GB minimum usable, RAID1'],
      ['CISCO > UCS C220 M7', 'SSD Drive with 960GB minimum usable, RAID1']
    ])
  ]
  const result = structuredSpreadsheetEvidence(
    'Compare the Internal Hardisk Minimum Requirement with the CISCO proposal and include the server model.',
    [],
    rows
  )
  assert.match(result, /Minimum Requirement=SSD Drive with 500GB/)
  assert.match(result, /CISCO > UCS C220 M7=SSD Drive with 960GB/)
})

test('does not recompute prices when the user asks for stated totals', () => {
  const table = [
    '| Item | Qty | Unit Price | Total |',
    '| --- | --- | --- | --- |',
    '| Server | 3 | 100 | 250 |'
  ].join('\n')
  const result = structuredSpreadsheetEvidence('Report the stated product and total prices.', [
    chunk({ text: table })
  ])
  assert.doesNotMatch(result, /Derived total|Multiplied each/)
})

test('decomposes complex questions and checks evidence coverage before generation', () => {
  const question = 'Compare configurations, lead times, prices, and risks.'
  const mode = anticipatedRetrievalMode(question)
  const subqueries = decomposeQuestion(question, mode)
  assert.equal(mode, 'spreadsheet_comparison')
  assert.equal(subqueries.length, 4)
  const coverage = evidenceCoverage(question, [chunk({ text: 'Configuration C880 costs $10.' })])
  assert.deepEqual(coverage.covered.sort(), ['configuration', 'price or cost'])
  assert.deepEqual(coverage.missing.sort(), ['lead time', 'risks'])
})

test('decomposes benefit questions into capability, outcome, and utilization searches', () => {
  const queries = decomposeQuestion(
    'What benefits and customer outcomes does Rafay provide?',
    'document_summary'
  )
  assert.equal(queries.length, 3)
  assert.match(queries[1], /payback.*savings/i)
  assert.match(queries[2], /utilization percentages/i)
})

test('uses document-wide retrieval for stack inventories and top differentiator lists', () => {
  assert.equal(
    anticipatedRetrievalMode(
      'What are the software stacks in Cisco Secure AI Factory validated design?'
    ),
    'document_summary'
  )
  assert.equal(
    anticipatedRetrievalMode('Top 10 unique competitive differentiators of Cisco ACI'),
    'document_summary'
  )
})

test('places explicitly labelled inventory passages before generic matching passages', () => {
  const generic = chunk({ location: 'Page 4', text: 'ACI application and network capabilities.' })
  const differentiators = chunk({
    location: 'Page 18',
    text: 'Cisco ACI Differentiators: multiple EPGs in the same VLAN or subnet.'
  })
  assert.equal(
    packEvidence('Top 10 unique competitive differentiators of Cisco ACI', [
      generic,
      differentiators
    ])[0].location,
    'Page 18'
  )

  const hardware = chunk({ location: 'Slide 5', text: 'GPU servers and network hardware.' })
  const software = chunk({
    location: 'Slide 12',
    text: 'Kubernetes platform options. AI software includes NVIDIA AI Enterprise.'
  })
  assert.equal(
    packEvidence('What are the software stacks in the validated design?', [hardware, software])[0]
      .location,
    'Slide 12'
  )
})

test('prioritizes a topic-matching slide title over generic deck-wide design slides', () => {
  const generic = chunk({
    location: 'Slide 4',
    heading: 'ACI Fabric Design',
    text: 'Service leaf connections include a firewall and load balancer.'
  })
  const firewall = chunk({
    location: 'Slide 13',
    heading: 'Default security design',
    text: 'Use VzAny with PBR to redirect traffic to a firewall.'
  })
  const loadBalancer = chunk({
    location: 'Slide 15',
    heading: 'Load Balancer Design (LTM)',
    text: 'Use multiple route domains and SNAT for load balancer virtual services.'
  })

  assert.equal(
    packEvidence('What are ACI load balancer design best practices?', [
      generic,
      firewall,
      loadBalancer
    ])[0].location,
    'Slide 15'
  )
  assert.equal(
    packEvidence('What are ACI firewall security design best practices?', [
      generic,
      loadBalancer,
      firewall
    ])[0].location,
    'Slide 13'
  )
})

test('excludes unrelated neighboring slides when the topic heading is explicit', () => {
  const focused = focusEvidenceByHeading('What are load balancer design best practices?', [
    chunk({ heading: 'Load Balancer Design', location: 'Slide 15' }),
    chunk({ heading: 'Firewall Multi-Site Design', location: 'Slide 14' }),
    chunk({ heading: 'ACI Fabric Design', location: 'Slide 4' })
  ])
  assert.deepEqual(
    focused.map((item) => item.location),
    ['Slide 15']
  )
})

test('preserves complete page and slide evidence for direct lookups', () => {
  const slide = chunk({
    location: 'Slide 15',
    heading: 'Load Balancer Design',
    text: 'Use SNAT for load balancer virtual services.\nAll route domains join an EPG in the common tenant.'
  })
  const [result] = narrowDirectLookupEvidence('What are the load balancer practices?', [slide])
  assert.equal(result.text, slide.text)
  assert.equal(result.location, 'Slide 15')
})

test('builds a conservative extractive fallback from the strongest topic slide', () => {
  const answer = buildExtractiveAnswer('What are ACI load balancer design best practices?', [
    chunk({
      file: 'DC Design Best Practice.pptx',
      location: 'Slide 15',
      heading: 'Load Balancer Design (LTM)',
      text: [
        'Load Balancer Design (LTM)',
        'Load Balancer deployment will use multiple VCMPs and Route Domains.',
        'All Route Domains will become members of an EPG in the Common Tenant.',
        'It is highly recommended to use SNAT for Load Balancer virtual services.'
      ].join('\n')
    }),
    chunk({
      file: 'DC Design Best Practice.pptx',
      location: 'Slide 17',
      heading: 'Nexus Dashboard placement',
      text: 'Use four dashboard nodes across two sites for orchestration.'
    })
  ])
  assert.match(answer ?? '', /multiple VCMPs and Route Domains.*\[1\]/)
  assert.match(answer ?? '', /recommended to use SNAT.*\[1\]/)
  assert.doesNotMatch(answer ?? '', /dashboard nodes/)
})

test('preserves exact spreadsheet rows in the extractive fallback', () => {
  const answer = buildExtractiveAnswer('Compare memory and storage for App1a and App2a', [
    chunk({
      file: 'App1a.xlsx',
      location: 'Sheet App1a, A1:B3',
      heading: 'App1a',
      text: '| Component | Specification |\n| Memory | 64 GB |\n| Usable storage | 1.92 TB |'
    }),
    chunk({
      file: 'App2a.xlsx',
      location: 'Sheet App2a, A1:B3',
      heading: 'App2a',
      text: '| Component | Specification |\n| Memory | 256 GB |\n| Usable storage | 3.84 TB |'
    })
  ])
  assert.match(answer ?? '', /Memory; 64 GB \[1\]/)
  assert.match(answer ?? '', /Usable storage; 3\.84 TB \[2\]/)
})

test('builds a deterministic top-N answer from explicit comparison rows and labelled items', () => {
  const answer = buildEvidenceListAnswer('Top 3 unique competitive differentiators', [
    chunk({
      location: 'Page 19',
      text: 'Feature Cisco ACl Competition Application Centric Endpoint Grouping, independent of VLANs Yes No Whitelist Policy with minimal configuration Yes No Multi-Tenancy with granular RBAC Yes No'
    }),
    chunk({
      location: 'Page 18',
      text: 'Cisco ACI Differentiators 1. Multiple EPGs in same VLAN/subnet using APIC GUI. 2. Implement PBR for firewall insertion from EPG-A to EPG-B.'
    })
  ])
  assert.match(answer ?? '', /1\. Application Centric Endpoint Grouping.*\[1\]/)
  assert.match(answer ?? '', /2\. Whitelist Policy.*\[1\]/)
  assert.match(answer ?? '', /3\. Multi-Tenancy.*\[1\]/)
  assert.doesNotMatch(answer ?? '', /Multiple EPGs/)
})

test('builds a deterministic software-stack answer from explicitly labelled layers', () => {
  const answer = buildSoftwareStackAnswer('What are the software stacks in the validated design?', [
    chunk({
      location: 'Slide 12',
      text: 'Kubernetes platform\nOptions: Red Hat OpenShift, Nutanix NKP, Upstream Kubernetes\nAI software\nNVIDIA AI Enterprise\nNeMo\nNIM\nBlueprints\nAI Workload & GPU Orchestration'
    }),
    chunk({
      location: 'Slide 13',
      text: 'AI Software & Kubernetes Platform\nRed Hat AI Factory Software\nNVIDIA AI Enterprise\nRed Hat AI Enterprise'
    }),
    chunk({
      location: 'Slide 11',
      text: 'Kubernetes platform\nContainer orchestration and management\nAI software\nAI frameworks, libraries, models, inference server, etc.\nAI workload and GPU orchestration'
    })
  ])
  assert.match(answer ?? '', /Kubernetes platform options \[1\]/)
  assert.match(answer ?? '', /Red Hat OpenShift \[1\]/)
  assert.match(answer ?? '', /AI software stack \[1\]/)
  assert.match(answer ?? '', /Red Hat AI Factory Software \[2\]/)
  assert.doesNotMatch(answer ?? '', /GPU servers|storage vendors/i)
  assert.doesNotMatch(answer ?? '', /Container orchestration and management/)
})

test('builds an exact offline and online flow from image OCR labels', () => {
  const answer = buildDiagramFlowAnswer('What are the offline and online steps?', [
    chunk({
      file: 'flow.png',
      location: 'Image text',
      text: [
        'Data Sources',
        'User / Application',
        'Extract / Chunk',
        'Query',
        'Retrieve Context',
        'Create Embeddings',
        'Vector Database',
        'LLM Service',
        'Store in Vector DB',
        'Generate Response',
        'Response to User'
      ].join('\n')
    })
  ])
  assert.match(answer ?? '', /1\. Data Sources \[1\][\s\S]*4\. Store in Vector DB \[1\]/)
  assert.match(answer ?? '', /1\. User \/ Application \[1\][\s\S]*6\. Response to User \[1\]/)
})

test('preserves explicitly qualified benefit and outcome claims', () => {
  const answer = buildBenefitOutcomeAnswer('What benefits and customer outcomes are stated?', [
    chunk({
      file: 'benefits.pptx',
      location: 'Slide 7',
      text: 'Self-Service GPU Portal\nUsage Metering & Chargeback\nEnterprise Governance\nAI-driven scheduling and resource pooling'
    }),
    chunk({
      file: 'benefits.pptx',
      location: 'Slide 12',
      text: 'Customers report 3x faster payback on GPU investments\nTypical enterprise saves through reduced GPU sprawl'
    }),
    chunk({
      file: 'benefits.pptx',
      location: 'Slide 14',
      text: 'Drive predictable utilization from 30% to 80%+'
    })
  ])
  assert.match(answer ?? '', /Self-Service GPU Portal \[1\]/)
  assert.match(answer ?? '', /Customers report 3x faster payback.*\[2\]/)
  assert.match(answer ?? '', /30% to 80%\+.*\[3\]/)
})

test('returns one exact total-GPU target per sizing sheet', () => {
  const answer = buildSpreadsheetSizingAnswer('What is the H200 sizing target for each use case?', [
    chunk({
      file: 'sizing.xlsx',
      location: 'Sheet UC1, A1:B4',
      text: '| Parameter | Value |\n| Total GPUs (6×2 + 2 OCR) | 14 |'
    }),
    chunk({
      file: 'sizing.xlsx',
      location: 'Sheet UC2, A1:C4',
      text: '| Parameter | Low | High |\n| Total GPUs | 5 | 5 |'
    }),
    chunk({
      file: 'sizing.xlsx',
      location: 'Sheet UC3, A1:C4',
      text: '| Parameter | Low | High |\n| Total GPUs | 2 | 2 |'
    })
  ])
  assert.match(answer ?? '', /Sheet UC1.*14 \[1\]/)
  assert.match(answer ?? '', /Sheet UC2.*5; 5 \[2\]/)
  assert.match(answer ?? '', /Sheet UC3.*2; 2 \[3\]/)
})

test('preserves labelled workbook totals without recomputing them', () => {
  const answer = buildSpreadsheetLabeledFacts(
    'Report the product, service, subscription, and total prices.',
    [
      chunk({
        file: 'pricing.xlsx',
        text: [
          '| Label | Value |',
          '| Product Total | 149927.16 |',
          '| Service Total | 28830.00 |',
          '| Subscription Total | 9603.00 |',
          '| Total Price | 188360.16 |'
        ].join('\n')
      })
    ]
  )
  assert.match(answer ?? '', /Product Total; 149927\.16/)
  assert.match(answer ?? '', /Total Price; 188360\.16/)
  assert.doesNotMatch(answer ?? '', /calculate|derived/i)
})

test('keeps a complete matching Markdown section instead of truncating its list', () => {
  const source = chunk({
    heading: 'For UCS Domains',
    location: 'For UCS Domains, Lines 30-46',
    text: [
      '###### For UCS Domains',
      ...Array.from({ length: 15 }, (_, index) => `- Policy ${index + 1}`)
    ].join('\n')
  })
  const [result] = narrowDirectLookupEvidence('Which policy makers are listed for UCS Domains?', [
    source
  ])
  assert.equal(result.text, source.text)
  assert.equal(result.location, source.location)
})

test('uses stricter calibrated confidence for ambiguous questions', () => {
  const evidence = [chunk({ text: 'A general architecture note.', score: 0.32 })]
  assert.equal(
    retrievalConfidence('Tell me what matters.', evidence, 'direct_lookup').level,
    'high'
  )
  assert.equal(retrievalConfidence('Tell me what matters.', evidence, 'ambiguous').level, 'medium')
})

test('recognizes only explicit interpretation and file-inventory requests', () => {
  assert.equal(explicitlyRequestsInterpretation('What do you think about the poem?'), true)
  assert.equal(explicitlyRequestsInterpretation('What does the poem state?'), false)
  assert.equal(isFileInventoryQuestion('What documents do you have?'), true)
})

test('does not treat an explicit non-disclosure instruction as a reveal request', () => {
  assert.equal(requestsSensitiveValue('What is the password in lab access.txt?'), true)
  assert.equal(
    requestsSensitiveValue('Summarize the configuration without revealing credentials.'),
    false
  )
  assert.equal(
    requestsSensitiveValue('Preserve the VLAN details, but do not reveal credentials.'),
    false
  )
})

test('places the two strongest selected passages at opposite context edges', () => {
  const chunks = [chunk({ file: 'first' }), chunk({ file: 'second' }), chunk({ file: 'third' })]
  assert.deepEqual(
    placeStrongEvidenceAtEdges(chunks).map((item) => item.file),
    ['first', 'third', 'second']
  )
})

test('narrows direct evidence to matching records instead of unrelated neighbors', () => {
  const result = narrowDirectLookupEvidence('APIC 1 and APIC 2 credentials', [
    chunk({
      text: [
        'DNS: 10.0.0.1',
        'APIC 1: 10.0.0.11 (admin:secret-one)',
        'Jump host: 10.0.0.20 (admin:other)',
        'APIC 2: 10.0.0.12 (admin:secret-two)'
      ].join('\n'),
      location: 'Lines 40-43'
    })
  ])
  assert.match(result[0].text, /APIC 1/)
  assert.match(result[0].text, /APIC 2/)
  assert.doesNotMatch(result[0].text, /Jump host|DNS/)
  assert.equal(result[0].location, 'Lines 41-43')
  assert.equal(requestsSensitiveValue('Show the API key'), true)
})

test('keeps concise network configuration commands in extractive answers', () => {
  const answer = buildExtractiveAnswer('Summarize the BCAF tenant configuration', [
    chunk({
      file: 'tenant.txt',
      location: 'Lines 1-20',
      text: 'tenant BCAF\nvlan 25\nvrf context BCAF\nrouter bgp 65001\nip router ospf 1 area 0.0.0.0'
    })
  ])
  assert.match(answer ?? '', /vlan 25/)
  assert.match(answer ?? '', /vrf context BCAF/)
  assert.match(answer ?? '', /router bgp 65001/)
})
