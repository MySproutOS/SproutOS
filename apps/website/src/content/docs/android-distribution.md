---
slug: android-distribution
title: Distribute an Android app
summary: Build an unsigned APK, let SproutOS protect the signing key, publish releases, and verify installs and updates.
audience: developer
category: Deploying
order: 4
---

SproutOS distributes Android apps directly from the website. It does not publish Google Play
tracks. A project uploads one raw unsigned APK; the on-premises signer produces the installable APK
without exposing the app signing private key to a developer machine, GitHub Actions, or the control
plane.

## Keep the application identity stable

Choose the Android application id before the first production release and do not change it. Every
update must use the same application id and signing identity, and its Android `versionCode` must be
greater than the installed release.

The SproutOS Android client uses `com.sproutos.store`. A different id is a different app to Android,
so it cannot update an existing installation in place.

Build a release APK that is deliberately unsigned. Do not upload an Android App Bundle (`.aab`), a
ZIP containing an APK, or an APK already signed by a developer key. The CLI validates this boundary
before uploading.

## Establish protected signing custody

An authorized project owner runs the Android setup command once:

```shell
sprout android setup my-android-app
sprout android status my-android-app
```

Setup creates or imports the project's signing identity through the protected signer. Treat this as
a custody operation: back up any permitted recovery material according to your organization policy,
restrict who can rotate it, and never commit keystores, passwords, or exported private keys.

Before the first public release, record and independently compare the certificate fingerprint:

```shell
sprout android verify my-android-app --commit <40-character-source-commit>
```

The verified source commit, application id, signing-certificate digest, version code, and artifact
digest form the release identity. A mismatch must fail closed; do not work around it by uninstalling
the existing app or accepting a new key.

## Publish from GitHub Actions

Build the unsigned APK, then pass the containing directory to the pinned Marketplace action:

```yaml
name: Publish Android app
on:
  push:
    tags: ["android-v*"]

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: "21"
      - uses: gradle/actions/setup-gradle@v4
      - run: ./gradlew assembleRelease
      - uses: MySproutOS/sproutos-deploy-action@0d5ce8bb74ecd598ae996c34d7d2cb5ac156a180
        with:
          preset: android
          directory: app/build/outputs/apk/release
          project: my-android-app
          api-url: https://api.sproutos.me
```

The directory must contain exactly one APK. The action authenticates with GitHub OIDC and passes a
short-lived, repository-bound token to the CLI; do not add a long-lived SproutOS secret. The same
artifact can be deployed locally with:

```shell
sprout deploy my-android-app --preset android \
  --path app/build/outputs/apk/release/app-release-unsigned.apk \
  --version-code 42
```

## Test installation and updating

Test the public user journey on a supported Android device or emulator before announcing a release:

1. Open the SproutOS Android client and authenticate.
2. Find the listing and check its title, summary, icon, screenshots, release version, download size,
   permissions, privacy/support links, and update notes.
3. Install it from the website-backed catalogue and launch the installed application.
4. Publish a higher `versionCode`, return to the listing, install the update, and confirm Android
   updates in place without changing the application id or losing app data.
5. Compare the installed certificate digest and artifact digest with the release record, then verify
   failed or superseded releases cannot be downloaded as current.

Exercise this flow with Mobile MCP in automated acceptance so tests interact with the same visible
screens a user does. Shell-only APK installation can diagnose a build, but it does not prove
authentication, catalogue discovery, listing content, download authorization, installer handoff,
launch, or update behavior.

If Android blocks the install, enable permission for the browser or SproutOS client to install
unknown apps and retry. Do not disable Android package verification. If an update reports a signing
conflict, stop: either the application id or protected signing identity changed.

## Prepare useful listing content

A launch-ready listing needs more than an APK. Provide a concise name and summary, an accurate full
description, a high-resolution icon, phone screenshots from the actual release, support and privacy
URLs, release notes, and explicit content/permission disclosures. Describe what the app does and
what data leaves the device; do not make claims the release cannot demonstrate.

Keep the listing tied to the same immutable source commit and artifact digest shown by release
verification. Test every link and screenshot at phone width, and repeat the full install/update
journey after changing signing, download authorization, catalogue metadata, or Android client code.
