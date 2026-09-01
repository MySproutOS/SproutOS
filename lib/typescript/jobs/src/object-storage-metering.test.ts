import { ListObjectVersionsCommand } from "@aws-sdk/client-s3"
import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  meterObjectStorage,
  objectStorageGbMonthSegments,
  objectStorageReserveMicroUsd,
  retainedObjectBytes,
} from "./object-storage-metering"

const databaseReady = await (async () => {
  try {
    await sql`select 1 from object_storage_metering_state limit 1`.execute(db)
    return true
  } catch {
    return false
  }
})()
const userId = v7()
const organizationId = v7()
const serviceId = v7()

beforeAll(async () => {
  if (!databaseReady) return
  const region = await db
    .selectFrom("region")
    .select("id")
    .where("code", "=", "us-east-1")
    .executeTakeFirstOrThrow()
  await db
    .insertInto("user")
    .values({ id: userId, email: `object-meter-${userId}@test.invalid` })
    .execute()
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "Object Meter",
      slug: `object-meter-${organizationId.slice(-12)}`,
      kind: "team",
      ownerUserId: userId,
    })
    .execute()
  await db
    .insertInto("backendService")
    .values({
      id: serviceId,
      organizationId,
      regionId: region.id,
      name: "Metered objects",
      kind: "object_storage",
      status: "active",
    })
    .execute()
})

afterAll(async () => {
  if (!databaseReady) return
  await db
    .deleteFrom("meteringOutbox")
    .where(sql<boolean>`payload ->> 'resource_id' = ${serviceId}`)
    .execute()
  await db
    .deleteFrom("objectStorageMeteringState")
    .where("backendServiceId", "=", serviceId)
    .execute()
  await db.deleteFrom("backendService").where("id", "=", serviceId).execute()
  await db.deleteFrom("organization").where("id", "=", organizationId).execute()
  await db.deleteFrom("user").where("id", "=", userId).execute()
})

describe("object-storage residency accounting", () => {
  it("uses the actual UTC month length", () => {
    const february = objectStorageGbMonthSegments(
      1_000_000_000n,
      new Date("2028-02-01T00:00:00Z"),
      new Date("2028-03-01T00:00:00Z"),
    )
    expect(february).toEqual([
      {
        from: new Date("2028-02-01T00:00:00Z"),
        to: new Date("2028-03-01T00:00:00Z"),
        quantity: "1",
      },
    ])
  })

  it("splits a boundary rather than applying one month's denominator to both sides", () => {
    const segments = objectStorageGbMonthSegments(
      1_000_000_000n,
      new Date("2026-02-28T12:00:00Z"),
      new Date("2026-03-01T12:00:00Z"),
    )
    expect(segments).toHaveLength(2)
    expect(segments[0]?.quantity).toBe("0.017857142")
    expect(segments[1]?.quantity).toBe("0.016129032")
  })

  it("rounds the protected two-day floor up to a whole micro-dollar", () => {
    expect(
      objectStorageReserveMicroUsd(1_000_000_000n, 23_000n, new Date("2026-08-15T00:00:00Z")),
    ).toBe(1_484n)
    expect(objectStorageReserveMicroUsd(1n, 23_000n, new Date("2026-08-15T00:00:00Z"))).toBe(1n)
    expect(objectStorageReserveMicroUsd(0n, 23_000n, new Date())).toBe(0n)
  })

  it("counts every retained version across pages and ignores delete markers", async () => {
    const commands: ListObjectVersionsCommand[] = []
    const pages = [
      {
        Versions: [{ Size: 10 }, { Size: 20 }],
        IsTruncated: true,
        NextKeyMarker: "second",
        NextVersionIdMarker: "v2",
      },
      { Versions: [{ Size: 30 }], DeleteMarkers: [{}], IsTruncated: false },
    ]
    const s3 = {
      send: (command: ListObjectVersionsCommand) => {
        commands.push(command)
        return Promise.resolve(pages.shift()!)
      },
    }

    await expect(retainedObjectBytes(s3, "physical", "v-tenant/")).resolves.toBe(60n)
    expect(commands).toHaveLength(2)
    expect(commands[1]?.input).toMatchObject({
      Bucket: "physical",
      Prefix: "v-tenant/",
      KeyMarker: "second",
      VersionIdMarker: "v2",
    })
  })

  it("refuses a truncated provider page with no continuation marker", async () => {
    await expect(
      retainedObjectBytes(
        {
          send: () => Promise.resolve({ IsTruncated: true }),
        },
        "physical",
        "v-tenant/",
      ),
    ).rejects.toThrow("without a continuation marker")
  })
})

describe.runIf(databaseReady)("object-storage metering watermark", () => {
  it("charges only an interval bracketed by two successful inventories", async () => {
    const s3 = {
      send: () => Promise.resolve({ Versions: [{ Size: 1_000_000_000 }], IsTruncated: false }),
    }
    const first = new Date("2026-08-01T00:00:00Z")
    await expect(
      meterObjectStorage(db, {
        now: first,
        s3,
        sharedBucket: "physical",
        backendServiceId: serviceId,
      }),
    ).resolves.toBe(0)

    const second = new Date("2026-08-01T01:00:00Z")
    await expect(
      meterObjectStorage(db, {
        now: second,
        s3,
        sharedBucket: "physical",
        backendServiceId: serviceId,
      }),
    ).resolves.toBe(1)
    const outbox = await db
      .selectFrom("meteringOutbox")
      .select("payload")
      .where(sql<boolean>`payload ->> 'source' = 's3-version-inventory'`)
      .executeTakeFirstOrThrow()
    const payload = outbox.payload as { dimension: string; quantity: string }
    expect(payload.dimension).toBe("object_storage_gb_month")
    expect(Number(payload.quantity)).toBeCloseTo(1 / (31 * 24), 9)
  })
})
