import { DeleteObjectCommand, ListObjectVersionsCommand, type S3Client } from "@aws-sdk/client-s3"

/** Delete every immutable version of one exact certificate object except explicitly retained ones. */
export async function deleteCertificateObjectVersions(
  s3: S3Client,
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
  await Promise.all(
    versionsToDelete.map((version) =>
      s3.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: version.key,
          VersionId: version.versionId,
        }),
      ),
    ),
  )
}
