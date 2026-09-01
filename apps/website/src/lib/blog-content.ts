import "server-only"

import type { RenderableTreeNode } from "@markdoc/markdoc"
import { GENERATED_POST_CONTENT } from "./blog-content.generated"

/*
  Post bodies, kept out of the browser bundle.

  `import "server-only"` is the enforcement rather than the comment: an accidental import from a
  client component fails the build with the offending chain named, instead of quietly shipping every
  post to every visitor.
*/

export function postContent(slug: string): RenderableTreeNode[] | undefined {
  return GENERATED_POST_CONTENT[slug]
}
