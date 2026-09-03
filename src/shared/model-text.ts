function normalizeHtmlOutsideCode(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(
      /<\/?(?:p|div|section|article|header|footer|ul|ol|blockquote|table|thead|tbody|tr|h[1-6])(?:\s[^>]*)?>/gi,
      '\n'
    )
    .replace(/<li(?:\s[^>]*)?>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<strong(?:\s[^>]*)?>/gi, '**')
    .replace(/<\/strong>/gi, '**')
    .replace(/<em(?:\s[^>]*)?>/gi, '*')
    .replace(/<\/em>/gi, '*')
    .replace(/<code(?:\s[^>]*)?>/gi, '`')
    .replace(/<\/code>/gi, '`')
    .replace(/<span(?:\s[^>]*)?>|<\/span>/gi, '')
    .replace(/<a(?:\s[^>]*)?>|<\/a>/gi, '')
}

function collapseRepeatedHeadingTitle(value: string): string {
  const title = value.trim().replace(/\s+/g, ' ')
  const words = title.split(' ')
  if (words.length < 4 || words.length % 2 !== 0) return title

  const midpoint = words.length / 2
  const first = words.slice(0, midpoint).join(' ')
  const second = words.slice(midpoint).join(' ')
  return first.localeCompare(second, undefined, { sensitivity: 'accent' }) === 0 ? first : title
}

function headingIdentity(value: string): string {
  return value
    .replace(/(?:\s*\[\d+(?:\s*,\s*\d+)*\])+\s*$/, '')
    .trim()
    .toLocaleLowerCase()
}

function normalizeMarkdownOutsideCode(value: string): string {
  const normalized = value
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/([^#\s])(#{2,6})(?=\s*[A-Z0-9])/g, '$1\n\n$2')
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()
      if (/^#{1,6}$/.test(trimmed)) return ''
      if (/^\|(?:\s*:?-+:?\s*\|)+$/.test(trimmed)) {
        const cells = trimmed
          .slice(1, -1)
          .split('|')
          .map((cell) => {
            const marker = cell.trim()
            const left = marker.startsWith(':') ? ':' : ''
            const right = marker.endsWith(':') ? ':' : ''
            return `${left}---${right}`
          })
        return `| ${cells.join(' | ')} |`
      }
      if (
        /^(?:#{1,6}\s*)?(?:\*{1,2}|_{1,2})?\(?continued\)?(?:\*{1,2}|_{1,2})?:?$/i.test(trimmed)
      ) {
        return ''
      }

      const withoutContinuation = line.replace(
        /\s+\(continued\)(?=\s*(?:(?:\[\d+(?:\s*,\s*\d+)*\]\s*)*(?:\*\*|__)?\s*)$)/i,
        ''
      )
      const boldHeading = withoutContinuation.match(/^(\s*)\*\*([^*\n]{2,100}?)\*\*:?\s*$/)
      if (boldHeading && !/[.!?]$/.test(boldHeading[2].trim())) {
        return `${boldHeading[1]}### ${collapseRepeatedHeadingTitle(boldHeading[2].replace(/:$/, ''))}`
      }
      const heading = withoutContinuation.match(/^(\s*)(#{1,6})\s*(.+?)\s*$/)
      if (!heading) return withoutContinuation

      const content = collapseRepeatedHeadingTitle(
        heading[3].replace(/^\*\*(.+)\*\*$/, '$1').trim()
      )
      return `${heading[1]}${heading[2]} ${content}`
    })
    .join('\n')
  const lines = normalized.split('\n')
  const repaired = lines.filter((line, index) => {
    if (!line.trim() || /^\s*(?:#{1,6}\s|\|)/.test(line)) return true
    const next = lines.slice(index + 1).find((candidate) => candidate.trim())
    if (!next || !/^\s*#{2,6}\s+/.test(next)) return true
    return /[.!?:;\])`*]$/.test(line.trim())
  })
  const withoutRepeatedHeadings = repaired.filter((line, index) => {
    const heading = /^\s*#{1,6}\s+(.+?)\s*$/.exec(line)
    if (!heading) return true
    const previousHeading = repaired
      .slice(0, index)
      .reverse()
      .map((candidate) => /^\s*#{1,6}\s+(.+?)\s*$/.exec(candidate))
      .find((candidate) => candidate !== null)
    return !previousHeading || headingIdentity(previousHeading[1]) !== headingIdentity(heading[1])
  })
  let lastContent = -1
  for (let index = withoutRepeatedHeadings.length - 1; index >= 0; index -= 1) {
    if (!withoutRepeatedHeadings[index].trim()) continue
    lastContent = index
    break
  }
  if (
    lastContent >= 0 &&
    /^\s*(?:[-*+]\s|\d+[.)]\s)/.test(withoutRepeatedHeadings[lastContent]) &&
    (withoutRepeatedHeadings[lastContent].match(/\*\*/g) || []).length % 2 !== 0
  ) {
    withoutRepeatedHeadings.splice(lastContent, 1)
  }
  const joined = withoutRepeatedHeadings.join('\n')
  if ((joined.match(/\*\*/g) || []).length % 2 === 0) return joined
  const lastBold = joined.lastIndexOf('**')
  return lastBold >= 0 ? `${joined.slice(0, lastBold)}${joined.slice(lastBold + 2)}` : joined
}

export function normalizeModelText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split(/(```[\s\S]*?```)/g)
    .map((segment) =>
      segment.startsWith('```')
        ? segment
        : normalizeMarkdownOutsideCode(normalizeHtmlOutsideCode(segment))
    )
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
