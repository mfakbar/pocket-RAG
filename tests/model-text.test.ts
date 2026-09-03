import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeModelText } from '../src/shared/model-text'

test('converts common HTML formatting artifacts to readable Markdown', () => {
  assert.equal(
    normalizeModelText(
      '<p>Summary</p><ul><li>First<br>detail</li><li><span>Second</span></li></ul>'
    ),
    'Summary\n\n- First\ndetail\n- Second'
  )
})

test('preserves HTML examples inside fenced code blocks', () => {
  const response = 'Example:\n```html\n<div>Hello<br></div>\n```'
  assert.equal(normalizeModelText(response), response)
})

test('removes continuation labels and repairs malformed Markdown headings', () => {
  assert.equal(
    normalizeModelText(
      '### **Platform benefits**\n\n**Detailed Benefit Breakdowns**\n\n(Continued)\n\nThe first section ends here .####Operational benefits (Continued)\n\nUseful content.'
    ),
    '### Platform benefits\n\n### Detailed Benefit Breakdowns\n\nThe first section ends here.\n\n#### Operational benefits\n\nUseful content.'
  )
})

test('removes bold continuation labels and collapses titles repeated at a continuation seam', () => {
  assert.equal(
    normalizeModelText(
      '**Benefit: Future-Ready Architecture Benefit: Future-Ready Architecture (Continued)**\n\n' +
        '**Supported Platforms Supported Platforms (Continued)**'
    ),
    '### Benefit: Future-Ready Architecture\n\n### Supported Platforms'
  )
})

test('collapses adjacent continuation headings after removing their labels', () => {
  assert.equal(
    normalizeModelText(
      '### Supported Platforms\n\n### Supported Platforms (Continued)\n\n- Linux [1].'
    ),
    '### Supported Platforms\n\n- Linux [1].'
  )
})

test('repairs cited continuation seams after truncated bullets and sentences', () => {
  assert.equal(
    normalizeModelText(
      '### Supported Platforms and Limitations\n\n' +
        '* N9300 series fixed switches (24G or more RAM) [3]\n' +
        '* N9200 series fixed switches (### Supported Platforms and Limitations (Continued) [3]\n\n' +
        '* N9400 series switches [3]\n\n' +
        '### Benefits of Live Protect\n\n' +
        'Enables proactive reduction of the attack surface through platform hardening scheduled for Q### Benefits of Live Protect (Continued) [4]\n\n' +
        '- No downtime [4].'
    ),
    '### Supported Platforms and Limitations\n\n' +
      '* N9300 series fixed switches (24G or more RAM) [3]\n' +
      '\n* N9400 series switches [3]\n\n' +
      '### Benefits of Live Protect\n\n' +
      '- No downtime [4].'
  )
})

test('applies continuation repair generically across unrelated response topics', () => {
  const cases = [
    {
      input:
        '## Deployment phases\n\n- Complete discovery [1].\n- Begin implementation (## Deployment phases (Continued) [1]\n\n- Validate production [1].',
      expected: '## Deployment phases\n\n- Complete discovery [1].\n\n- Validate production [1].'
    },
    {
      input:
        '**Quarterly Results (Continued) [2]**\n\nRevenue increased according to the report [2].',
      expected: '### Quarterly Results [2]\n\nRevenue increased according to the report [2].'
    },
    {
      input:
        '### Security controls\n\nThe policy remains effective through### Security controls (Continued)\n\n- Rotate credentials regularly.',
      expected: '### Security controls\n\n- Rotate credentials regularly.'
    }
  ]

  for (const { input, expected } of cases) {
    assert.equal(normalizeModelText(input), expected)
  }
})

test('removes empty headings and incomplete text before a restarted section', () => {
  assert.equal(
    normalizeModelText(
      '#\n\nA customer outcome trails off through improved charge\n\n### Customer outcomes\n\n- Faster access [1].'
    ),
    '### Customer outcomes\n\n- Faster access [1].'
  )
})

test('drops a truncated final list item and balances bold markers', () => {
  assert.equal(
    normalizeModelText('## Results\n\n- **Complete value:** 150 kW [1].\n- **Truncated value'),
    '## Results\n\n- **Complete value:** 150 kW [1].'
  )
})

test('repairs short Markdown table separators', () => {
  assert.equal(
    normalizeModelText('| Option | Value |\n|:-- |:--:|\n| A | 1 |'),
    '| Option | Value |\n| :--- | :---: |\n| A | 1 |'
  )
})
