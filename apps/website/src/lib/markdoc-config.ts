import { type Config, nodes, Tag } from "@markdoc/markdoc"

/*
  The Markdoc schema for the documentation, in one place.

  ## Why Markdoc here and `react-markdown` still in the store

  The store renders a *listing's* description — text we did not write, from a repository we do not
  control. `react-markdown` without `rehype-raw` is the right tool there precisely because it is a
  sandbox: it cannot be extended by the content.

  The docs are the opposite. We write them, we want components in them, and we want the rendered
  headings and the table of contents to be derived from the same tree rather than computed twice
  from the same string by two functions that can drift. Markdoc gives a transform step that produces
  a JSON-serializable tree, which is exactly the seam that makes "render once, describe once"
  possible.

  Markdoc ignores raw HTML unless it is explicitly enabled, so the safety posture the store's
  README argues for is preserved by default rather than by remembering to omit a plugin.
*/

/**
 * A heading's anchor.
 *
 * The id has to be stable across builds and identical to the one the table of contents links to.
 * Both now come from this function applied to the same transformed children, so a heading whose
 * text contains punctuation cannot end up with a contents entry that scrolls nowhere.
 */
export function headingId(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

/** The plain text of a transformed heading's children, for both the id and the contents list. */
function headingText(children: unknown[]): string {
  return children
    .map((child) => {
      if (typeof child === "string") return child
      if (typeof child === "number") return child.toString()
      if (child instanceof Tag) return headingText(child.children)
      return ""
    })
    .join("")
}

/*
  Images in a post.

  A Markdoc *tag* rather than plain `![alt](src)`, because `next/image` needs intrinsic dimensions
  to reserve space, and markdown syntax has nowhere to put them. Without them every figure is a
  layout shift on a page whose whole job is to be read.

  Files live in `public/blog/`, so `src` is a normal absolute path the browser can fetch and the
  optimizer can read from disk.
*/
export const tags: Config["tags"] = {
  image: {
    render: "PostImage",
    selfClosing: true,
    attributes: {
      src: { type: String, required: true },
      alt: { type: String, required: true },
      width: { type: Number, required: true },
      height: { type: Number, required: true },
      caption: { type: String },
    },
  },
}

export const config: Config = {
  tags,
  nodes: {
    /*
      The document node renders an `<article>` by default, and the page already provides one around
      the title, the prose and the pager. Returning the children directly gives one `<article>` per
      page instead of an `<article>` nested inside an `<article>` — valid HTML, but it tells a
      reader and a crawler that the page contains two independent works.
    */
    document: {
      ...nodes.document,
      transform(node, transformConfig) {
        return node.transformChildren(transformConfig)
      },
    },
    heading: {
      ...nodes.heading,
      attributes: {
        id: { type: String },
        level: { type: Number, required: true, default: 1 },
      },
      transform(node, transformConfig) {
        const attributes = node.transformAttributes(transformConfig)
        const children = node.transformChildren(transformConfig)
        const level = Number(node.attributes.level ?? 2)
        const id =
          typeof attributes.id === "string" ? attributes.id : headingId(headingText(children))

        /*
          Rendered as a named component rather than a bare `h2` so the anchor styling and the
          scroll offset for the fixed header live with the component instead of being repeated in
          a `prose-headings:` selector.
        */
        return new Tag("Heading", { ...attributes, id, level }, children)
      },
    },
    link: {
      ...nodes.link,
      transform(node, transformConfig) {
        const attributes = node.transformAttributes(transformConfig)
        const children = node.transformChildren(transformConfig)
        return new Tag("DocLink", attributes, children)
      },
    },
    fence: {
      ...nodes.fence,
      attributes: {
        content: { type: String, render: false },
        language: { type: String },
        process: { type: Boolean, render: false, default: false },
      },
      transform(node, transformConfig) {
        const attributes = node.transformAttributes(transformConfig)
        const language: unknown = attributes.language
        return new Tag(
          "CodeBlock",
          { language: typeof language === "string" ? language : undefined },
          // `process: false` above keeps interpolation out of code samples, so the fence body is a
          // plain string and a `{% %}` in a YAML example is not read as a Markdoc tag.
          [String(node.attributes.content ?? "")],
        )
      },
    },
  },
}
