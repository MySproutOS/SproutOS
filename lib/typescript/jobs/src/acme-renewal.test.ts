import { describe, expect, it, vi } from "vitest"
import { certificateProvenance, refreshRenewalSchedule, retryAfterAt } from "./acme-renewal"

// RFC 9773 Appendix A: its leading serial zero is the edge case most high-level X.509 APIs omit.
const RFC_9773_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBQzCB66ADAgECAgUAh2VDITAKBggqhkjOPQQDAjAVMRMwEQYDVQQDEwpFeGFt
cGxlIENBMCIYDzAwMDEwMTAxMDAwMDAwWhgPMDAwMTAxMDEwMDAwMDBaMBYxFDAS
BgNVBAMTC2V4YW1wbGUuY29tMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEeBZu
7cbpAYNXZLbbh8rNIzuOoqOOtmxA1v7cRm//AwyMwWxyHz4zfwmBhcSrf47NUAFf
qzLQ2PPQxdTXREYEnKMjMCEwHwYDVR0jBBgwFoAUaYhba4dGQEHhs3uEe6CuLN4B
yNQwCgYIKoZIzj0EAwIDRwAwRAIge09+S5TZAlw5tgtiVvuERV6cT4mfutXIlwTb
+FYN/8oCIClDsqBklhB9KAelFiYt9+6FDj3z4KGVelYM5MdsO3pK
-----END CERTIFICATE-----`

function response(body: unknown, options: ResponseInit = {}): Response {
  const headers = new Headers(options.headers)
  if (!headers.has("content-type")) headers.set("content-type", "application/json")
  return new Response(JSON.stringify(body), {
    ...options,
    status: options.status ?? 200,
    headers,
  })
}

describe("RFC 9773 renewal information", () => {
  it("constructs the RFC appendix certificate identifier including DER's serial sign byte", () => {
    expect(certificateProvenance(RFC_9773_CERTIFICATE)).toEqual({
      certificateId: "aYhba4dGQEHhs3uEe6CuLN4ByNQ.AIdlQyE",
      issuer: "CN=Example CA",
    })
  })

  it("chooses a deterministic point in the CA window and honors bounded Retry-After", async () => {
    const fetcher = vi
      .fn<(input: string | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(response({ renewalInfo: "https://ca.example/acme/renewal-info/" }))
      .mockResolvedValueOnce(
        response(
          {
            suggestedWindow: {
              start: "2027-01-01T00:00:00Z",
              end: "2027-01-03T00:00:00Z",
            },
            explanationURL: "https://ca.example/incidents/42",
          },
          { headers: { "retry-after": "30" } },
        ),
      )

    const schedule = await refreshRenewalSchedule({
      certificateId: "aki.serial",
      directoryUrl: "https://ca.example/directory",
      expiresAt: new Date("2027-02-15T00:00:00Z"),
      now: new Date("2026-12-01T00:00:00Z"),
      fetch: fetcher,
      random: () => 0.5,
    })

    expect(schedule).toEqual({
      nextRenewalAt: new Date("2027-01-02T00:00:00Z"),
      renewalInfoRetryAt: new Date("2026-12-01T00:01:00Z"),
      renewalInfoExplanationUrl: "https://ca.example/incidents/42",
      source: "ari",
    })
    expect(fetcher.mock.calls[1]?.[0].toString()).toBe(
      "https://ca.example/acme/renewal-info/aki.serial",
    )
  })

  it("never lets an ARI window defer the local safety fallback", async () => {
    const fetcher = vi
      .fn<(input: string | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(response({ renewalInfo: "https://ca.example/ari" }))
      .mockResolvedValueOnce(
        response(
          {
            suggestedWindow: {
              start: "2027-01-20T00:00:00Z",
              end: "2027-01-21T00:00:00Z",
            },
          },
          { headers: { "retry-after": "86400" } },
        ),
      )

    const schedule = await refreshRenewalSchedule({
      certificateId: "aki.serial",
      directoryUrl: "https://ca.example/directory",
      expiresAt: new Date("2027-01-31T00:00:00Z"),
      now: new Date("2026-12-01T00:00:00Z"),
      fetch: fetcher,
      random: () => 0.5,
    })
    expect(schedule.nextRenewalAt).toEqual(new Date("2027-01-01T00:00:00Z"))
  })

  it("falls back and retries ARI in six hours when the response is invalid", async () => {
    const fetcher = vi
      .fn<(input: string | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(response({ renewalInfo: "https://ca.example/ari" }))
      .mockResolvedValueOnce(
        response(
          {
            suggestedWindow: {
              start: "2027-01-03T00:00:00Z",
              end: "2027-01-02T00:00:00Z",
            },
          },
          { headers: { "retry-after": "3600" } },
        ),
      )
    const now = new Date("2026-12-01T00:00:00Z")
    expect(
      await refreshRenewalSchedule({
        certificateId: "aki.serial",
        directoryUrl: "https://ca.example/directory",
        expiresAt: new Date("2027-01-31T00:00:00Z"),
        now,
        fetch: fetcher,
      }),
    ).toEqual({
      nextRenewalAt: new Date("2027-01-01T00:00:00Z"),
      renewalInfoRetryAt: new Date("2026-12-01T06:00:00Z"),
      renewalInfoExplanationUrl: null,
      source: "fallback",
    })
  })

  it("uses the fallback without polling when the directory does not advertise ARI", async () => {
    const fetcher = vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(response({ newOrder: "https://ca.example/order" })),
    )
    const schedule = await refreshRenewalSchedule({
      certificateId: "aki.serial",
      directoryUrl: "https://ca.example/directory",
      expiresAt: new Date("2027-01-31T00:00:00Z"),
      now: new Date("2026-12-01T00:00:00Z"),
      fetch: fetcher,
    })
    expect(schedule.source).toBe("unsupported")
    expect(schedule.renewalInfoRetryAt).toBeNull()
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it("clamps Retry-After intervals to one minute through one day", () => {
    const now = new Date("2026-12-01T00:00:00Z")
    expect(retryAfterAt("0", now)).toEqual(new Date("2026-12-01T00:01:00Z"))
    expect(retryAfterAt("999999999", now)).toEqual(new Date("2026-12-02T00:00:00Z"))
    expect(() => retryAfterAt(null, now)).toThrow("missing")
  })
})
