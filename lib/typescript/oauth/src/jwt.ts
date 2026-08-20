import { decodeBase64UrlToBytes } from "@utils/crypto"
import { OAuth2ResponseError } from "./errors"

/** Decode a JWT's payload **without verifying its signature**.
 *
 *  This is only sound for a token we received ourselves, over TLS, directly from the provider's
 *  token endpoint in exchange for an authorization code — the transport is what authenticates it.
 *  It is NOT sound for a token handed to us by a browser, an API caller, or any other third
 *  party; verifying the signature against the provider's JWKS is required there.
 *
 *  We only ever read ID tokens straight out of a token response, so signature verification would
 *  add a JWKS fetch and key-rotation handling to buy nothing. This is the same reasoning arctic
 *  documented for its own `decodeIdToken`. */
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".")
  if (parts.length !== 3) {
    throw new OAuth2ResponseError("Malformed JWT: expected three dot-separated segments")
  }

  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(decodeBase64UrlToBytes(parts[1])))
  } catch (cause) {
    throw new OAuth2ResponseError("Malformed JWT: payload is not base64url-encoded JSON", null, {
      cause,
    })
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new OAuth2ResponseError("Malformed JWT: payload is not a JSON object")
  }
  return payload as Record<string, unknown>
}
