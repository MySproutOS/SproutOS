"use client"

import { useEffect } from "react"

export const CONTEXT7_WIDGET_ID = "context7-widget"
export const CONTEXT7_WIDGET_SCRIPT_ID = "context7-widget-script"
export const CONTEXT7_WIDGET_SRC = "https://context7.com/widget.js"
export const CONTEXT7_LIBRARY = "/mysproutos/sproutos"

/**
 * Context7 appends its widget directly to document.body and does not expose a teardown API.
 * Owning the script element here lets the docs layout remove that global element when a client-side
 * navigation leaves /docs, then execute a fresh script when the layout mounts again.
 */
export function installContext7Widget(ownerDocument: Document): () => void {
  ownerDocument.getElementById(CONTEXT7_WIDGET_ID)?.remove()
  ownerDocument.getElementById(CONTEXT7_WIDGET_SCRIPT_ID)?.remove()

  let disposed = false
  const script = ownerDocument.createElement("script")
  script.id = CONTEXT7_WIDGET_SCRIPT_ID
  script.src = CONTEXT7_WIDGET_SRC
  script.async = true
  script.dataset.library = CONTEXT7_LIBRARY
  script.addEventListener(
    "load",
    () => {
      // The script executes before its load event. If navigation won the race, remove anything it
      // appended after the effect cleanup ran.
      if (disposed) ownerDocument.getElementById(CONTEXT7_WIDGET_ID)?.remove()
    },
    { once: true },
  )
  ownerDocument.body.appendChild(script)

  return () => {
    disposed = true
    script.remove()
    ownerDocument.getElementById(CONTEXT7_WIDGET_ID)?.remove()
  }
}

export function Context7Widget() {
  useEffect(() => installContext7Widget(document), [])
  return null
}
