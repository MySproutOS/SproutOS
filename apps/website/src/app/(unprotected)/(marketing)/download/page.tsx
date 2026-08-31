import Link from "next/link"
import { cliPlatformLabel, latestCliRelease } from "./cli-release"
import { latestAndroidClientRelease } from "./android-client-release"

export const metadata = {
  title: "Get SproutOS for Android · SproutOS",
  description:
    "Install the SproutOS Android client to run the apps you have published and the ones other people have.",
}

export const dynamic = "force-dynamic"

/**
 * The download page for the Android client (§12.1).
 *
 * ## Why this page has instructions on it
 *
 * The client is not on Google Play, so installing it means enabling a permission Android calls
 * "install unknown apps" and shows a warning for. That warning is correct — it is exactly the
 * permission malware asks for — and a download page that skipped past it would be teaching people
 * to click through the thing that protects them.
 *
 * So the steps are written out, the warning is named rather than hidden, and the fingerprint is on
 * the page so somebody who wants to check what they downloaded can.
 */

const STEPS = [
  "Download the APK using the button above.",
  "Open it. Android will say it cannot install apps from this source — that warning is about the browser you downloaded it with, not about the file.",
  "Tap Settings in the warning, and allow that browser to install apps.",
  "Go back and open the download again. It will install.",
  "You can turn the permission off again afterwards. Updates are offered inside the app.",
] as const

export default async function DownloadPage() {
  const [release, cliRelease] = await Promise.all([
    latestAndroidClientRelease(),
    latestCliRelease(),
  ])

  return (
    <div className="container-page py-16">
      <h1 className="text-3xl font-semibold">SproutOS for Android</h1>
      <p className="mt-2 max-w-2xl text-muted-foreground">
        Your own apps and the ones other people have published, in one place. Websites you have
        deployed are here too.
      </p>

      <div className="mt-8">
        {release === null ? (
          <p className="rounded-md border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
            There is no published build yet. This page will offer one as soon as there is.
          </p>
        ) : (
          <a
            href={release.downloadUrl}
            className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Download {release.versionName}
          </a>
        )}
      </div>

      {release === null ? null : (
        <div className="mt-4 max-w-2xl space-y-1 font-mono text-xs break-all text-muted-foreground">
          <p>sha256 {release.sha256}</p>
          <p>certificate sha256 {release.certificateSha256}</p>
        </div>
      )}

      <section className="mt-12 max-w-2xl">
        <h2 className="text-lg font-medium">Installing it</h2>
        <p className="mt-3 text-muted-foreground">
          SproutOS is not on Google Play, so Android will warn you before installing it. That
          warning is doing its job — it is the same one you should heed for a file you did not
          expect. These steps are what it takes to say yes deliberately.
        </p>
        <ol className="mt-4 list-decimal space-y-2 pl-5 text-muted-foreground">
          {STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </section>

      <section className="mt-12 max-w-2xl">
        <h2 className="text-lg font-medium">Sprout CLI</h2>
        {cliRelease === null ? (
          <p className="mt-3 text-muted-foreground">
            Command-line downloads will appear here with their checksums after the first release.
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            <p className="text-muted-foreground">Version {cliRelease.version}</p>
            <ul className="space-y-3">
              {cliRelease.assets.map((asset) => (
                <li key={asset.target} className="rounded-md border border-border bg-card p-3">
                  <a href={asset.url} className="font-medium text-primary hover:underline">
                    {cliPlatformLabel(asset)}
                  </a>
                  <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
                    sha256 {asset.sha256}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="mt-12 max-w-2xl">
        <h2 className="text-lg font-medium">Who signed it</h2>
        <p className="mt-3 text-muted-foreground">
          Every app distributed through SproutOS, including this one, is signed by us — we are the
          developer of record. That is what lets somebody publish without their own Play Console
          account, and it means we are accountable for what is distributed under our name. Our{" "}
          <Link href="/legal/terms" className="text-primary hover:underline">
            Terms of Service
          </Link>{" "}
          set out what we will and will not publish.
        </p>
      </section>

      <section className="mt-12 max-w-2xl">
        <h2 className="text-lg font-medium">iPhone</h2>
        <p className="mt-3 text-muted-foreground">
          There is no iOS client and there is not going to be one soon. Apple does not permit an app
          that installs other apps, so the equivalent would have to be a web app — which is what
          your deployed sites already are. Open them in Safari and add them to your home screen.
        </p>
      </section>
    </div>
  )
}
