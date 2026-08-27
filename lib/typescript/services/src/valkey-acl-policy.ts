import { createHash, createHmac } from "node:crypto"
import { encodeShortId, tenantUsername } from "./tenant-auth"
import policy from "./valkey-acl-policy.json"

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"

export type ValkeyAclIdentity = { id: string; organizationId: string }

export function valkeyAclUsername(identity: ValkeyAclIdentity): string {
  return tenantUsername({
    organizationId: identity.organizationId,
    kind: "queue",
    resourceId: identity.id,
  })
}

export function valkeyAclSetUserArgs(identity: ValkeyAclIdentity, rootKey: string): string[] {
  const username = valkeyAclUsername(identity)
  const password = encode(createHmac("sha256", rootKey).update(username).digest())
  const prefix = `{kv:${encodeShortId(identity.id)}}:`
  return [
    username,
    "reset",
    "on",
    `>${password}`,
    `~${prefix}*`,
    `&${prefix}*`,
    ...policy.forwardedCommands.map((command) => `+${command}`),
    ...policy.deniedCommands.map((command) => `-${command}`),
  ]
}

export function expectedValkeyAclTokens(identity: ValkeyAclIdentity, rootKey: string): Set<string> {
  const args = valkeyAclSetUserArgs(identity, rootKey)
  const password = args.find((arg) => arg.startsWith(">"))?.slice(1)
  if (password === undefined) throw new Error("Valkey ACL policy has no password")
  return new Set(
    [
      "on",
      "sanitize-payload",
      "-@all",
      `#${createHash("sha256").update(password).digest("hex")}`,
      "resetchannels",
      ...args.slice(3).filter((arg) => !arg.startsWith(">")),
    ].map((token) => token.toLowerCase()),
  )
}

function encode(bytes: Uint8Array): string {
  let out = ""
  let accumulator = 0
  let bits = 0
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += ALPHABET[(accumulator >> bits) & 0x1f]
    }
  }
  if (bits > 0) out += ALPHABET[(accumulator << (5 - bits)) & 0x1f]
  return out
}

export { policy as VALKEY_ACL_POLICY }
