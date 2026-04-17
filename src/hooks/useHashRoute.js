import { useEffect, useState } from 'react'

export function useHashRoute(parse) {
  const [route, setRoute] = useState(parse)
  useEffect(() => {
    const on = () => setRoute(parse())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [parse])
  return route
}
