import { describe, expect, it } from "vitest"
import {
  type AndroidApp,
  type AppRow,
  buildCatalogue,
  CATALOGUE_TTL_SECONDS,
  isReadable,
  latestPerPackage,
  toApp,
  toClientUpdate,
} from "./android-index"

const signedUrlFor = (key: string) => `https://cdn.example/${key}?sig=abc`

function row(overrides: Partial<AppRow> = {}): AppRow {
  return {
    androidAppId: "01900000-0000-7000-8000-000000000001",
    projectId: "01900000-0000-7000-8000-000000000002",
    packageName: "me.sproutos.example",
    label: "Example",
    summary: "An example",
    category: null,
    versionName: "1.0.0",
    versionCode: 1,
    sha256: "a".repeat(64),
    sizeBytes: 1_024,
    signedKey: "signed/p/d.apk",
    signedObjectVersion: "v1",
    certificateSha256: "b".repeat(64),
    iconUrl: null,
    ...overrides,
  }
}

function app(overrides: Partial<AndroidApp> = {}): AndroidApp {
  return {
    androidAppId: "01900000-0000-7000-8000-000000000001",
    projectId: "01900000-0000-7000-8000-000000000002",
    packageName: "me.sproutos.example",
    label: "Example",
    summary: "",
    versionName: "1.0.0",
    versionCode: 1,
    sha256: "a".repeat(64),
    sizeBytes: 1_024,
    certificateSha256: "b".repeat(64),
    downloadUrl: "https://cdn.example/x",
    ...overrides,
  }
}

describe("an entry in the catalogue", () => {
  it("carries a signed URL and a digest the client can check", () => {
    const entry = toApp(row(), signedUrlFor)

    expect(entry?.downloadUrl).toBe("https://cdn.example/signed/p/d.apk?sig=abc")
    expect(entry?.sha256).toHaveLength(64)
  })

  it("carries a public store category without making it required for personal apps", () => {
    expect(toApp(row({ category: "Productivity" }), signedUrlFor)?.category).toBe("Productivity")
    expect(toApp(row({ category: null }), signedUrlFor)).not.toHaveProperty("category")
  })

  it("omits an app that has not been signed yet", () => {
    /*
      An unsigned APK must never appear. Android refuses to install one, so offering it gives the
      customer a download that fails rather than an app that is not ready — and the signing happens
      on a machine we do not operate, so "not yet" is a normal state rather than an error.
    */
    expect(toApp(row({ signedKey: null }), signedUrlFor)).toBeUndefined()
  })

  it("omits an app the client could not verify", () => {
    // An entry with no digest is an entry the client cannot check against what it downloaded.
    expect(toApp(row({ sha256: null }), signedUrlFor)).toBeUndefined()
  })

  it("omits an app with no package name or version", () => {
    // The package name is the client's primary key and what an install replaces; the version code
    // is what Android compares. Neither has a safe default.
    expect(toApp(row({ packageName: null }), signedUrlFor)).toBeUndefined()
    expect(toApp(row({ versionCode: null }), signedUrlFor)).toBeUndefined()
  })
})

describe("one entry per package", () => {
  it("keeps the highest version code, not the newest row", () => {
    /*
      Android refuses to install a lower version code over a higher one, so offering an older build
      is offering an install that fails with a message about the app already being installed.

      Deliberately out of order, because "the last one wins" passes a sorted fixture.
    */
    const chosen = latestPerPackage([
      app({ versionCode: 3, versionName: "1.2.0" }),
      app({ versionCode: 7, versionName: "1.4.0" }),
      app({ versionCode: 5, versionName: "1.3.0" }),
    ])

    expect(chosen).toHaveLength(1)
    expect(chosen[0]?.versionCode).toBe(7)
  })

  it("keeps different packages apart", () => {
    const chosen = latestPerPackage([
      app({ packageName: "me.sproutos.a", label: "Zebra" }),
      app({ packageName: "me.sproutos.b", label: "Apple" }),
    ])

    expect(chosen).toHaveLength(2)
    // Sorted by label, so two requests return the same order and the client need not sort.
    expect(chosen.map((entry) => entry.label)).toEqual(["Apple", "Zebra"])
  })
})

describe("the catalogue", () => {
  it("expires with the URLs inside it", () => {
    const now = new Date("2026-08-24T12:00:00Z")
    const catalogue = buildCatalogue({
      publicApps: [app()],
      personalApps: [],
      personalSites: [],
      now,
    })

    /*
      The two must match. A catalogue cached longer than its URLs is a list of buttons that fail;
      URLs outliving the catalogue are links that survive a revocation.
    */
    const ttl = (Date.parse(catalogue.expiresAt) - Date.parse(catalogue.generatedAt)) / 1000
    expect(ttl).toBe(CATALOGUE_TTL_SECONDS)
  })

  it("has both sections even when one is empty", () => {
    // An unauthenticated reader gets an empty personal half rather than an error: the client's tab
    // should say there is nothing there, not fail to load.
    const catalogue = buildCatalogue({ publicApps: [app()], personalApps: [], personalSites: [] })

    expect(catalogue.public.apps).toHaveLength(1)
    expect(catalogue.personal.apps).toEqual([])
    expect(catalogue.personal.sites).toEqual([])
  })

  it("carries websites in the personal section, sorted", () => {
    const catalogue = buildCatalogue({
      publicApps: [],
      personalApps: [],
      personalSites: [
        { name: "Zebra", url: "https://z.sproutos.me", summary: "" },
        { name: "Apple", url: "https://a.sproutos.me", summary: "" },
      ],
    })

    // Websites live beside apps in the personal tab, which is why this is not F-Droid's format —
    // there is nowhere in their schema for something that is not an APK.
    expect(catalogue.personal.sites.map((site) => site.name)).toEqual(["Apple", "Zebra"])
  })

  it("declares a version an old client can refuse", () => {
    const catalogue = buildCatalogue({ publicApps: [], personalApps: [], personalSites: [] })

    expect(catalogue.version).toBe(2)
    expect(isReadable(catalogue.version)).toBe(true)
    /*
      A newer catalogue read by an older client would be *partially* understood, which is the
      dangerous kind: a section it does not know about looks like an empty one, and a customer
      concludes their apps are gone.
    */
    expect(isReadable(1)).toBe(false)
  })

  it("carries a verified client update without conflating it with a customer app", () => {
    const clientUpdate = toClientUpdate(
      {
        packageName: "com.sproutos.store",
        versionName: "2.0.0",
        versionCode: 20,
        sha256: "c".repeat(64),
        sizeBytes: 2_048,
        certificateSha256: "d".repeat(64),
        objectKey: "client/2.0.0.apk",
        required: false,
      },
      signedUrlFor,
    )
    const catalogue = buildCatalogue({
      publicApps: [],
      personalApps: [],
      personalSites: [],
      clientUpdate,
    })

    expect(catalogue.clientUpdate).toMatchObject({
      packageName: "com.sproutos.store",
      versionCode: 20,
      downloadUrl: "https://cdn.example/client/2.0.0.apk?sig=abc",
    })
    expect(catalogue.public.apps).toEqual([])
  })
})

describe("client updates", () => {
  const base = {
    packageName: "com.sproutos.store",
    versionName: "2.0.0",
    versionCode: 20,
    sha256: "c".repeat(64),
    sizeBytes: 2_048,
    certificateSha256: "d".repeat(64),
    objectKey: "client/2.0.0.apk",
    required: false,
  }

  it("rejects a release with another package or unverifiable metadata", () => {
    expect(toClientUpdate({ ...base, packageName: "me.sproutos.someapp" }, signedUrlFor)).toBe(
      undefined,
    )
    expect(toClientUpdate({ ...base, sha256: "not-a-digest" }, signedUrlFor)).toBeUndefined()
    expect(toClientUpdate({ ...base, certificateSha256: "A".repeat(64) }, signedUrlFor)).toBe(
      undefined,
    )
  })

  it("rejects values Android or JSON cannot represent safely", () => {
    expect(toClientUpdate({ ...base, versionCode: 2_100_000_001 }, signedUrlFor)).toBeUndefined()
    expect(toClientUpdate({ ...base, sizeBytes: Number.MAX_SAFE_INTEGER + 1 }, signedUrlFor)).toBe(
      undefined,
    )
    expect(toClientUpdate({ ...base, versionName: "" }, signedUrlFor)).toBeUndefined()
  })

  it("emits required only when true", () => {
    expect(toClientUpdate(base, signedUrlFor)).not.toHaveProperty("required")
    expect(toClientUpdate({ ...base, required: true }, signedUrlFor)).toMatchObject({
      required: true,
    })
  })
})
