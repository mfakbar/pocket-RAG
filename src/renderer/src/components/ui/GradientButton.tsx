import type { ButtonHTMLAttributes, ReactNode } from 'react'

export default function GradientButton({
  children,
  className = '',
  style = {},
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }): React.JSX.Element {
  return (
    <button
      {...props}
      className={`primary-action tactile-control ${className}`}
      style={{
        ...style
      }}
    >
      {children}
    </button>
  )
}
