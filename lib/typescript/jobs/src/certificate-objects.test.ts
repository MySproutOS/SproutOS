import { DeleteObjectsCommand, ListObjectVersionsCommand } from "@aws-sdk/client-s3"
import { describe, expect, it, vi } from "vitest"
import { deleteCertificateObjectVersions } from "./certificate-objects"

describe("certificate object version cleanup", () => {
  it("deletes orphan versions and markers while retaining only the recorded serving versions", async () => {
    let page = 0
    const send = vi.fn<(command: unknown) => Promise<unknown>>((command) => {
      if (!(command instanceof ListObjectVersionsCommand)) return Promise.resolve({})
      page++
      return Promise.resolve(
        page === 1
          ? {
              Versions: [
                { Key: "custom-domains/id/current.json", VersionId: "current" },
                { Key: "custom-domains/id/current.json", VersionId: "put-before-db-crash" },
                { Key: "custom-domains/id/current.json.extra", VersionId: "different-key" },
              ],
              DeleteMarkers: [{ Key: "custom-domains/id/current.json", VersionId: "marker" }],
              NextKeyMarker: "custom-domains/id/current.json",
              NextVersionIdMarker: "marker",
            }
          : { Versions: [{ Key: "custom-domains/id/current.json", VersionId: "older" }] },
      )
    })

    await deleteCertificateObjectVersions(
      { send },
      "certificates",
      "custom-domains/id/current.json",
      new Set(["current"]),
    )

    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(ListObjectVersionsCommand)
    const secondPage = send.mock.calls[1]?.[0]
    expect(secondPage).toBeInstanceOf(ListObjectVersionsCommand)
    expect((secondPage as ListObjectVersionsCommand).input).toMatchObject({
      KeyMarker: "custom-domains/id/current.json",
      VersionIdMarker: "marker",
    })
    const deletion = send.mock.calls[2]?.[0]
    expect(deletion).toBeInstanceOf(DeleteObjectsCommand)
    expect((deletion as DeleteObjectsCommand).input.Delete?.Objects).toEqual([
      { Key: "custom-domains/id/current.json", VersionId: "put-before-db-crash" },
      { Key: "custom-domains/id/current.json", VersionId: "marker" },
      { Key: "custom-domains/id/current.json", VersionId: "older" },
    ])
  })

  it("fails cleanup when S3 retains any private-key version", async () => {
    const send = vi.fn<(command: unknown) => Promise<unknown>>((command) =>
      Promise.resolve(
        command instanceof ListObjectVersionsCommand
          ? { Versions: [{ Key: "custom-domains/id/current.json", VersionId: "private-key" }] }
          : {
              Errors: [
                {
                  Key: "custom-domains/id/current.json",
                  VersionId: "private-key",
                  Code: "AccessDenied",
                },
              ],
            },
      ),
    )

    await expect(
      deleteCertificateObjectVersions({ send }, "certificates", "custom-domains/id/current.json"),
    ).rejects.toThrow("custom-domains/id/current.json@private-key: AccessDenied")
  })
})
