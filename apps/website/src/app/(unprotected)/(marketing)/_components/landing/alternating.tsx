import { Reveal } from "@ui/spa-shared/reveal"
import type { ReactNode } from "react"

/**
 * One argument: prose on one side, a diagram on the other, alternating down the page.
 *
 * The landing page used to put three capabilities in three columns, which meant three headlines and
 * three paragraphs arriving at once — a wall of text with pictures in it. Giving each argument a
 * full row and flipping the side halves the reading load per screen without cutting anything.
 *
 * `flip` moves the diagram to the left. On small screens the grid collapses and the diagram always
 * follows its prose, whatever `flip` says — `order` is applied only from `lg` up, so the reading
 * order never depends on the viewport.
 */
export function AlternatingRow({
  eyebrow,
  title,
  children,
  diagram,
  flip = false,
}: {
  eyebrow: string
  title: string
  children: ReactNode
  diagram: ReactNode
  flip?: boolean
}) {
  return (
    <section className="border-t rule-soft py-20 sm:py-28">
      <div className="container-page grid items-center gap-12 lg:grid-cols-2 lg:gap-20">
        <Reveal className={flip ? "lg:order-2" : undefined}>
          <p className="eyebrow mb-4">{eyebrow}</p>
          <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.5rem] sm:leading-[1.1]">
            {title}
          </h2>
          <div className="mt-5 flex flex-col gap-4 text-lg text-muted-foreground text-pretty">
            {children}
          </div>
        </Reveal>
        <Reveal delay={80} className={flip ? "lg:order-1" : undefined}>
          {diagram}
        </Reveal>
      </div>
    </section>
  )
}
