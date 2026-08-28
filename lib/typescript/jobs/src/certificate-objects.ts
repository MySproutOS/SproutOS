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
  do {
    const page = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: key,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      }),
    )
    const versions = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].filter(
      (version) =>
        version.Key === key &&
        version.VersionId !== undefined &&
        !keepVersions.has(version.VersionId),
    )
    await Promise.all(
      versions.map((version) =>
        s3.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: version.VersionId }),
        ),
      ),
    )
    keyMarker = page.NextKeyMarker
    versionIdMarker = page.NextVersionIdMarker
  } while (keyMarker !== undefined)
}
