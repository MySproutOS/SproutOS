# sproutos-s3-sigv4

AWS Signature Version 4, from the verifying end.

Every SigV4 library is written for a client: give it a request and a credential and it produces an
`Authorization` header. `services/storage-proxy` needs the opposite — given a request and a header
somebody else produced, decide whether it is the one that credential would have made. That is the
same arithmetic run backwards, and no crate exposes it, so this one does.

Checked against AWS's own published vectors: the documented `20150830/us-east-1/iam` signing-key
derivation, and the `get-vanilla` worked example from the SigV4 test suite. Those two catch the
mistakes that otherwise show up as "SignatureDoesNotMatch" with nothing to point at.

## What is here

|                                         |                                                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `parse_authorization`                   | An `Authorization: AWS4-HMAC-SHA256 …` header, strictly about its parts and lenient about the whitespace between them |
| `CanonicalRequest`                      | The six-line form, assembled rather than guessed at                                                                   |
| `string_to_sign`, `signing_key`, `sign` | The four nested HMACs                                                                                                 |
| `verify`                                | Constant-time, because the comparison is against a value an attacker chooses a byte at a time                         |
| `uri_encode`, `canonical_query`         | SigV4's encoding, which is not form encoding — uppercase hex, `%20` and never `+`                                     |
| `tenant`                                | Deriving a tenant's credential from the platform root key                                                             |

## Two details worth knowing before touching it

**Encoding.** `url::form_urlencoded` produces `+` for a space. SigV4 requires `%20`. A canonical
request that differs from the client's by one byte is a signature mismatch with nothing to point at,
and this is the usual cause.

**The payload hash is a commitment, not a copy.** The canonical request names a digest, so a proxy
that forwards a client's `x-amz-content-sha256` unchecked will happily carry a body nobody signed.
The proxy compares it with what arrived; `UNSIGNED-PAYLOAD` is the browser's escape hatch and is
passed through as the literal it is.

## `tenant`

Why a tenant secret is derived rather than stored is argued in `src/tenant.rs` and in
`services/storage-proxy/README.md`. The short version: the proxy must be able to obtain every
tenant's secret whatever it does — SigV4 gives it no choice — so the only question left is whether a
_database_ leak is also worth something, and derivation makes the answer no.

`fixtures/tenant-secret.json` is the contract; `lib/typescript/services/src/tenant-auth.test.ts`
asserts against the same file. A divergence is a tenant who cannot authenticate at all, which is
loud — unlike the SRN seam next door, where a divergence is a security bug.
