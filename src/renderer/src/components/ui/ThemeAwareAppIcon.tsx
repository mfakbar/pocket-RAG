import { useEffect, useState } from 'react'
import lightIcon from '../../assets/pocketai-icon-light.svg'
import darkIcon from '../../assets/pocketai-icon-dark.svg'

export function ThemeAwareAppIcon({
  alt = 'RavnDock',
  className = ''
}: {
  alt?: string
  className?: string
}): React.JSX.Element {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))

  useEffect(() => {
    const observer = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains('dark'))
    )
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  return <img src={dark ? darkIcon : lightIcon} alt={alt} className={className} />
}
