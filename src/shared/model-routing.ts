const COMPLEX_TASK =
  /\b(?:compare|comparison|versus|vs\.?|commercial|pricing|cost analysis|risk analysis|trade[- ]offs?|across (?:files|documents)|multiple (?:files|documents|sections)|spreadsheet|workbook|worksheet|sheets?|dense|all configurations?|all options?|software stacks?|validated design)\b|\btop\s+\d+\b|\bunique\b.*\bdifferentiators?\b/i

const MULTI_CATEGORY =
  /\b(?:architecture|operations?|differentiators?|benefits?|risks?|costs?|prices?|quantit(?:y|ies)|lead times?|gaps?)\b/gi

const HIGH_QUALITY_TASK =
  /\b(?:compare|comparison|versus|vs\.?|across (?:files|documents)|multiple (?:files|documents)|all configurations?|all options?|exhaustive|executive (?:summary|brief)|risk analysis|trade[- ]offs?|software stacks?|validated design)\b|\btop\s+\d+\b|\bunique\b.*\bdifferentiators?\b/i

const BALANCED_TASK =
  /\b(?:summari[sz]e|overview|analyse|analyze|explain|procedure|checklist|spreadsheet|workbook|worksheet|price|cost|quantity|lead time)\b/i

export function isTwoBModel(model: string): boolean {
  return /(?:^|[:/_-])2b(?:$|[:/_-])/i.test(model)
}

export function questionNeedsBalancedModel(question: string): boolean {
  const normalized = question.trim()
  if (!normalized) return false
  if (COMPLEX_TASK.test(normalized)) return true
  const categories = new Set(normalized.match(MULTI_CATEGORY)?.map((item) => item.toLowerCase()))
  return categories.size >= 3
}

export function shouldWarnAboutTwoBModel(model: string, question: string): boolean {
  return isTwoBModel(model) && questionNeedsBalancedModel(question)
}

export type ModelRoute = 'selected' | 'balanced' | 'high-quality'

export function modelRouteForQuestion(question: string): ModelRoute {
  const categories = new Set(question.match(MULTI_CATEGORY)?.map((item) => item.toLowerCase()))
  if (HIGH_QUALITY_TASK.test(question) || categories.size >= 3) return 'high-quality'
  if (BALANCED_TASK.test(question)) return 'balanced'
  return 'selected'
}

export function routedModel(
  selectedModel: string,
  presets: { balanced: string; 'high-quality': string },
  installedModels: string[],
  question: string
): string {
  const route = modelRouteForQuestion(question)
  if (route === 'selected') return selectedModel
  const target = presets[route]
  return installedModels.some((model) => model.toLowerCase() === target.toLowerCase())
    ? target
    : selectedModel
}
