import { X } from 'lucide-react'
import { useEffect, useId, useRef } from 'react'

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  width = 'max-w-2xl'
}: {
  open: boolean
  title: string
  description?: string
  onClose: () => void
  children: React.ReactNode
  width?: string
}): React.JSX.Element | null {
  const dialogRef = useRef<HTMLElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement as HTMLElement | null
    const dialog = dialogRef.current
    const focusable = dialog?.querySelectorAll<HTMLElement>(
      'button, a[href], input, textarea, select, [tabindex]:not([tabindex="-1"])'
    )
    focusable?.[0]?.focus()
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
      if (event.key !== 'Tab' || !focusable?.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('keydown', closeOnEscape)
      previouslyFocused?.focus()
    }
  }, [onClose, open])

  if (!open) return null

  return (
    <div
      className="modal-backdrop fixed inset-0 z-[80] flex items-center justify-center p-6"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className={`native-popover flex max-h-[82vh] w-full ${width} flex-col overflow-hidden`}
      >
        <header className="flex flex-shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h2 id={titleId} className="text-sm font-semibold text-foreground">
              {title}
            </h2>
            {description && (
              <p
                id={descriptionId}
                className="mt-1 text-[11px] leading-relaxed text-muted-foreground"
              >
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            aria-label="Close dialog"
            className="native-titlebar-button"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        {children}
      </section>
    </div>
  )
}
