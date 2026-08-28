import { DeleteObjectsCommand, ListObjectVersionsCommand, type S3Client } from "@aws-sdk/client-s3"

/** Delete every immutable version of one exact certificate object except explicitly retained ones. */
export async function deleteCertificateObjectVersions(
  s3: Pick<S3Client, "send">,
  bucket: string,
  key: string,
  keepVersions: ReadonlySet<string> = new Set(),
): Promise<void> {
  let keyMarker: string | undefined
  let versionIdMarker: string | undefined
  const versionsToDelete: Array<{ key: string; versionId: string }> = []
  do {
    const page = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: key,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      }),
    )
    versionsToDelete.push(
      ...[...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].flatMap((version) =>
        version.Key === key &&
        version.VersionId !== undefined &&
        !keepVersions.has(version.VersionId)
          ? [{ key: version.Key, versionId: version.VersionId }]
          : [],
      ),
    )
    keyMarker = page.NextKeyMarker
    versionIdMarker = page.NextVersionIdMarker
  } while (keyMarker !== undefined)

  // Collect every page before deleting anything. S3's continuation markers identify versions in
  // the current listing; deleting a marker version before requesting the next page can invalidate
  // the traversal and silently leave an older private key behind.
  for (let offset = 0; offset < versionsToDelete.length; offset += 1000) {
    const batch = versionsToDelete.slice(offset, offset + 1000)
    // eslint-disable-next-line no-await-in-loop -- bounded S3 batches avoid 1,000 concurrent requests.
    const deleted = await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: batch.map((version) => ({
            Key: version.key,
            VersionId: version.versionId,
          })),
          Quiet: true,
        },
      }),
    )
    if ((deleted.Errors?.length ?? 0) > 0) {
      const failures = deleted
        .Errors!.map(
          (error) =>
            `${error.Key ?? key}@${error.VersionId ?? "unknown version"}: ${error.Code ?? "unknown error"}`,
        )
        .join(", ")
      throw new Error(`S3 failed to delete certificate versions: ${failures}`)
    }
  }
}
