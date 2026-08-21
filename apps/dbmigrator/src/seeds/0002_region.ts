import type { Kysely } from "kysely"
import { uuidV7 } from "../lib/uuid"

/**
 * Where the platform can put things.
 *
 * The control plane lives on AWS; a customer chooses where their own backends and workflows run, so
 * a region is a `(provider, code)` pair rather than a code. `us-east-1` on AWS and `us-east-1` on
 * another cloud are different places, and the codes genuinely collide — Azure and GCP both use names
 * that look like AWS's.
 *
 * Only `us-east-1` is active. A region is active when there is a cluster in it, and marking one
 * active before then means `fetchPlacement` offers a customer somewhere their deployment cannot go.
 */
const REGIONS: [provider: string, code: string, displayName: string, isActive: boolean][] = [
  ["aws", "us-east-1", "AWS US East (N. Virginia)", true],
  ["aws", "us-west-2", "AWS US West (Oregon)", false],
  ["aws", "eu-west-1", "AWS Europe (Ireland)", false],
  ["gcp", "us-central1", "Google Cloud US Central (Iowa)", false],
  ["gcp", "europe-west1", "Google Cloud Europe West (Belgium)", false],
  ["azure", "eastus", "Azure East US (Virginia)", false],
  ["azure", "westeurope", "Azure West Europe (Netherlands)", false],
]

export async function seed(db: Kysely<any>): Promise<void> {
  await db
    .insertInto("region")
    .values(
      REGIONS.map(([provider, code, display_name, is_active]) => ({
        id: uuidV7(),
        provider,
        code,
        display_name,
        is_active,
      })),
    )
    // `(provider, code)`, matching the unique index. Naming only `code` here used to work and
    // stopped when that index was replaced — and `ON CONFLICT` with no matching index is a planning
    // error, so this fails loudly rather than seeding duplicates.
    .onConflict((oc) => oc.columns(["provider", "code"]).doNothing())
    .execute()
}
