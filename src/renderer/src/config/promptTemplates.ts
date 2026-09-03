export interface PromptTemplate {
  id: string
  name: string
  prompt: string
  custom?: boolean
}

export const DEFAULT_PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    id: 'executive-summary',
    name: 'Executive summary',
    prompt: 'Summarize the most important points, decisions, and next steps.'
  },
  {
    id: 'find-answer',
    name: 'Find a clear answer',
    prompt:
      '<INPUT YOUR QUESTION>? Explain it clearly, cite the evidence, and say when important details are missing.'
  },
  {
    id: 'compare-options',
    name: 'Compare options',
    prompt:
      'In <INPUT YOUR FILE/DOCUMENT NAMES>, first find one topic that clearly presents two or more options as alternatives, then compare only those options. Use one short section per option and cover supported benefits, drawbacks, costs, and key differences. If no single document supports a like-for-like comparison, do not compare or summarize unrelated files; briefly say so and ask me to choose a specific file, project, or topic.'
  },
  {
    id: 'action-plan',
    name: 'Create an action plan',
    prompt:
      'Create a practical action plan only when <INPUT FILE/DOCUMENT NAMES> support one clear project or objective. Include priorities and next steps, and include owners or deadlines only when the files explicitly name them. If the documents cover unrelated projects and no single objective is clear, do not combine them into one plan; briefly say so and ask me to choose a specific file, project, or objective.'
  },
  {
    id: 'risks-gaps',
    name: 'Find risks and gaps',
    prompt:
      'Identify the main risks, missing information, assumptions, and questions that still need answers.'
  },
  {
    id: 'meeting-brief',
    name: 'Prepare a meeting brief',
    prompt:
      'Using <INPUT FILE/DOCUMENT NAMES>, prepare a concise meeting brief with background, key facts, likely questions, and recommended talking points.'
  },
  {
    id: 'timeline',
    name: 'Build a timeline',
    prompt:
      'Using <INPUT FILE/DOCUMENT NAMES>, create a chronological timeline using only events, decisions, and deadlines explicitly dated in the documents. List undated items separately.'
  },
  {
    id: 'extract-numbers',
    name: 'Extract key numbers',
    prompt:
      'From <INPUT FILE/DOCUMENT NAMES>, list the important numbers, costs, dates, targets, and measurements. Explain what each one means.'
  },
  {
    id: 'plain-language',
    name: 'Explain simply',
    prompt:
      'Using <INPUT FILE/DOCUMENT NAMES>, explain the relevant information in plain language for someone who is new to the topic.'
  },
  {
    id: 'draft-from-files',
    name: 'Draft from my files',
    prompt:
      'Draft a clear, professional response using only facts in <INPUT FILE/DOCUMENT NAMES>. Keep unrelated information, projects, or files in separate sections, do not combine their numbers, and flag anything that needs confirmation.'
  }
]
