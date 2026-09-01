import "server-only"

import type { RenderableTreeNode } from "@markdoc/markdoc"
import { GENERATED_DOC_CONTENT } from "./docs-content.generated"

/*
  The Markdoc renderable trees, kept away from the browser.

  `import "server-only"` is the enforcement, not the comment: if a client component ever imports
  this — directly, or through a module that ends up in a `"use client"` graph — the build fails with
  a message naming the import chain, rather than silently adding the whole corpus to a bundle
  somebody notices six months later in a Lighthouse report.

  The trees are JSON, produced at build time by `scripts/generate-docs.ts`. Nothing parses Markdoc
  at request time.
*/

export function docContent(slug: string): RenderableTreeNode[] | undefined {
  return GENERATED_DOC_CONTENT[slug]
}
