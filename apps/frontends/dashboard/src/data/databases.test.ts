import { describe, expect, it } from "vitest"
import { parseObjectStorageConnection } from "./databases"

describe("object-storage connection display", () => {
  it("shows every AWS SDK setting carried by the Livesync-compatible URI", () => {
    expect(
      parseObjectStorageConnection(
        "sls+s3://SPROUTKEY:secret%3Avalue@storage.example.com?endpoint=https%3A%2F%2Fstorage.example.com&bucket=v-tenant&region=us-east-1",
      ),
    ).toEqual({
      endpoint: "https://storage.example.com",
      port: 443,
      bucket: "v-tenant",
      region: "us-east-1",
      accessKeyId: "SPROUTKEY",
      secretAccessKey: "secret:value",
      forcePathStyle: true,
    })
  })
})
