# @lib/envelope

Envelope encryption for every secret SproutOS stores at rest: GitHub tokens, agent API keys,
database connection strings, OAuth client secrets, webhook signing keys.

## Why this package exists

Four separate envelope-encryption designs appeared independently during planning — four column
conventions (`access_token_ct`/`data_key_ct`, `ciphertext`/`wrapped_dek`,
`password_ciphertext`/`kms_key_id`, `private_key_ciphertext`), four call sites, four sets of bugs.
This is the only one. A reader who opens any table with a secret in it sees the same three columns
and knows exactly what they are looking at.

## The column convention

Every encrypted field is three columns:

| Column                | Holds                                                            |
| --------------------- | ---------------------------------------------------------------- |
| `{field}_ciphertext`  | `text` — base64 of `IV ‖ ciphertext ‖ auth tag`                  |
| `{field}_wrapped_dek` | `text` — base64 of the data key, encrypted under the CMK         |
| `{field}_kms_key_id`  | `text` — which CMK wrapped it, so rotation knows what to re-wrap |

Nothing else. No plaintext column "just for development", no nullable shadow copy.

## How it works

`seal()` asks KMS for a fresh single-use data key, encrypts locally with AES-256-GCM, and stores
the wrapped key beside the ciphertext. **KMS never sees the plaintext** — it only ever handles the
32-byte data key. One KMS call per secret, and the value itself never leaves the process.

```ts
import { open, seal } from "@lib/envelope"

const sealed = await seal(accessToken, {
  organizationId: org.id,
  field: "github_access_token",
})
// -> { ciphertext, wrappedDek, kmsKeyId }

const accessToken = await open(sealed, {
  organizationId: org.id,
  field: "github_access_token",
})
```

## Always pass an encryption context

The context is authenticated twice — once by KMS, once as the GCM additional data — and it is what
stops a ciphertext being lifted out of one row and pasted into another. Sealing with
`{ organizationId: "org-a" }` and opening with `{ organizationId: "org-b" }` fails outright rather
than quietly succeeding.

Pass at least the owning row's id and the field name. It costs nothing and it is the difference
between "an attacker with write access to one row can read another org's token" and "they cannot".

Context keys are sorted before serialization, so callers building the same logical context in
different orders agree. ASCII unit and record separators are rejected in keys and values, which is
what makes that serialization unambiguous.

## Failures are deliberately indistinguishable

Wrong key, tampered ciphertext, mismatched context, truncated input — every one raises
`DecryptionFailedError` with the same message. Telling a caller _which_ of those went wrong also
tells an attacker, and turns the decrypt path into an oracle.

## Development

There is no local crypto shim and no `KMS_PROVIDER=local` branch. LocalStack carries KMS on its free
plan, so `docker compose up -d` plus `bin/bootstrap-localstack.sh` gives you a real CMK at
`alias/sproutos-dev`, and the identical code path runs in development and production. A passing test
here means the production path works — which would not be true of a fake.

The client is gated on `AWS_ENDPOINT_URL`, the AWS SDK's own standard variable: set, it points at
LocalStack; unset, the SDK resolves real AWS. The application never branches on environment.

LocalStack's free plan does not persist state, so re-run `bin/bootstrap-localstack.sh` after a
restart or `KMS_KEY_ID` will point at a key that no longer exists.

## Environment

| Variable           | Purpose                                                            |
| ------------------ | ------------------------------------------------------------------ |
| `KMS_KEY_ID`       | CMK id or alias. `alias/sproutos-dev` locally                      |
| `AWS_ENDPOINT_URL` | Set to `http://localhost:4566` for LocalStack; unset in production |
| `AWS_REGION`       | Defaults to `us-east-1`                                            |

## Key rotation

`kmsKeyId` is stored per row precisely so rotation is possible: re-wrapping means reading each row,
calling `open()` with the old key and `seal()` with the new one, and writing all three columns back.
Nothing else needs to change, because no other code knows how a secret is encoded.
