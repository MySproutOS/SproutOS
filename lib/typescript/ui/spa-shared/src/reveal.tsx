"use client"

import { clsx } from "clsx"
import { useEffect, useMemo, useRef, useState } from "react"

/**
 * Returns props to spread onto whatever element should fade in on scroll.
 * A hook rather than a wrapper component so sections can reveal a <li> or
 * <section> directly instead of nesting an extra <div> inside their grid.
 */
export function useReveal(delay = 0) {
  const ref = useRef<HTMLElement>(null)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    const node = ref.current
    if (!node) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setShown(true)
          observer.disconnect()
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.05 },
    )
    observer.observe(node)
    return () => {
      observer.disconnect()
    }
  }, [])

  return { ref, shown, delay }
}

export function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: React.ReactNode
  className?: string
  delay?: number
}) {
  const { ref, shown } = useReveal(delay)
  const style = useMemo(() => (delay ? { transitionDelay: `${delay}ms` } : undefined), [delay])

  return (
    <div
      ref={ref as React.RefObject<HTMLDivElement>}
      className={clsx("reveal", shown && "is-in", className)}
      style={style}
    >
      {children}
    </div>
  )
}

export function RevealItem({
  children,
  className,
  delay = 0,
}: {
  children: React.ReactNode
  className?: string
  delay?: number
}) {
  const { ref, shown } = useReveal(delay)
  const style = useMemo(() => (delay ? { transitionDelay: `${delay}ms` } : undefined), [delay])

  return (
    <li
      ref={ref as React.RefObject<HTMLLIElement>}
      className={clsx("reveal", shown && "is-in", className)}
      style={style}
    >
      {children}
    </li>
  )
}
