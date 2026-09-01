import { AndroidBadge } from "../_components/store-badge"
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

/**
 * A failed lookup is not a missing build.
 *
 * `latestAndroidClientRelease` returns `null` for "nothing published yet" and throws for anything
 * else, which is the right shape for the function — a 500 from the control plane really is
 * different from an empty catalogue, and swallowing it would hide an outage.
 *
 * It is the wrong shape for this *page*, though. Most of what is here — how personalization works,
 * what it takes to list an app, who signs it, how to sideload — does not depend on the release at
 * all, and letting the lookup throw takes all of it down with the download button. So the failure
 * is contained to the one region that needs the answer, and reported honestly rather than dressed
 * up as "no build yet".
 */
const UNAVAILABLE = "unavailable"

async function settle<T>(work: Promise<T>): Promise<T | typeof UNAVAILABLE> {
  try {
    return await work
  } catch {
    return UNAVAILABLE
  }
}

export default async function DownloadPage() {
  const [release, cliRelease] = await Promise.all([
    settle(latestAndroidClientRelease()),
    settle(latestCliRelease()),
  ])

  return (
    <div className="container-page py-16">
      <h1 className="text-3xl font-semibold">SproutOS for Android</h1>
      <p className="mt-2 max-w-2xl text-muted-foreground">
        Your own apps and the ones other people have published, in one place. Websites you have
        deployed are here too.
      </p>

      <div className="mt-8">
        {release === UNAVAILABLE ? (
          <p className="rounded-md border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
            The download is temporarily unavailable — we could not reach the release service. Please
            try again shortly.
          </p>
        ) : release === null ? (
          <p className="rounded-md border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
            There is no published build yet. This page will offer one as soon as there is.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-5">
            <AndroidBadge href={release.downloadUrl} tone="filled" external />
            <p className="font-mono text-xs leading-relaxed text-muted-foreground">
              {release.versionName}
              <br />
              checksums below
            </p>
          </div>
        )}
      </div>

      {release === null || release === UNAVAILABLE ? null : (
        <div className="mt-4 max-w-2xl space-y-1 font-mono text-xs break-all text-muted-foreground">
          <p>sha256 {release.sha256}</p>
          <p>certificate sha256 {release.certificateSha256}</p>
        </div>
      )}

      <section className="mt-16">
        <p className="eyebrow mb-4">Personalizing Android apps</p>
        <h2 className="max-w-2xl font-display text-2xl font-semibold tracking-tight text-balance">
          Android apps personalize the same way websites do.
        </h2>
        <div className="mt-7 grid gap-5 sm:grid-cols-2">
          <div className="rounded-2xl border rule-soft bg-card/60 p-6">
            <p className="mb-3 font-mono text-xs tracking-[0.04em] text-primary">START FROM ONE</p>
            <h3 className="font-display text-lg font-semibold tracking-tight">
              Fork an open source Android app
            </h3>
            <p className="mt-2.5 text-sm text-muted-foreground text-pretty">
              Pick one from the store, say what you want changed, and get your own build — the same
              sentence-sized change you would make to a web app.
            </p>
          </div>
          <div className="rounded-2xl border rule-soft bg-card/60 p-6">
            <p className="mb-3 font-mono text-xs tracking-[0.04em] text-primary">OR START EMPTY</p>
            <h3 className="font-display text-lg font-semibold tracking-tight">
              Build one from the ground up
            </h3>
            <p className="mt-2.5 text-sm text-muted-foreground text-pretty">
              Describe the app you want and it is built, signed and installable — no Play Console
              account, and no Android toolchain on your machine.
            </p>
          </div>
        </div>
      </section>

      <section className="mt-16">
        <p className="eyebrow mb-4">For Android developers</p>
        <h2 className="max-w-2xl font-display text-2xl font-semibold tracking-tight text-balance">
          Two ways to be in the store.
        </h2>
        <div className="mt-7 grid gap-5 sm:grid-cols-2">
          <div className="rounded-2xl border border-primary/45 bg-primary/6 p-6">
            <h3 className="font-display text-lg font-semibold tracking-tight">Open source</h3>
            <p className="mt-2.5 text-sm text-muted-foreground text-pretty">
              Listed for download <span className="text-foreground">and</span> for personalization —
              other people can fork it the way they fork anything else in the store.
            </p>
            <ul className="mt-4 flex flex-col gap-2 border-t rule-soft pt-4 text-sm text-muted-foreground">
              <li>We build and sign the APK</li>
              <li>Forkable by anyone</li>
              <li>Distributed from sproutos.me</li>
            </ul>
          </div>
          <div className="rounded-2xl border rule-soft bg-card/60 p-6">
            <h3 className="font-display text-lg font-semibold tracking-tight">Closed source</h3>
            <p className="mt-2.5 text-sm text-muted-foreground text-pretty">
              Listed too, on one condition: it has to support{" "}
              <span className="text-foreground">standalone SproutOS databases</span>, so the people
              using it keep their own data and can leave with it.
            </p>
            <ul className="mt-4 flex flex-col gap-2 border-t rule-soft pt-4 text-sm text-muted-foreground">
              <li>Users own their data</li>
              <li>Not forkable — there is no source</li>
              <li>
                Not signed or hosted by us <span className="text-primary">*</span>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-5 rounded-xl border border-dashed rule-soft p-6">
          <p className="text-sm leading-relaxed text-muted-foreground text-pretty">
            <span className="font-medium text-foreground">Everything we sign, we can read.</span>{" "}
            Every app distributed through SproutOS is signed by us — we are the developer of record,
            which is what lets somebody publish without their own Play Console account or a D-U-N-S
            number. That is only a responsibility we can carry for code we can see, so{" "}
            <span className="text-foreground">apps uploaded to our store must be open source.</span>
          </p>
        </div>
        <p className="mt-3.5 text-xs leading-relaxed text-muted-foreground text-pretty">
          <span className="text-primary">*</span> Signing closed-source apps is on the roadmap — the
          review process that would let us stand behind code we cannot read is not built yet.
        </p>
      </section>

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
        {cliRelease === UNAVAILABLE ? (
          <p className="mt-3 text-muted-foreground">
            Command-line downloads are temporarily unavailable.
          </p>
        ) : cliRelease === null ? (
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
