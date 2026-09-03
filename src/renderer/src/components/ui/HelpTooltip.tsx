import { CircleHelp } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export default function HelpTooltip({
  text,
  label = 'More information',
  iconClassName = 'h-3.5 w-3.5'
}: {
  text: string
  label?: string
  iconClassName?: string
}): React.JSX.Element {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const tooltipId = useId()
  const [position, setPosition] = useState<{ left: number; top: number; above: boolean } | null>(
    null
  )

  const show = (): void => {
    const bounds = anchorRef.current?.getBoundingClientRect()
    if (!bounds) return
    const width = 224
    const left = Math.min(window.innerWidth - width - 12, Math.max(12, bounds.right - width))
    const above = bounds.top > 150
    setPosition({ left, top: above ? bounds.top - 8 : bounds.bottom + 8, above })
  }

  return (
    <>
      <button
        type="button"
        ref={anchorRef}
        role="button"
        tabIndex={0}
        className="no-drag inline-flex cursor-help text-muted-foreground/80 hover:text-foreground"
        aria-label={`${label}: ${text}`}
        aria-describedby={position ? tooltipId : undefined}
        onMouseEnter={show}
        onMouseLeave={() => setPosition(null)}
        onFocus={show}
        onBlur={() => setPosition(null)}
      >
        <CircleHelp className={iconClassName} />
      </button>
      {position &&
        createPortal(
          <span
            id={tooltipId}
            role="tooltip"
            className="native-popover pointer-events-none fixed z-[100] w-56 whitespace-pre-line rounded-lg px-2.5 py-2 text-left text-[11px] font-normal leading-relaxed text-popover-foreground"
            style={{
              left: position.left,
              top: position.top,
              transform: position.above ? 'translateY(-100%)' : undefined
            }}
          >
            {text}
          </span>,
          document.body
        )}
    </>
  )
}
