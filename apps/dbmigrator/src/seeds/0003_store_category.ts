import type { Kysely } from "kysely"
import { uuidV7 } from "../lib/uuid"

const CATEGORIES: [slug: string, name: string, description: string, sortOrder: number][] = [
  [
    "personal-tools",
    "Personal Tools",
    "Bookmarks, notes, read-later, and other one-user apps.",
    10,
  ],
  ["productivity", "Productivity", "Task tracking, planning boards, and team coordination.", 20],
  ["publishing", "Publishing", "Blogs, docs sites, and content-first starters.", 30],
  ["data-and-rag", "Data & RAG", "Retrieval, embeddings, and query interfaces over your data.", 40],
  ["automation", "Automation", "Workflow templates, schedulers, and integration glue.", 50],
]

export async function seed(db: Kysely<any>): Promise<void> {
  await db
    .insertInto("store_category")
    .values(
      CATEGORIES.map(([slug, name, description, sort_order]) => ({
        id: uuidV7(),
        slug,
        name,
        description,
        sort_order,
      })),
    )
    .onConflict((oc) => oc.column("slug").doNothing())
    .execute()
}
