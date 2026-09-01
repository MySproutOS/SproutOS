import fs from "node:fs"
import path from "node:path"
import { describe, expect, it, type Mock, vi } from "vitest"
import {
  CONTEXT7_LIBRARY,
  CONTEXT7_WIDGET_ID,
  CONTEXT7_WIDGET_SCRIPT_ID,
  CONTEXT7_WIDGET_SRC,
  installContext7Widget,
} from "./context7-widget"

type FakeElement = {
  addEventListener: (event: string, listener: () => void) => void
  async: boolean
  dataset: Record<string, string>
  id: string
  onLoad?: () => void
  remove: Mock<() => void>
  src: string
}

function fakeDocument() {
  const elements = new Map<string, FakeElement>()

  function element(id = ""): FakeElement {
    const node: FakeElement = {
      addEventListener: (_event, listener) => {
        node.onLoad = listener
      },
      async: false,
      dataset: {},
      id,
      remove: vi.fn<() => void>(() => {
        elements.delete(node.id)
      }),
      src: "",
    }
    if (id) elements.set(id, node)
    return node
  }

  const ownerDocument = {
    body: {
      appendChild: vi.fn<(node: FakeElement) => FakeElement>((node) => {
        elements.set(node.id, node)
        return node
      }),
    },
    createElement: vi.fn<() => FakeElement>(() => element()),
    getElementById: vi.fn<(id: string) => FakeElement | null>((id) => elements.get(id) ?? null),
  } as unknown as Document

  return { element, elements, ownerDocument }
}

describe("Context7 metadata", () => {
  it("publishes the exact verification payload", () => {
    const filename = path.join(__dirname, "../../../../../../public/docs/context7.json")
    expect(JSON.parse(fs.readFileSync(filename, "utf8"))).toEqual({
      url: "https://context7.com/websites/sproutos_me",
      public_key: "pk_TcXY1MFDq8BkHBZR5TEEe",
    })
  })
})

describe("installContext7Widget", () => {
  it("installs one asynchronous widget script with the SproutOS library", () => {
    const { element, elements, ownerDocument } = fakeDocument()
    const staleScript = element(CONTEXT7_WIDGET_SCRIPT_ID)
    const staleWidget = element(CONTEXT7_WIDGET_ID)

    installContext7Widget(ownerDocument)

    expect(staleScript.remove).toHaveBeenCalledOnce()
    expect(staleWidget.remove).toHaveBeenCalledOnce()
    const script = elements.get(CONTEXT7_WIDGET_SCRIPT_ID)
    expect(script).toMatchObject({
      async: true,
      dataset: { library: CONTEXT7_LIBRARY },
      src: CONTEXT7_WIDGET_SRC,
    })
  })

  it("removes the script and body-mounted widget on teardown", () => {
    const { element, elements, ownerDocument } = fakeDocument()
    const dispose = installContext7Widget(ownerDocument)
    const script = elements.get(CONTEXT7_WIDGET_SCRIPT_ID)
    const widget = element(CONTEXT7_WIDGET_ID)

    dispose()

    expect(script?.remove).toHaveBeenCalledOnce()
    expect(widget.remove).toHaveBeenCalledOnce()
    expect(elements.has(CONTEXT7_WIDGET_SCRIPT_ID)).toBe(false)
    expect(elements.has(CONTEXT7_WIDGET_ID)).toBe(false)
  })

  it("cleans up a widget appended after teardown", () => {
    const { element, elements, ownerDocument } = fakeDocument()
    const dispose = installContext7Widget(ownerDocument)
    const script = elements.get(CONTEXT7_WIDGET_SCRIPT_ID)

    dispose()
    const lateWidget = element(CONTEXT7_WIDGET_ID)
    script?.onLoad?.()

    expect(lateWidget.remove).toHaveBeenCalledOnce()
  })
})
