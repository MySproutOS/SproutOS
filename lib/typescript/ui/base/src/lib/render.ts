import { isValidElement } from "react"

/**
 * Base UI's button-like parts default to assuming the `render` prop yields a
 * native `<button>`, and log a console error when it does not. Base UI has no
 * `asChild` (ADR 0008), so a link that looks like a button is always
 * `render={<Link />}` — an `<a>` — and every one of those call sites would
 * otherwise have to remember `nativeButton={false}`.
 *
 * Returns `undefined` when there is nothing to infer, so the primitive keeps its
 * own default.
 */
export function inferNativeButton(render: unknown): boolean | undefined {
  if (!isValidElement(render)) return undefined
  return render.type === "button"
}
