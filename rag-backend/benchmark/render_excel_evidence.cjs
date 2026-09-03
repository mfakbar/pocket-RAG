'use strict'
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS benchmark bridge loads a runtime-selected compiled module. */

const fs = require('node:fs')
const path = require('node:path')

const payload = JSON.parse(fs.readFileSync(0, 'utf8'))
const compiled = path.resolve(String(payload.compiled))
const { structuredSpreadsheetAnswer, structuredSpreadsheetEvidence } = require(compiled)
const question = String(payload.question || '')
const chunks = Array.isArray(payload.chunks) ? payload.chunks : []
const rows = Array.isArray(payload.rows) ? payload.rows : []
process.stdout.write(
  JSON.stringify({
    evidence: structuredSpreadsheetEvidence(question, chunks, rows),
    answer: structuredSpreadsheetAnswer(question, chunks, rows)
  })
)
