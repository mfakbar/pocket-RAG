import { Hash, ListTree, Sparkles } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { normalizeModelText } from '../../../../shared/model-text'

function formatCitationMarkers(content: string, prefix: string, sourceCount: number): string {
  return content.replace(/\[(\d+(?:\s*,\s*\d+)*)\](?!\()/g, (_marker, numbers: string) => {
    return numbers
      .split(',')
      .map((value) => value.trim())
      .filter((number) => {
        const index = Number(number)
        return index > 0 && index <= sourceCount
      })
      .map((number) => `[${number}](#${prefix}-${number})`)
      .join(' ')
  })
}

export function MarkdownAnswer({
  content,
  citationPrefix,
  sourceCount
}: {
  content: string
  citationPrefix: string
  sourceCount: number
}): React.JSX.Element {
  return (
    <div className="chat-markdown text-[12px] leading-6 text-foreground">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mt-5 mb-2 flex items-center gap-2 text-base font-semibold first:mt-0">
              <Sparkles className="h-4 w-4 flex-shrink-0 text-violet-400" />
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-5 mb-2 flex items-center gap-2 text-[15px] font-semibold first:mt-0">
              <ListTree className="h-4 w-4 flex-shrink-0 text-primary" />
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-4 mb-1.5 flex items-center gap-2 text-[13px] font-semibold first:mt-0">
              <Hash className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4 className="mt-3 mb-1 text-[12px] font-semibold first:mt-0">{children}</h4>
          ),
          h5: ({ children }) => (
            <h5 className="mt-3 mb-1 text-[12px] font-semibold first:mt-0">{children}</h5>
          ),
          h6: ({ children }) => (
            <h6 className="mt-3 mb-1 text-[12px] font-semibold first:mt-0">{children}</h6>
          ),
          p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
          strong: ({ children }) => (
            <strong className="font-bold text-foreground">{children}</strong>
          ),
          ul: ({ children }) => (
            <ul className="my-2 list-disc space-y-1 pl-5 marker:text-muted-foreground">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="my-2 list-decimal space-y-1 pl-5 marker:font-medium marker:text-muted-foreground">
              {children}
            </ol>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-3 border-l-2 border-violet-400 bg-violet-400/[0.07] px-3 py-2 text-foreground/80">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-4 border-border" />,
          a: ({ children, href }) =>
            href?.startsWith('#source-') ? (
              <a
                href={href}
                className="citation-marker mx-0.5 inline-block align-super text-[9px] font-semibold leading-none no-underline"
                title="Go to source"
              >
                [{children}]
              </a>
            ) : (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-foreground"
              >
                {children}
              </a>
            ),
          pre: ({ children }) => (
            <pre className="my-3 overflow-x-auto rounded-lg border border-border bg-secondary p-3 font-mono text-xs leading-5">
              {children}
            </pre>
          ),
          code: ({ children, className }) => (
            <code
              className={`${className ?? ''} rounded bg-secondary px-1 py-0.5 font-mono text-[11px] text-foreground`}
            >
              {children}
            </code>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-lg border border-border">
              <table className="w-full border-collapse text-left text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-border bg-secondary px-3 py-2 font-semibold text-foreground">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-white/[0.06] px-3 py-2 align-top last:border-b-0">
              {children}
            </td>
          )
        }}
      >
        {formatCitationMarkers(normalizeModelText(content), citationPrefix, sourceCount)}
      </ReactMarkdown>
    </div>
  )
}
