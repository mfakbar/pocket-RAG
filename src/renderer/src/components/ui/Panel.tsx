import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'

const Panel = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement> & {
    children: ReactNode
  }
>(function Panel({ children, className = '', ...props }, ref) {
  return (
    <div ref={ref} className={`native-surface ${className}`} {...props}>
      {children}
    </div>
  )
})

export default Panel
