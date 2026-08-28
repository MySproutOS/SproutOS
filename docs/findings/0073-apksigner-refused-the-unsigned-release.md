# Apksigner refused the unsigned release

## What was wrong

The signer used `apksigner verify` as a second check that an incoming APK was unsigned. It accepted
the older `No signatures` and `No signer` diagnostics, but the Android SDK's current `apksigner`
reports an ordinary unsigned Android Gradle Plugin release as:

```text
DOES NOT VERIFY
ERROR: Missing META-INF/MANIFEST.MF
```

The signer treated that exact output as an indeterminate tool failure. The real
`com.sproutos.store` release therefore could not pass the operator preflight or a signing job, even
though the ZIP/signing-block checks had already established that it contained no APK or JAR
signature.

## Why the checks caught it late

The unit test modeled `apksigner` with the older `No signatures` wording. The repository already
had an ignored real-toolchain test, but normal CI has no Android SDK or release APK and therefore
never runs it. The defect appeared only when the current SDK was exercised against the actual
unsigned catalogue-client build during the PR refresh.

This was not an item in `read-the-readme-md-to-eventual-dusk.md`, `double-sorted-meteor.md`,
`private_notes/groups.md`, or `private_notes/ADDITIONS_1.md`; it was found by executing the release
artifact through the boundary those plans depend on.

## What stops it coming back

The diagnostic parser now accepts the current exact missing-JAR-manifest wording alongside the
older no-signature forms. It still rejects every other non-zero tool result. Callers first reject
APK Signing Blocks, JAR signing metadata, traversal, wrappers, and malformed ZIP structure, and
then require `aapt2` to parse the Android manifest, so this additional diagnostic does not turn an
arbitrary `apksigner` failure into an unsigned APK.

The unit suite freezes the current diagnostic, and the ignored operator smoke signs and verifies a
real unsigned release with the installed Android SDK before a signer machine enters service.
