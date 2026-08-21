import { describe, expect, it } from "vitest"
import {
  configFileKey,
  configSecret,
  environmentDigest,
  environmentSecret,
  environmentSecretName,
  fileMounts,
  isDeliverableKey,
  isMountablePath,
} from "./env"

const project = "01a01e12-1700-76ac-9713-dd208babdf5a"

describe("environmentSecretName", () => {
  it("changes when a value changes", () => {
    /*
      The property the whole design rests on. Knative cuts a new revision when the *pod spec*
      changes, and a Secret referenced by a fixed name is the same pod spec whatever is inside it —
      so a customer would set a value, see it saved, and watch their site go on using the old one
      until something unrelated forced a redeploy.
    */
    const before = environmentSecretName(project, [{ key: "API_URL", value: "one" }])
    const after = environmentSecretName(project, [{ key: "API_URL", value: "two" }])

    expect(after).not.toBe(before)
  })

  it("does not change when the same variables come back in a different order", () => {
    // Otherwise every deploy cuts a revision, because a query without a total order eventually
    // returns rows in a different one.
    expect(
      environmentSecretName(project, [
        { key: "B", value: "2" },
        { key: "A", value: "1" },
      ]),
    ).toBe(
      environmentSecretName(project, [
        { key: "A", value: "1" },
        { key: "B", value: "2" },
      ]),
    )
  })

  it("distinguishes two environments a separator could have merged", () => {
    // `A=1,B=2` under any delimiter is also `A=1,B` plus `=2`. A customer whose value contains the
    // delimiter would otherwise share a Secret with a different environment — and get it.
    expect(environmentDigest([{ key: "A", value: "1,B=2" }])).not.toBe(
      environmentDigest([
        { key: "A", value: "1" },
        { key: "B", value: "2" },
      ]),
    )
  })

  it("is a name Kubernetes accepts", () => {
    // Object names are DNS subdomains: lowercase alphanumerics, `-` and `.`, 253 characters.
    const name = environmentSecretName(project, [{ key: "A", value: "1" }])

    expect(name).toMatch(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/)
    expect(name.length).toBeLessThanOrEqual(253)
  })

  it("gives two projects with identical environments different names", () => {
    // They share a namespace when they share an organization, and one would then read the other's.
    const other = "01a01e12-1700-76ac-9713-dd208bab0000"
    const entries = [{ key: "A", value: "1" }]

    expect(environmentSecretName(project, entries)).not.toBe(environmentSecretName(other, entries))
  })
})

describe("isDeliverableKey", () => {
  it("accepts what a Secret key may contain", () => {
    for (const key of ["DATABASE_URL", "port", "a.b", "a-b", "A1"]) {
      expect(isDeliverableKey(key)).toBe(true)
    }
  })

  it("refuses what the API server would reject the whole object for", () => {
    // And that is the point: one variable named with a space makes *every* variable undeliverable,
    // with a 422 on the Secret several steps from the variable that caused it.
    for (const key of ["has space", "curly{}", "", "a/b", "é"]) {
      expect(isDeliverableKey(key)).toBe(false)
    }
  })
})

describe("environmentSecret", () => {
  it("uses stringData, so nothing here encodes base64 twice", () => {
    const secret = environmentSecret(project, "tenant-x", [{ key: "A", value: "1" }])

    expect(secret.stringData).toEqual({ A: "1" })
    expect(secret).not.toHaveProperty("data")
  })

  it("labels itself with the project, so teardown can find it", () => {
    // The names are content-hashed and a project accumulates them, so the only way to collect a
    // deleted project's Secrets is a label selector.
    const secret = environmentSecret(project, "tenant-x", [{ key: "A", value: "1" }])

    expect(secret.metadata.labels["sproutos.dev/project"]).toBe(project)
  })
})

describe("config files", () => {
  /*
    The half of configuration that did not exist. `glance` — forked, built and pushed by this
    platform — exited with `reading /app/config/glance.yml: no such file or directory`. Most
    self-hostable software is configured by a file and reads nothing from the environment.
  */
  it("does not use the path as the Secret key", () => {
    // A Secret key must match `[-._a-zA-Z0-9]+`, so a path is not a legal key at all.
    expect(configFileKey("/app/config/glance.yml")).toMatch(/^[-._a-zA-Z0-9]+$/)
  })

  it("gives two paths a flattening would have merged different keys", () => {
    // Mapping `/` to any legal character makes `a/b` and `a.b` the same key, and the second file
    // silently overwrites the first. A digest cannot collide by construction.
    expect(configFileKey("/a/b")).not.toBe(configFileKey("/a.b"))
  })

  it("mounts each file with subPath, so the image's own directory survives", () => {
    /*
      Mounting a Secret at a directory *replaces* it — everything the image shipped in
      `/app/config` disappears, which for most projects is the defaults the config was meant to sit
      beside.
    */
    const mounts = fileMounts([{ path: "/app/config/glance.yml", contents: "x" }])

    expect(mounts[0]).toEqual({
      name: "sproutos-config",
      mountPath: "/app/config/glance.yml",
      subPath: configFileKey("/app/config/glance.yml"),
      readOnly: true,
    })
  })

  it("mounts read-only", () => {
    // A writable mount would let an application persist changes that vanish on the next revision,
    // which is worse than not being able to write because it looks like it worked.
    expect(fileMounts([{ path: "/a/b.yml", contents: "x" }])[0]?.readOnly).toBe(true)
  })

  it("changes the Secret name when a file's contents change", () => {
    // Same reason as a variable: otherwise the pod spec is unchanged, Knative cuts no revision, and
    // the running container keeps the old config.
    const before = configSecret("p", "ns", [], [{ path: "/a.yml", contents: "one" }])
    const after = configSecret("p", "ns", [], [{ path: "/a.yml", contents: "two" }])

    expect(after.metadata.name).not.toBe(before.metadata.name)
  })

  it("changes the name when the same contents move to a different path", () => {
    // Two files with identical contents at different paths are different configurations.
    const here = configSecret("p", "ns", [], [{ path: "/a.yml", contents: "x" }])
    const there = configSecret("p", "ns", [], [{ path: "/b.yml", contents: "x" }])

    expect(there.metadata.name).not.toBe(here.metadata.name)
  })

  it("carries variables and files in one Secret", () => {
    // One thing — the configuration this revision ran with. Two objects would mean two names, two
    // hashes, and a revision that could be pinned to half a configuration.
    const secret = configSecret(
      "p",
      "ns",
      [{ key: "PORT", value: "8080" }],
      [{ path: "/a.yml", contents: "x" }],
    )

    expect(secret.stringData.PORT).toBe("8080")
    expect(secret.stringData[configFileKey("/a.yml")]).toBe("x")
  })

  it("agrees with environmentSecret when there are no files", () => {
    // `environmentSecret` calls through, so a revision's name does not change just because files
    // became possible.
    const entries = [{ key: "A", value: "1" }]

    expect(environmentSecret("p", "ns", entries)).toEqual(configSecret("p", "ns", entries, []))
  })
})

describe("isMountablePath", () => {
  it("accepts an absolute path with a filename", () => {
    expect(isMountablePath("/app/config/glance.yml")).toBe(true)
  })

  it("refuses what the kubelet would refuse at mount time", () => {
    // A relative path has no anchor inside the container, and a `subPath` containing `..` fails the
    // pod with a message about the volume rather than about the file.
    for (const path of ["app/config.yml", "/app/../etc/passwd", "/app/", "/", ""]) {
      expect(isMountablePath(path)).toBe(false)
    }
  })
})
