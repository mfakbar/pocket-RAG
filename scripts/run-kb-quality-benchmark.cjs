/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

function argument(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

function filesUnder(root) {
  const supported = new Set([
    '.pdf',
    '.docx',
    '.pptx',
    '.xlsx',
    '.xls',
    '.csv',
    '.txt',
    '.md',
    '.png',
    '.jpg',
    '.jpeg'
  ])
  const found = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name.startsWith('~$')) continue
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (supported.has(path.extname(entry.name).toLowerCase())) found.push(target)
    }
  }
  visit(root)
  return found.sort()
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function fileDigest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function normalized(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function includesTerm(answer, term) {
  return normalized(answer).includes(normalized(term))
}

function includesRequiredTerm(answer, term) {
  if (includesTerm(answer, term)) return true
  const numeric = (value) => value.replace(/(?<=\d)[,.](?=\d{3}(?:\D|$))/g, '')
  if (includesTerm(numeric(answer), numeric(term))) return true
  const answerTokens = new Set(normalized(answer).split(' ').filter(Boolean))
  const termTokens = normalized(term).split(' ').filter(Boolean)
  return termTokens.length > 1 && termTokens.every((token) => answerTokens.has(token))
}

function locationMatches(actual, expected) {
  if (actual.includes(expected)) return true
  const spreadsheet = (value) => {
    const match = /^Sheet (.+?),\s*([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(value)
    if (!match) return null
    const column = (letters) =>
      [...letters.toUpperCase()].reduce(
        (total, letter) => total * 26 + letter.charCodeAt(0) - 64,
        0
      )
    return {
      sheet: match[1].trim().toLowerCase(),
      startColumn: column(match[2]),
      startRow: Number(match[3]),
      endColumn: column(match[4]),
      endRow: Number(match[5])
    }
  }
  const actualSheet = spreadsheet(actual)
  const expectedSheet = spreadsheet(expected)
  if (actualSheet && expectedSheet) {
    return (
      actualSheet.sheet === expectedSheet.sheet &&
      actualSheet.startColumn <= expectedSheet.startColumn &&
      actualSheet.startRow <= expectedSheet.startRow &&
      actualSheet.endColumn >= expectedSheet.endColumn &&
      actualSheet.endRow >= expectedSheet.endRow
    )
  }
  const actualLines = /\bLines?\s+(\d+)(?:-(\d+))?/i.exec(actual)
  const expectedLines = /\bLines?\s+(\d+)(?:-(\d+))?/i.exec(expected)
  if (!actualLines || !expectedLines) return false
  const actualStart = Number(actualLines[1])
  const actualEnd = Number(actualLines[2] || actualLines[1])
  const expectedStart = Number(expectedLines[1])
  const expectedEnd = Number(expectedLines[2] || expectedLines[1])
  return actualStart <= expectedEnd && expectedStart <= actualEnd
}

function answerSections(answer) {
  const marker = /^## Verified summary\s*$/m.exec(answer)
  if (!marker) return { initial: '', verified: answer.trim() }
  return {
    initial: answer.slice(0, marker.index).trim(),
    verified: answer.slice(marker.index + marker[0].length).trim()
  }
}

function formattingAssessment(answer) {
  const outsideCode = answer.split(/```[\s\S]*?```/g).join('\n')
  const issues = []
  if (/\(continued\)|^\s*(?:#{1,6}\s*)?continued:?\s*$/im.test(outsideCode)) {
    issues.push('continuation label')
  }
  if (/[^\s#]#{2,6}\s+[A-Z0-9]/.test(outsideCode)) issues.push('inline heading seam')
  if (
    outsideCode.split('\n').some((line) => {
      const heading = /^\s*(#{1,6})(.*)$/.exec(line)
      return Boolean(heading?.[2] && !/^\s/.test(heading[2]))
    })
  ) {
    issues.push('heading missing space')
  }
  if ((outsideCode.match(/\*\*/g) || []).length % 2 !== 0) issues.push('unbalanced bold marker')
  if (/<\/?(?:div|p|span|table|tr|td|th|h[1-6])\b/i.test(outsideCode)) {
    issues.push('raw HTML')
  }
  const tableLines = outsideCode.split('\n').filter((line) => /^\s*\|.*\|\s*$/.test(line))
  if (
    tableLines.length > 0 &&
    !tableLines.some((line) => /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line))
  ) {
    issues.push('malformed Markdown table')
  }
  return { pass: issues.length === 0, issues }
}

function hasValidMarkdownTable(answer) {
  const lines = answer.split('\n')
  return lines.some((line, index) => {
    if (!/^\s*\|.*\|\s*$/.test(line)) return false
    const separator = lines[index + 1] || ''
    return /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(separator)
  })
}

async function main() {
  const root = path.resolve(__dirname, '..')
  const boq = argument('boq')
  const tdm = argument('tdm')
  const dataDir = argument('data-dir')
  const output = argument(
    'output',
    path.join(root, 'rag-backend', 'benchmark', 'kb-quality-report.json')
  )
  const model = argument('model', 'qwen3.5:4b-q4_K_M')
  const selectedIds = new Set(
    argument('ids')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  )
  const mergeBase = argument('merge-base')
  const skipIndex = argument('skip-index').toLowerCase() === 'true'
  const reindexBases = new Set(
    argument('reindex-kb', 'boq,tdm')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  )
  const configPath = argument('config')
  const questionsPath = argument(
    'questions',
    path.join(root, 'rag-backend/benchmark/kb_quality_questions.json')
  )
  const configuredEmbeddingModel = argument('embedding-model')
  if (!boq || !tdm || !dataDir) throw new Error('Required: --boq, --tdm, and --data-dir')

  const appConfig = configPath ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : null
  const embeddingModel =
    configuredEmbeddingModel || appConfig?.embeddingModel || 'qwen3-embedding:4b'
  const rerankerModel = appConfig?.rerankerModel || 'BAAI/bge-reranker-v2-m3'

  const { LocalRagService } = require(
    path.join(root, '.test-out/src/main/services/local-rag-service.js')
  )
  const { OllamaService } = require(
    path.join(root, '.test-out/src/main/services/ollama-service.js')
  )
  const baseUrl = 'http://127.0.0.1:11434'
  const ollama = new OllamaService(baseUrl)
  const service = new LocalRagService(
    () => path.join(root, 'rag-backend'),
    () => dataDir,
    baseUrl,
    embeddingModel,
    rerankerModel,
    ollama
  )
  service.setPythonExecutable(path.join(root, 'rag-backend/.venv/bin/python'))

  const rag = {
    topK: 5,
    improveDocumentMatching: false,
    hybridSearch: true,
    hybridKeywordWeight: 0.6,
    enrichedMetadata: true,
    fullContext: false,
    textSplitter: 'token',
    preserveHeadings: true,
    chunkSize: 1000,
    chunkOverlap: 100,
    minimumChunkSize: 500,
    pdfOcr: true
  }
  Object.assign(rag, appConfig?.rag || {})
  const inference = {
    contextLength: 8192,
    temperature: 0.2,
    topP: 0.9,
    maxOutputTokens: 900
  }
  Object.assign(inference, appConfig?.inference || {})
  let bases = {
    boq: {
      id: 'benchmark-boq',
      name: 'BoQ',
      description: 'Bill of materials and sizing workbooks',
      customInstructions: ''
    },
    tdm: {
      id: 'benchmark-tdm',
      name: 'Technical Library',
      description: 'Data-center workshops and business development material',
      customInstructions: ''
    }
  }
  if (appConfig?.knowledgeBases) {
    const configuredBases = appConfig.knowledgeBases
    const boqBase = configuredBases.find((base) => path.resolve(base.folder) === path.resolve(boq))
    const tdmBase = configuredBases.find((base) => path.resolve(base.folder) === path.resolve(tdm))
    if (!boqBase || !tdmBase)
      throw new Error('The configured knowledge bases do not match the supplied folders.')
    bases = {
      boq: {
        id: boqBase.id,
        name: boqBase.name,
        description: boqBase.description || '',
        customInstructions: boqBase.customInstructions || '',
        manifest: boqBase.manifest || {}
      },
      tdm: {
        id: tdmBase.id,
        name: tdmBase.name,
        description: tdmBase.description || '',
        customInstructions: tdmBase.customInstructions || '',
        manifest: tdmBase.manifest || {}
      }
    }
  }

  try {
    for (const [key, folder] of skipIndex
      ? []
      : [
          ['boq', boq],
          ['tdm', tdm]
        ].filter(([key]) => reindexBases.has(key))) {
      const generation = (await service.beginRebuild(bases[key].id)).generation
      const sourceFiles = filesUnder(folder)
      for (const [index, file] of sourceFiles.entries()) {
        const relative = path.relative(folder, file)
        const stat = fs.statSync(file)
        process.stderr.write(`Indexing ${key} ${index + 1}/${sourceFiles.length}: ${relative}\n`)
        await service.indexDocument(
          bases[key].id,
          file,
          relative,
          digest(`${key}:${relative}`),
          digest(`${stat.size}:${stat.mtimeMs}`),
          rag,
          generation
        )
      }
      await service.commitRebuild(bases[key].id, generation)
    }
    if (!skipIndex) await service.finalizeSync()

    const allQuestions = JSON.parse(fs.readFileSync(questionsPath, 'utf8'))
    const questions =
      selectedIds.size > 0 ? allQuestions.filter((item) => selectedIds.has(item.id)) : allQuestions
    const sourceVerification = questions.map((item) => {
      const folder = item.knowledge_base === 'boq' ? boq : tdm
      const file = path.join(folder, item.expected_file)
      const indexedChecksum =
        bases[item.knowledge_base].manifest?.[item.expected_file]?.checksum || ''
      const currentChecksum = fileDigest(file)
      const verified = !appConfig || indexedChecksum === currentChecksum
      return { id: item.id, file: item.expected_file, indexedChecksum, currentChecksum, verified }
    })
    if (sourceVerification.some((item) => !item.verified)) {
      throw new Error('At least one source file changed after the copied index was built.')
    }
    const results = []
    for (const [index, item] of questions.entries()) {
      process.stderr.write(`Running ${index + 1}/${questions.length}: ${item.id}\n`)
      const events = []
      let error = null
      let metrics = null
      try {
        metrics = await service.streamChat(
          model,
          [{ role: 'user', content: item.question }],
          rag,
          inference,
          [bases[item.knowledge_base]],
          [],
          false,
          (event) => events.push(event),
          new AbortController().signal
        )
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught)
      }
      const streamed = events
        .filter((event) => event.type === 'token')
        .map((event) => event.content)
        .join('')
      const replacement = [...events].reverse().find((event) => event.type === 'replace')?.content
      const answer = replacement || streamed
      const sections = answerSections(answer)
      const answerForScoring = sections.verified
      const formatting = formattingAssessment(answer)
      const citations =
        [...events].reverse().find((event) => event.type === 'citations')?.citations || []
      const required = item.required_terms.map((term) => ({
        term,
        present: includesRequiredTerm(answerForScoring, term)
      }))
      const forbidden = item.forbidden_terms.map((term) => ({
        term,
        present: includesTerm(answerForScoring, term)
      }))
      const sourcePass = citations.some((citation) => citation.file === item.expected_file)
      const locationPass =
        item.expected_locations.length === 0 ||
        item.expected_locations.every((location) =>
          citations.some(
            (citation) =>
              citation.file === item.expected_file && locationMatches(citation.location, location)
          )
        )
      const sensitivePass =
        !item.expects_sensitive_action ||
        events.some((event) => event.type === 'sensitive-action' && event.available)
      const structurePass =
        item.required_format !== 'table' || hasValidMarkdownTable(answerForScoring)
      const assessment = {
        source_pass: sourcePass,
        location_pass: locationPass,
        required_coverage:
          required.length === 0
            ? 1
            : required.filter((entry) => entry.present).length / required.length,
        forbidden_pass: forbidden.every((entry) => !entry.present),
        fallback_pass: !/I could not verify a complete answer|try a narrower question/i.test(
          answerForScoring
        ),
        sensitive_pass: sensitivePass,
        structure_pass: structurePass
      }
      assessment.formatting_pass = formatting.pass
      assessment.pass =
        !error &&
        assessment.source_pass &&
        assessment.location_pass &&
        assessment.required_coverage === 1 &&
        assessment.forbidden_pass &&
        assessment.fallback_pass &&
        assessment.sensitive_pass &&
        assessment.structure_pass &&
        assessment.formatting_pass
      results.push({
        ...item,
        answer,
        initial_answer: sections.initial,
        verified_answer: sections.verified,
        citations: citations.map(({ file, location }) => ({ file, location })),
        notices: events.filter((event) => event.type === 'notice').map((event) => event.message),
        metrics,
        required,
        forbidden,
        formatting,
        error,
        assessment
      })
    }
    let combinedResults = results
    if (mergeBase) {
      const prior = JSON.parse(fs.readFileSync(mergeBase, 'utf8'))
      const replacements = new Map(results.map((result) => [result.id, result]))
      const priorById = new Map((prior.results || []).map((result) => [result.id, result]))
      combinedResults = allQuestions
        .map((item) => replacements.get(item.id) || priorById.get(item.id))
        .filter(Boolean)
    }
    const report = {
      generated_at: new Date().toISOString(),
      benchmark:
        'Independent source-grounded expectations authored by Codex; local 4B model is the system under test, not the benchmark.',
      model_under_test: model,
      embedding_model: embeddingModel,
      reranker_model: rerankerModel,
      settings: { rag, inference },
      source_verification: sourceVerification,
      summary: {
        prompts: combinedResults.length,
        passed: combinedResults.filter((result) => result.assessment.pass).length,
        source_passed: combinedResults.filter((result) => result.assessment.source_pass).length,
        no_forbidden_claims: combinedResults.filter((result) => result.assessment.forbidden_pass)
          .length,
        no_generic_fallback: combinedResults.filter((result) => result.assessment.fallback_pass)
          .length,
        formatting_passed: combinedResults.filter((result) => result.assessment.formatting_pass)
          .length,
        structure_passed: combinedResults.filter((result) => result.assessment.structure_pass)
          .length
      },
      results: combinedResults
    }
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify(report.summary)}\n${output}\n`)
  } finally {
    service.stop()
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`)
  process.exitCode = 1
})
